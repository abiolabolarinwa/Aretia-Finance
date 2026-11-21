/**
 * New Solana pools, heard as they are created instead of looked for.
 *
 * Solana nodes can push: a websocket `logsSubscribe` on a program sends the log lines of each transaction that uses it, about a second
 * after it lands. A pool's creation says so in its log ("Instruction: InitializeLbPair", "InitializePool", "CreatePool", ...), so the
 * listener keeps only those transactions, reads each one once, finds the new pool account among the accounts the transaction touched
 * (the one the venue's program owns, with the venue's pool size), and registers it through the same path as every other discovery.
 * Nothing is polled and nothing is scanned: no node call is made for the swaps that make up almost all of a busy program's traffic.
 *
 * What it needs: a node that accepts websocket subscriptions (MI_SOLANA_WS_URL; the public node does, with limits). The stream of a very
 * busy program is large, so the listener counts bytes and, above `maxBytesPerMinute`, closes the socket and rests for a while rather than
 * silently running up a metered bill. It reconnects with a growing wait. A quiet program sends nothing for long stretches and the public node
 * closes a socket it hears nothing from (the first live run reconnected every 20 to 60 seconds, each gap able to miss a creation), so the listener
 * sends a harmless request every 25 seconds to keep the line open. A creation heard while it was down is not replayed: the venues
 * with a known creation-only account (Raydium CPMM, Orca, PumpSwap, Raydium AMM v4) still catch up through their usual runs, and the
 * program-wide listing (MI_SOLANA_DISCOVERY) finds the rest.
 *
 * Not verified against a live node when this was written: the log wording is from the programs' published instruction names, and the
 * tests drive it with a scripted socket and node. The first live run's log line (heard, registered) is the check.
 */
import type { CreatedPool } from '../../indexer/solanaIndexer.js';
import type { RunReport } from '../engine.js';
import { SOLANA_SPECS } from '../dexes.js';
import { RpcError, type Read } from '../rpc.js';
import { fromBase64, isSolanaAddress } from './accounts.js';
import { VENUE_LAYOUTS } from './discovery.js';
import { readTx, registerPool, type SolDeps, type TokenFacts } from './engine.js';
import { PROGRAMS } from './track.js';

/** The log line of an instruction that makes a pool. Anything else the program logs is ignored. */
export const CREATION_LOG = /Instruction: (?:Initialize\w*(?:Pool|LbPair)\w*|CreatePool)\b/;

/** Venues the listener can hear: a program with a known pool layout. */
export function listenableVenues(value: string | undefined): string[] {
  const raw = (value ?? '').trim().toLowerCase();
  if (raw === '' || raw === '0' || raw === 'off') return [];
  const all = SOLANA_SPECS.filter((s) => s.id in VENUE_LAYOUTS).map((s) => s.id);
  if (raw === '*' || raw === '1' || raw === 'all' || raw === 'on') return all;
  return raw.split(/[\s,;]+/).filter((id) => all.includes(id));
}

export interface Heard {
  signature: string;
  adapterId: string;
}

