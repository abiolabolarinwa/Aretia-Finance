/**
 * The worker's side of the live stream: every time it writes a pool's statistics, a small update goes to the stream service.
 *
 * It must never slow or break indexing, so: updates are collected for a moment (the newest per pool wins), sent in one request, and any
 * failure only drops that batch (a counter says how many). The store is wrapped, not changed: `publishing(store, publisher)` returns the
 * same store, with `updatePool` also announcing what it wrote.
 */
import type { LiveUpdate } from '../../market/liveFields.js';
import type { MiStore } from '../store.js';
import type { MiPool, PoolStats } from '../types.js';

export interface PublisherOptions {
  url: string;
  secret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** How long updates are collected before a request (ms). */
  flushMs?: number;
  /** Most updates held while the service is slow or down; the oldest are dropped. */
  maxHeld?: number;
  /** Most updates in one request. */
  batch?: number;
}

/** A pool's stored statistics as the update the page applies (the same names as the columns the list reads). */
export function updateOf(key: string, stats: PoolStats, lastTradeAt: number | null | undefined, at: number): LiveUpdate {
  return {
    key,
    at,
    p_usd: stats.priceUsd,
    rp: stats.reservePriceUsd ?? null,
    chg: stats.change,
    buys: stats.buys,
    sells: stats.sells,
    vol: stats.volumeUsd,
    ro: stats.reservesOnly === true,
    mk: stats.makers24h,
    cp: stats.windowCapped === true,
    ...(lastTradeAt !== undefined ? { last_trade_at: lastTradeAt } : {}),
    liquidity_usd: stats.liquidityUsd,
  };
}

export class StreamPublisher {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly held = new Map<string, LiveUpdate>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  published = 0;
  dropped = 0;
  failures = 0;

  constructor(private readonly o: PublisherOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.now = o.now ?? Date.now;
  }

  push(u: LiveUpdate): void {
    this.held.delete(u.key);
    this.held.set(u.key, u);
    const cap = this.o.maxHeld ?? 5_000;
    while (this.held.size > cap) {
      const oldest = this.held.keys().next().value;
      if (oldest === undefined) break;
      this.held.delete(oldest);
      this.dropped++;
    }
    if (this.timer === null && !this.busy) {
      this.timer = setTimeout(() => void this.flush(), this.o.flushMs ?? 500);
      this.timer.unref?.();
    }
  }

  /** Sends what is held. Never throws. */
  async flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.busy || this.held.size === 0) return;
    this.busy = true;
    try {
      const size = this.o.batch ?? 500;
      while (this.held.size > 0) {
        const batch: LiveUpdate[] = [];
        for (const [k, u] of this.held) {
          batch.push(u);
          this.held.delete(k);
          if (batch.length >= size) break;
        }
        try {
          const res = await this.fetchImpl(`${this.o.url.replace(/\/+$/, '')}/publish`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-stream-secret': this.o.secret },
            body: JSON.stringify(batch),
            signal: AbortSignal.timeout(3_000),
          });
          if (res.ok) this.published += batch.length;
          else {
            this.failures++;
            this.dropped += batch.length;
            break;
          }
        } catch {
          // The service is down or slow: this batch is gone (the page catches up from the next refresh), the worker goes on.
          this.failures++;
          this.dropped += batch.length;
          break;
        }
      }
    } finally {
      this.busy = false;
      if (this.held.size > 0 && this.timer === null) {
        this.timer = setTimeout(() => void this.flush(), this.o.flushMs ?? 500);
        this.timer.unref?.();
      }
    }
  }
}

/** The same store, announcing every statistics write it makes. */
export function publishing(store: MiStore, publisher: StreamPublisher, now: () => number = Date.now): MiStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== 'updatePool' || typeof value !== 'function') return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      return async (key: string, patch: Partial<MiPool>): Promise<void> => {
        await (value as MiStore['updatePool']).call(target, key, patch);
        if (patch.stats) publisher.push(updateOf(key, patch.stats, patch.lastTradeAt, now()));
      };
    },
  });
}
