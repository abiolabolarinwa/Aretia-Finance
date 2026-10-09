/**
 * Storage for recorded prices (pool_ticks) and the list of pools people are looking at (tracked_pools), over Supabase's
 * REST interface with the service key. Server side only.
 */
import { supabaseHeaders } from '../tokens/supabaseAuth.js';
import type { ChainId } from '../core/types.js';
import type { Tick } from './candles.js';

export interface TickInput {
  chain: ChainId;
  pool: string;
  ts: number;
  price: number;
  liq: number | null;
  vol24: number | null;
}

const KEEP_MS = 45 * 86_400_000;

export class SupabaseTickStore {
  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await this.fetchImpl(`${this.url.replace(/\/$/, '')}/rest/v1/${path}`, { ...init, headers: { ...supabaseHeaders(this.key), 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });
    if (!res.ok) throw new Error(`The price database answered ${res.status}.`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async add(ticks: readonly TickInput[]): Promise<void> {
    if (ticks.length === 0) return;
    await this.call('pool_ticks?on_conflict=chain,pool,ts', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(ticks) });
  }

  async list(chain: ChainId, pool: string, since: number): Promise<Tick[]> {
    const rows = (await this.call(`pool_ticks?chain=eq.${chain}&pool=eq.${encodeURIComponent(pool)}&ts=gte.${Math.floor(since)}&select=ts,price&order=ts.asc&limit=5000`)) as { ts: number; price: number }[];
    return rows.map((r) => ({ ts: Number(r.ts), price: Number(r.price) }));
  }

  /** Marks a pool as being looked at, so the refresh job records it. */
  async track(chain: ChainId, pool: string, now: number): Promise<void> {
    await this.call('tracked_pools?on_conflict=chain,pool', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ chain, pool, last_seen: now }) });
  }

  async tracked(chain: ChainId, since: number, limit: number): Promise<string[]> {
    const rows = (await this.call(`tracked_pools?chain=eq.${chain}&last_seen=gte.${Math.floor(since)}&select=pool&order=last_seen.desc&limit=${limit}`)) as { pool: string }[];
    return rows.map((r) => r.pool);
  }

  async prune(now: number): Promise<void> {
    await this.call(`pool_ticks?ts=lt.${Math.floor(now - KEEP_MS)}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
  }
}
