/**
 * Discovery of EXISTING Solana pools. The live adapters find pools as they are created (or, for venues with no creation-only account,
 * when someone opens them); this lists the pools a venue's program already owns, keeps the ones that hold real liquidity, and registers
 * them through the same path as the live adapters, so the index can hold thousands of pools rather than only the newest.
 *
 * How: `getProgramAccounts` with a size filter and one of the pool's two mint positions set to a recognised quote token (SOL, USDC,
 * USDT) returns only pubkeys (a zero-length data slice), a few slices per venue instead of the program's whole pool list. The pubkeys are
 * sorted and processed 100 at a time: the pool accounts are read with `getMultipleAccounts`, parsed with the venue's own layout (the same
 * parsers as adding a pool on request, track.ts), the two token accounts' balances give the liquidity in dollars, and a pool at or above
 * the listing floor is registered. Progress is a cursor (the last pubkey processed) kept per slice, so a restart resumes.
 *
 * What it will not do: guess. A node that refuses `getProgramAccounts` (public Solana nodes do for big programs) stops the run with the
 * node's own words, remembered for a few hours so it is not asked again at once. A pool whose quote token has no known dollar price, or
 * whose liquidity is under the floor, is not registered. Discovered pools have no known creation time (shown as unknown) and no
 * stored trades until the live adapter follows them.
 *
 * Switched on with MI_SOLANA_DISCOVERY (see worker/tasks.ts); off by default.
 */
import type { CreatedPool } from '../../indexer/solanaIndexer.js';
import type { RunReport } from '../engine.js';
import { SOLANA_SPECS } from '../dexes.js';
import { RpcError, type Read } from '../rpc.js';
import { poolKeyOf } from '../types.js';
import { isSolanaAddress, tokenAmount } from './accounts.js';
import { accounts, registerPool, type SolDeps, type TokenFacts } from './engine.js';
import { PROGRAMS } from './track.js';

/**
 * Each venue's pool account size and where its two mints sit. Sizes come from the parsers in accounts.ts; the three busiest were read back
 * from real mainnet accounts when this was written (Raydium CPMM 637 bytes, Orca Whirlpool 653, PumpSwap 301). A pool account the
 * parser does not accept is skipped, so a wrong size can only find nothing, never register a wrong pool. The Dynamic Bonding Curve pool
 * does not hold its quote mint (its config account does), so it is listed whole.
 */
export const VENUE_LAYOUTS: Readonly<Record<string, { dataSize: number; mintOffsets: readonly [number, number] | null }>> = {
  'raydium-cpmm-solana': { dataSize: 637, mintOffsets: [168, 200] },
  'orca-whirlpool-solana': { dataSize: 653, mintOffsets: [101, 181] },
  'pumpswap-solana': { dataSize: 301, mintOffsets: [43, 75] },
  'raydium-amm-v4-solana': { dataSize: 752, mintOffsets: [400, 432] },
  'raydium-clmm-solana': { dataSize: 1544, mintOffsets: [73, 105] },
  'meteora-dlmm-solana': { dataSize: 904, mintOffsets: [88, 120] },
  'meteora-damm-v2-solana': { dataSize: 1112, mintOffsets: [168, 200] },
  'meteora-dbc-solana': { dataSize: 424, mintOffsets: null },
};

/** The venues named by MI_SOLANA_DISCOVERY: `*` or `1` for all, otherwise a comma list of adapter ids. Unknown names are ignored. */
export function discoveryAdapters(value: string | undefined): string[] {
  const raw = (value ?? '').trim().toLowerCase();
  if (raw === '' || raw === '0' || raw === 'off') return [];
  if (raw === '*' || raw === '1' || raw === 'all' || raw === 'on') return Object.keys(VENUE_LAYOUTS);
  return raw.split(/[\s,;]+/).filter((id) => id in VENUE_LAYOUTS);
}

export interface Slice {
  id: string;
  adapterId: string;
  program: string;
  filters: object[];
}

/** One slice per (quote mint, mint position) of a venue, or one whole slice when the pool account does not hold its quote mint. */
export function slicesFor(adapterId: string, quoteMints: readonly string[]): Slice[] {
  const layout = VENUE_LAYOUTS[adapterId];
  const spec = SOLANA_SPECS.find((s) => s.id === adapterId);
  if (!layout || !spec) return [];
  const base = [{ dataSize: layout.dataSize }];
  if (!layout.mintOffsets) return [{ id: `${adapterId}:discover:all`, adapterId, program: spec.program, filters: base }];
  const out: Slice[] = [];
  for (const mint of quoteMints) for (const offset of layout.mintOffsets) out.push({ id: `${adapterId}:discover:${offset}:${mint.slice(0, 6)}`, adapterId, program: spec.program, filters: [...base, { memcmp: { offset, bytes: mint } }] });
  return out;
}

