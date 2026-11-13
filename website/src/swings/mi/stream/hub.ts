/**
 * The live market stream's hub: who is watching which pools, and what is sent to them. Pure and in memory, no network: the HTTP side
 * (server.ts) feeds it and the worker's publisher (publisher.ts) fills it.
 *
 * Rules, all stated here because they are what keeps a small server safe:
 *  - A viewer names the pools on screen (at most `maxKeys`) and receives updates for those only.
 *  - One pool is sent to one viewer at most once per `minIntervalMs` (default 1 s); in between, the newest update waits and replaces older ones,
 *    so a pool that trades ten times a second costs one message a second, and the last word is never lost.
 *  - A new viewer is first sent the latest update held for each of its pools (so the page is in step with the index at once).
 *  - Memory is bounded: a cap on viewers, on pools per viewer and on remembered updates (the oldest are dropped first).
 */
import type { LiveUpdate } from '../../market/liveFields.js';

export interface HubOptions {
  now?: () => number;
  minIntervalMs?: number;
  maxClients?: number;
  maxKeys?: number;
  /** Updates remembered for new viewers. */
  maxLatest?: number;
  /** A remembered update older than this is not sent to a new viewer (ms). */
  latestMaxAgeMs?: number;
}

/** What the HTTP side gives the hub for one open connection: a way to write to it, and to close it. */
export interface Sink {
  write(chunk: string): boolean;
  end(): void;
}

interface Client {
  id: number;
  keys: Set<string>;
  sink: Sink;
  lastSent: Map<string, number>;
  pending: Map<string, LiveUpdate>;
}

export type SubscribeResult = { ok: true; id: number } | { ok: false; reason: 'full' | 'too-many-keys' | 'no-keys' };

export class StreamHub {
  private readonly now: () => number;
  readonly minIntervalMs: number;
  readonly maxClients: number;
  readonly maxKeys: number;
  private readonly maxLatest: number;
  private readonly latestMaxAgeMs: number;
  private nextId = 1;
  private readonly clients = new Map<number, Client>();
  private readonly byKey = new Map<string, Set<Client>>();
  private readonly latest = new Map<string, LiveUpdate>();
  sent = 0;
  received = 0;

  constructor(o: HubOptions = {}) {
    this.now = o.now ?? Date.now;
    this.minIntervalMs = o.minIntervalMs ?? 1000;
    this.maxClients = o.maxClients ?? 2000;
    this.maxKeys = o.maxKeys ?? 100;
    this.maxLatest = o.maxLatest ?? 20_000;
    this.latestMaxAgeMs = o.latestMaxAgeMs ?? 120_000;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  subscribe(keys: readonly string[], sink: Sink): SubscribeResult {
    const unique = [...new Set(keys)];
    if (unique.length === 0) return { ok: false, reason: 'no-keys' };
    if (unique.length > this.maxKeys) return { ok: false, reason: 'too-many-keys' };
    if (this.clients.size >= this.maxClients) return { ok: false, reason: 'full' };
    const c: Client = { id: this.nextId++, keys: new Set(unique), sink, lastSent: new Map(), pending: new Map() };
    this.clients.set(c.id, c);
    for (const k of c.keys) (this.byKey.get(k) ?? this.byKey.set(k, new Set()).get(k)!).add(c);
    // Bring the new viewer level with what the index last said, newest known state of each of its pools.
    const t = this.now();
    const first: LiveUpdate[] = [];
    for (const k of c.keys) {
      const u = this.latest.get(k);
      if (u && t - u.at <= this.latestMaxAgeMs) {
        first.push(u);
        c.lastSent.set(k, t);
      }
    }
    if (first.length > 0) this.deliver(c, first);
    return { ok: true, id: c.id };
  }

  unsubscribe(id: number): void {
    const c = this.clients.get(id);
    if (!c) return;
    this.clients.delete(id);
    for (const k of c.keys) {
      const set = this.byKey.get(k);
      if (!set) continue;
      set.delete(c);
      if (set.size === 0) this.byKey.delete(k);
    }
  }

  /** The index's new state for these pools. Sent at once to viewers who have not had that pool this second, held for the others. */
  publish(updates: readonly LiveUpdate[]): void {
    const t = this.now();
    const out = new Map<Client, LiveUpdate[]>();
    for (const u of updates) {
      this.received++;
      this.remember(u);
      for (const c of this.byKey.get(u.key) ?? []) {
        const last = c.lastSent.get(u.key) ?? 0;
        if (t - last >= this.minIntervalMs) {
          c.lastSent.set(u.key, t);
          c.pending.delete(u.key);
          (out.get(c) ?? out.set(c, []).get(c)!).push(u);
        } else {
          c.pending.set(u.key, u);
        }
      }
    }
    for (const [c, list] of out) this.deliver(c, list);
  }

  /** Sends what was held back and is now due. Call it on a short timer (a few times a second). */
  flush(): void {
    const t = this.now();
    for (const c of this.clients.values()) {
      if (c.pending.size === 0) continue;
      const due: LiveUpdate[] = [];
      for (const [k, u] of c.pending) {
        if (t - (c.lastSent.get(k) ?? 0) >= this.minIntervalMs) {
          due.push(u);
          c.lastSent.set(k, t);
          c.pending.delete(k);
        }
      }
      if (due.length > 0) this.deliver(c, due);
    }
  }

  /** A comment line to every viewer, so proxies and browsers see the connection is alive. */
  heartbeat(): void {
    for (const c of [...this.clients.values()]) {
      if (!c.sink.write(': ping\n\n')) this.drop(c);
    }
  }

  closeAll(): void {
    for (const c of [...this.clients.values()]) this.drop(c);
  }

  private deliver(c: Client, list: LiveUpdate[]): void {
    if (list.length === 0) return;
    this.sent += list.length;
    if (!c.sink.write(`event: u\ndata: ${JSON.stringify(list)}\n\n`)) this.drop(c);
  }

  private drop(c: Client): void {
    this.unsubscribe(c.id);
    try {
      c.sink.end();
    } catch {
      /* the connection is already gone */
    }
  }

  private remember(u: LiveUpdate): void {
    this.latest.delete(u.key); // re-inserted last, so the oldest is always the first
    this.latest.set(u.key, u);
    while (this.latest.size > this.maxLatest) {
      const oldest = this.latest.keys().next().value;
      if (oldest === undefined) break;
      this.latest.delete(oldest);
    }
  }
}