/** The minimal websocket the listener uses (the platform's `WebSocket` satisfies it). */
export interface Socket {
  send(data: string): void;
  close(): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export interface ListenerOptions {
  url: string;
  /** Adapter ids to listen for (see listenableVenues). */
  venues: readonly string[];
  onHeard: (h: Heard) => void;
  open?: (url: string) => Socket;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  log?: (line: string) => void;
  /** Bytes a minute above which the socket is closed and left alone for `restMs` (default 4 MB, 10 minutes). */
  maxBytesPerMinute?: number;
  restMs?: number;
  /** How often a keepalive request is sent while connected (default 25 seconds; the public node drops a socket idle for about a minute). */
  keepAliveMs?: number;
}

export interface ListenerStats {
  connected: boolean;
  connects: number;
  messages: number;
  bytes: number;
  heard: number;
  tripped: number;
}

export interface Listener {
  stats: ListenerStats;
  close(): void;
}

export function startListener(o: ListenerOptions): Listener {
  const now = o.now ?? Date.now;
  const open = o.open ?? ((u: string) => new WebSocket(u) as unknown as Socket);
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const maxBytes = o.maxBytesPerMinute ?? 4_000_000;
  const restMs = o.restMs ?? 600_000;
  const keepAliveMs = o.keepAliveMs ?? 25_000;
  const stats: ListenerStats = { connected: false, connects: 0, messages: 0, bytes: 0, heard: 0, tripped: 0 };
  const programs = o.venues.flatMap((id) => {
    const s = SOLANA_SPECS.find((x) => x.id === id);
    return s ? [{ id, program: s.program }] : [];
  });
  /** Subscription request id to the venue it asked for; the confirmation gives the subscription id, which the notifications carry. */
  const byRequest = new Map<number, string>();
  const bySub = new Map<number, string>();
  const seen = new Set<string>();
  let socket: Socket | null = null;
  let timer: unknown = null;
  let closed = false;
  let alive: unknown = null;
  let attempt = 0;
  let windowStart = now();
  let windowBytes = 0;

  const stopAlive = (): void => {
    if (alive !== null) clearTimer(alive);
    alive = null;
  };
  /** An unsubscribe for a subscription that does not exist: the node answers with an error, and the traffic keeps the socket from being called idle. */
  const startAlive = (s: Socket): void => {
    const tick = (): void => {
      if (closed || socket !== s || alive === null) return;
      try {
        s.send(JSON.stringify({ jsonrpc: '2.0', id: 9_999, method: 'logsUnsubscribe', params: [0] }));
      } catch {
        /* the socket is closing; its close handler reconnects */
      }
      alive = setTimer(tick, keepAliveMs);
    };
    stopAlive();
    alive = setTimer(tick, keepAliveMs);
  };

  const schedule = (ms: number): void => {
    if (closed) return;
    timer = setTimer(connect, ms);
  };

  function connect(): void {
    if (closed || programs.length === 0) return;
    byRequest.clear();
    bySub.clear();
    let s: Socket;
    try {
      s = open(o.url);
    } catch {
      attempt++;
      schedule(Math.min(60_000, 1_000 * 2 ** attempt));
      return;
    }
    socket = s;
    s.onopen = () => {
      stats.connected = true;
      stats.connects++;
      attempt = 0;
      startAlive(s);
      programs.forEach((p, i) => {
        byRequest.set(i + 1, p.id);
        s.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'logsSubscribe', params: [{ mentions: [p.program] }, { commitment: 'confirmed' }] }));
      });
      o.log?.(`creation listener connected, listening to ${programs.length} program(s)`);
    };
    s.onmessage = (e) => {
      const text = typeof e.data === 'string' ? e.data : String(e.data);
      stats.messages++;
      stats.bytes += text.length;
      const t = now();
      if (t - windowStart >= 60_000) {
        windowStart = t;
        windowBytes = 0;
      }
      windowBytes += text.length;
      if (windowBytes > maxBytes) {
        stats.tripped++;
        o.log?.(`creation listener: ${(windowBytes / 1e6).toFixed(1)} MB in ${Math.max(1, Math.round((t - windowStart) / 1000))} s is over the limit of ${(maxBytes / 1e6).toFixed(0)} MB a minute (MI_SOLANA_LISTEN_MAX_MB); closing for ${Math.round(restMs / 60_000)} minutes`);
        try {
          s.onclose = null;
          stopAlive();
          s.close();
        } catch {
          /* already closed */
        }
        stats.connected = false;
        windowBytes = 0;
        schedule(restMs);
        return;
      }
      let msg: { id?: number; result?: unknown; method?: string; params?: { subscription?: number; result?: { value?: { signature?: string; err?: unknown; logs?: unknown } } } };
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (typeof msg.id === 'number' && typeof msg.result === 'number') {
        const venue = byRequest.get(msg.id);
        if (venue) bySub.set(msg.result, venue);
        return;
      }
      if (msg.method !== 'logsNotification') return;
      const venue = typeof msg.params?.subscription === 'number' ? bySub.get(msg.params.subscription) : undefined;
      const v = msg.params?.result?.value;
      if (!venue || !v || typeof v.signature !== 'string' || (v.err !== null && v.err !== undefined) || !Array.isArray(v.logs)) return;
      if (!v.logs.some((l) => typeof l === 'string' && CREATION_LOG.test(l))) return;
      if (seen.has(v.signature)) return;
      seen.add(v.signature);
      if (seen.size > 5_000) seen.delete(seen.values().next().value as string);
      stats.heard++;
      o.onHeard({ signature: v.signature, adapterId: venue });
    };
    const lost = (): void => {
      if (socket !== s) return;
      stopAlive();
      stats.connected = false;
      attempt++;
      schedule(Math.min(60_000, 1_000 * 2 ** attempt));
    };
    s.onclose = lost;
    s.onerror = () => undefined;
  }

  connect();
  return {
    stats,
    close() {
      closed = true;
      stopAlive();
      if (timer !== null) clearTimer(timer);
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
    },
  };
}