export interface DiscoveryDeps extends Omit<SolDeps, 'spec'> {
  /** Listing floor in dollars (default: the rules' minimum). */
  floorUsd?: number;
  /** A finished slice is walked again after this long, to pick up pools created since (default 24 hours). */
  everyMs?: number;
  /** A node that refused the listing is not asked again for this long (default 6 hours). */
  retryMs?: number;
  /** Most pubkeys held for one slice; a longer list is cut (and reported). Default 400,000. */
  maxList?: number;
  /** Pool accounts examined per step (default 100, at most 100). */
  batch?: number;
}

export interface DiscoveryReport {
  adapterId: string;
  ok: boolean;
  /** True when every slice is finished (so the task can idle until the next pass). */
  complete: boolean;
  slices: number;
  listed: number;
  scanned: number;
  known: number;
  unparsed: number;
  unquoted: number;
  belowFloor: number;
  registered: number;
  truncated: boolean;
  /** The node's own words when it refused the listing. */
  refused: string | null;
  error: string | null;
  durationMs: number;
}

const DONE = 'done';
const REFUSED = 'refused';

/** The pubkeys of the pool accounts matching a slice, sorted. Throws `RpcError` when the node refuses or fails. */
export async function listSlice(rpc: Read, s: Slice): Promise<string[]> {
  const r = (await rpc('getProgramAccounts', [s.program, { encoding: 'base64', commitment: 'finalized', dataSlice: { offset: 0, length: 0 }, filters: s.filters }])) as unknown;
  if (!Array.isArray(r)) throw new RpcError('malformed getProgramAccounts answer', 'node-error');
  const out: string[] = [];
  for (const x of r) {
    const k = typeof x === 'string' ? x : (x as { pubkey?: unknown } | null)?.pubkey;
    if (isSolanaAddress(k)) out.push(k);
  }
  return out.sort();
}

// One slice's list is kept between runs (a list can be hundreds of thousands of pubkeys, so only one is held).
let held: { id: string; at: number; list: string[]; truncated: boolean } | null = null;
const HOLD_MS = 6 * 3_600_000;
export const resetDiscoveryMemory = (): void => {
  held = null;
};

const firstAfter = (list: readonly string[], cursor: string): number => {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! <= cursor) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/** Walks one venue's slices within the time budget. */
export async function discoverVenue(d: DiscoveryDeps, adapterId: string, budgetMs: number): Promise<DiscoveryReport> {
  const t0 = d.now();
  const spec = SOLANA_SPECS.find((s) => s.id === adapterId);
  const r: DiscoveryReport = { adapterId, ok: true, complete: false, slices: 0, listed: 0, scanned: 0, known: 0, unparsed: 0, unquoted: 0, belowFloor: 0, registered: 0, truncated: false, refused: null, error: null, durationMs: 0 };
  const finish = (): DiscoveryReport => ({ ...r, durationMs: d.now() - t0 });
  const program = spec ? PROGRAMS[spec.program] : undefined;
  if (!spec || !program || !VENUE_LAYOUTS[adapterId]) {
    r.ok = false;
    r.error = 'not a venue this can discover';
    return finish();
  }
  const deps: SolDeps = { ...d, spec };
  const floor = d.floorUsd ?? d.rules.minLiquidityUsd;
  const everyMs = d.everyMs ?? 24 * 3_600_000;
  const retryMs = d.retryMs ?? 6 * 3_600_000;
  const deadline = t0 + budgetMs;
  const slices = slicesFor(adapterId, d.chain.quoteTokens.map((q) => q.address));
  r.slices = slices.length;
  const tokenCache = new Map<string, TokenFacts | null>();
  let pending = 0;
  const refusalKey = `${adapterId}:discover:refused`;

  try {
    // A node that refused the listing refuses every slice of the venue: one remembered refusal covers them all.
    const refusal = await d.store.getCheckpoint(refusalKey);
    if (refusal && d.now() - refusal.updatedAt < retryMs) {
      r.refused = 'the node refused this listing earlier; not asked again yet';
      r.complete = true;
      return finish();
    }
    for (const s of slices) {
      if (d.now() >= deadline) {
        pending++;
        continue;
      }
      const cp = await d.store.getCheckpoint(s.id);
      const now = d.now();
      if (cp?.blockHash === DONE && now - cp.updatedAt < everyMs) continue;
      const cursor = cp && cp.blockHash !== DONE ? cp.blockHash : '';
      let list: string[];
      if (held && held.id === s.id && now - held.at < HOLD_MS) {
        list = held.list;
        r.truncated ||= held.truncated;
      } else {
        try {
          list = await listSlice(d.rpc, s);
        } catch (e) {
          if (!(e instanceof RpcError)) throw e;
          // The node's own answer is kept (shortened); the listing is not tried again before the retry period.
          await d.store.setCheckpoint({ adapterId: refusalKey, block: 0, blockHash: REFUSED, updatedAt: now });
          r.ok = false;
          r.refused = e.message.slice(0, 200);
          r.error = `refused: ${r.refused}`;
          return finish();
        }
        const max = d.maxList ?? 400_000;
        const truncated = list.length > max;
        if (truncated) list = list.slice(0, max);
        held = { id: s.id, at: now, list, truncated };
        r.truncated ||= truncated;
      }
      r.listed += list.length;
      let at = firstAfter(list, cursor);
      const size = Math.max(1, Math.min(100, d.batch ?? 100));
      while (at < list.length && d.now() < deadline) {
        const batch = list.slice(at, at + size);
        await processBatch(deps, program.parse, program.venue, batch, floor, tokenCache, r);
        at += batch.length;
        await d.store.setCheckpoint({ adapterId: s.id, block: at, blockHash: list[at - 1]!, updatedAt: d.now() });
      }
      if (at >= list.length) await d.store.setCheckpoint({ adapterId: s.id, block: list.length, blockHash: DONE, updatedAt: d.now() });
      else pending++;
    }
    r.complete = pending === 0;
  } catch (e) {
    r.ok = false;
    r.error = (e instanceof RpcError ? `${e.kind}: ${e.message}` : e instanceof Error ? e.message : 'discovery failed').slice(0, 300);
  }
  return finish();
}

const REPORT = (id: string): RunReport => ({ adapterId: id, ok: true, skipped: null, head: null, safeHead: null, fromBlock: null, toBlock: null, lagBlocks: null, creations: 0, poolsNew: 0, tokensNew: 0, swapsSeen: 0, tradesNew: 0, skippedLogs: 0, reorg: null, error: null, durationMs: 0 });

async function processBatch(d: SolDeps, parse: (data: Uint8Array, rpc: Read) => ReturnType<(typeof PROGRAMS)[string]['parse']>, venue: CreatedPool['venue'], batch: readonly string[], floor: number, tokenCache: Map<string, TokenFacts | null>, r: DiscoveryReport): Promise<void> {
  r.scanned += batch.length;
  const known = await d.store.getPools(batch.map((a) => poolKeyOf('solana', a)));
  const fresh = batch.filter((a) => !known.has(poolKeyOf('solana', a)));
  r.known += batch.length - fresh.length;
  if (fresh.length === 0) return;
  const data = await accounts(d.rpc, fresh);
  const parsed: { pool: string; mintA: string; mintB: string; vaultA: string; vaultB: string }[] = [];
  for (const pool of fresh) {
    const bytes = data.get(pool);
    const p = bytes ? await parse(bytes, d.rpc) : null;
    if (!p || ![p.mintA, p.mintB, p.vaultA, p.vaultB].every(isSolanaAddress) || p.mintA === p.mintB) r.unparsed++;
    else parsed.push({ pool, ...p });
  }
  if (parsed.length === 0) return;
  const balances = await accounts(d.rpc, parsed.flatMap((p) => [p.vaultA, p.vaultB]));
  const amount = (a: string): bigint | null => {
    const b = balances.get(a);
    return b ? tokenAmount(b) : null;
  };
  const quotes = d.chain.quoteTokens;
  let nativeUsd: number | null | undefined;
  for (const p of parsed) {
    const qA = quotes.find((q) => q.address === p.mintA);
    const qB = quotes.find((q) => q.address === p.mintB);
    if (!qA && !qB) {
      r.unquoted++;
      continue;
    }
    const quoteIsB = qA && qB ? qB.role === 'usd' || qA.role !== 'usd' : !qA;
    const quote = (quoteIsB ? qB : qA)!;
    const quoteAmount = amount(quoteIsB ? p.vaultB : p.vaultA);
    const baseAmount = amount(quoteIsB ? p.vaultA : p.vaultB);
    if (quoteAmount === null || baseAmount === null || quoteAmount <= 0n || baseAmount <= 0n) {
      r.belowFloor++;
      continue;
    }
    let usd: number | null;
    if (quote.role === 'usd') usd = 1;
    else {
      nativeUsd ??= d.nativeUsd ? await d.nativeUsd() : null;
      usd = nativeUsd;
    }
    if (usd === null) {
      r.unquoted++;
      continue;
    }
    const liquidityUsd = (Number(quoteAmount) / 10 ** quote.decimals) * 2 * usd;
    if (!(liquidityUsd >= floor)) {
      r.belowFloor++;
      continue;
    }
    const created: CreatedPool = { venue, pool: p.pool, mintA: p.mintA, mintB: p.mintB, vaultA: p.vaultA, vaultB: p.vaultB, blockTime: 0, signature: 'discovered' };
    const rep = REPORT(d.spec.id);
    await registerPool(d, created, 0, tokenCache, rep);
    r.registered += rep.poolsNew;
  }
}