interface RawAccount {
  owner: string;
  data: [string, string];
}

/** getMultipleAccounts that keeps each account's owner (the other helper returns the data alone). */
export async function accountsWithOwner(rpc: Read, keys: readonly string[]): Promise<Map<string, { owner: string; data: Uint8Array }>> {
  const out = new Map<string, { owner: string; data: Uint8Array }>();
  for (let i = 0; i < keys.length; i += 100) {
    const slice = keys.slice(i, i + 100);
    const r = (await rpc('getMultipleAccounts', [slice, { encoding: 'base64', commitment: 'confirmed' }])) as { value?: (RawAccount | null)[] };
    if (!Array.isArray(r?.value)) throw new RpcError('malformed getMultipleAccounts answer', 'node-error');
    slice.forEach((k, j) => {
      const v = r.value![j];
      if (v) out.set(k, { owner: v.owner, data: fromBase64(v.data[0]) });
    });
  }
  return out;
}

export interface RegisterOutcome {
  /** Pools found in the transaction and registered (or already known). */
  pools: number;
  /** The transaction was not available yet: try again shortly. */
  retry: boolean;
}

/** Reads one creation transaction, finds the pool account it made, and registers it. Never throws on a transaction that made no pool. */
export async function registerHeard(d: Omit<SolDeps, 'spec'>, h: Heard, cache: Map<string, TokenFacts | null>, report: RunReport): Promise<RegisterOutcome> {
  const spec = SOLANA_SPECS.find((s) => s.id === h.adapterId);
  const layout = VENUE_LAYOUTS[h.adapterId];
  const program = spec ? PROGRAMS[spec.program] : undefined;
  if (!spec || !layout || !program) return { pools: 0, retry: false };
  const tx = await readTx(d.rpc, h.signature, 'confirmed');
  if (!tx) return { pools: 0, retry: true };
  const raw = tx.transaction?.message?.accountKeys ?? [];
  const keys = [...new Set(raw.map((k) => (typeof k === 'string' ? k : (k.pubkey ?? ''))).filter((k) => isSolanaAddress(k) && k !== spec.program))];
  if (keys.length === 0) return { pools: 0, retry: false };
  const got = await accountsWithOwner(d.rpc, keys);
  const deps: SolDeps = { ...d, spec };
  let pools = 0;
  for (const [address, acct] of got) {
    if (acct.owner !== spec.program || acct.data.length !== layout.dataSize) continue;
    const parsed = await program.parse(acct.data, d.rpc);
    if (!parsed || ![parsed.mintA, parsed.mintB, parsed.vaultA, parsed.vaultB].every(isSolanaAddress) || parsed.mintA === parsed.mintB) continue;
    const created: CreatedPool = { venue: program.venue, pool: address, ...parsed, blockTime: Math.floor(d.now() / 1000), signature: h.signature };
    await registerPool(deps, created, tx.slot ?? 0, cache, report);
    pools++;
  }
  return { pools, retry: false };
}
