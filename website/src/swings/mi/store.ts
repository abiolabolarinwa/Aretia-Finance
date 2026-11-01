/**
 * Storage contract of the Market Indexer plus the in-memory reference implementation used by tests and by the live end-to-end
 * run. The Supabase implementation (supabaseStore.ts) must give the same answers; store.contract.test.ts runs one suite on both
 * shapes' behaviour.
 *
 * Idempotence is part of the contract: inserting a token, pool or trade that exists changes nothing.
 */
import type { AdapterHealth, AuditEntry, BackfillJob, Checkpoint, MiPool, MiToken, MiTrade, PoolState } from './types.js';
import type { MiChain } from './chains.js';

export interface PoolQuery {
  chain?: MiChain;
  dex?: string;
  states?: readonly PoolState[];
  /** Pools that include this token (base or quote), `chain:address`. */
  tokenKey?: string;
  /** Case-insensitive match on symbol / name of the base token, or an exact address / pool address. */
  text?: string;
  sort: 'newest' | 'volume24h' | 'liquidity' | 'recentTrade';
  limit: number;
  /** Opaque cursor from a previous page. */
  cursor?: string | null;
  /** Created at or after (ms). */
  createdAfter?: number;
}

export interface PoolPage {
  pools: MiPool[];
  nextCursor: string | null;
}

export interface MiStore {
  // ---- tokens
  /** Inserts the token if absent. If present, fills fields that were unknown and keeps the earliest firstSeenAt. Returns true when it was new. */
  upsertToken(t: MiToken): Promise<boolean>;
  getTokens(keys: readonly string[]): Promise<Map<string, MiToken>>;
  setTokenLaunchbox(key: string, launchboxKey: string): Promise<void>;
  setTokenFirstTrade(key: string, at: number): Promise<void>;
  searchTokens(text: string, limit: number): Promise<MiToken[]>;

  // ---- pools
  /** Inserts the pool if absent; an existing pool is left exactly as it is. Returns true when it was new. */
  insertPool(p: MiPool): Promise<boolean>;
  getPools(keys: readonly string[]): Promise<Map<string, MiPool>>;
  updatePool(key: string, patch: Partial<MiPool>): Promise<void>;
  /** Pools of one adapter in the given states, for swap following: newest created first, or most recently traded first. Paused pools are never returned. */
  poolsOfAdapter(adapterId: string, states: readonly PoolState[], limit: number, order: 'newest' | 'recent-trade'): Promise<MiPool[]>;
  /** Pools of one adapter whose history is not complete yet (see MiPool.historyDone), least recently updated first. */
  poolsNeedingHistory(adapterId: string, limit: number): Promise<MiPool[]>;
  listPools(q: PoolQuery): Promise<PoolPage>;
  countPools(by: { chain?: MiChain; state?: PoolState }): Promise<number>;

  // ---- trades
  /** Idempotent on (chain, pool, id). `adapterId` is recorded so a reorg can remove an adapter's trades without listing its pools. Returns how many were new. */
  putTrades(adapterId: string, trades: readonly MiTrade[]): Promise<number>;
  /** Newest first. */
  recentTrades(chain: MiChain, pool: string, limit: number, before?: number): Promise<MiTrade[]>;
  /** Oldest first, from `fromSec` (unix seconds) on. */
  tradesSince(chain: MiChain, pool: string, fromSec: number, limit: number): Promise<MiTrade[]>;
  /** The last trade strictly before `beforeSec`, for the price a window opened at. */
  lastTradeBefore(chain: MiChain, pool: string, beforeSec: number): Promise<MiTrade | null>;
  /** Retention: removes trades older than `beforeSec` (unix seconds), at most `limit` per call; returns how many. */
  pruneTrades(beforeSec: number, limit: number): Promise<number>;
  /** Reorg: removes the trades this adapter wrote at or above `block`; returns how many. */
  deleteTradesFrom(adapterId: string, block: number): Promise<number>;
  /** Reorg: removes pools of this adapter created at or above `block`, with their trades; returns how many pools. */
  deletePoolsCreatedFrom(adapterId: string, block: number): Promise<number>;

  // ---- progress
  getCheckpoint(adapterId: string): Promise<Checkpoint | null>;
  setCheckpoint(c: Checkpoint): Promise<void>;
  putBlockHash(adapterId: string, block: number, hash: string): Promise<void>;
  getBlockHash(adapterId: string, block: number): Promise<string | null>;
  /** Highest stored block at or below `block` with its hash, for walking back to a fork point. */
  blockHashAtOrBelow(adapterId: string, block: number): Promise<{ block: number; hash: string } | null>;
  pruneBlockHashes(adapterId: string, belowBlock: number): Promise<void>;
  putHealth(h: AdapterHealth): Promise<void>;
  listHealth(): Promise<AdapterHealth[]>;

  // ---- controls, audit, jobs
  disabledAdapters(): Promise<Map<string, { reason: string; at: number }>>;
  setAdapterDisabled(adapterId: string, disabled: boolean, reason: string, now: number): Promise<void>;
  appendAudit(e: AuditEntry): Promise<void>;
  listAudit(limit: number): Promise<AuditEntry[]>;
  createJob(j: BackfillJob): Promise<void>;
  claimJob(): Promise<BackfillJob | null>;
  updateJob(id: string, patch: Partial<BackfillJob>): Promise<void>;
  listJobs(limit: number): Promise<BackfillJob[]>;
}

// ---------------------------------------------------------------------------------------------- cursors

export function encodeCursor(parts: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}
export function decodeCursor(c: string | null | undefined): (string | number)[] | null {
  if (!c) return null;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown;
    return Array.isArray(v) && v.length <= 4 && v.every((x) => typeof x === 'string' || typeof x === 'number') ? (v as (string | number)[]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------- in-memory

const tradeKey = (chain: string, pool: string, id: string): string => `${chain}|${pool}|${id}`;

export class InMemoryMiStore implements MiStore {
  tokens = new Map<string, MiToken>();
  pools = new Map<string, MiPool>();
  trades = new Map<string, MiTrade>();
  tradeAdapter = new Map<string, string>();
  checkpoints = new Map<string, Checkpoint>();
  hashes = new Map<string, Map<number, string>>();
  health = new Map<string, AdapterHealth>();
  disabled = new Map<string, { reason: string; at: number }>();
  audit: AuditEntry[] = [];
  jobs = new Map<string, BackfillJob>();

  async upsertToken(t: MiToken): Promise<boolean> {
    const cur = this.tokens.get(t.key);
    if (!cur) {
      this.tokens.set(t.key, { ...t });
      return true;
    }
    cur.firstSeenAt = Math.min(cur.firstSeenAt, t.firstSeenAt);
    if (!cur.symbol && t.symbol) cur.symbol = t.symbol;
    if (!cur.name && t.name) cur.name = t.name;
    cur.launchboxKey = cur.launchboxKey ?? t.launchboxKey;
    cur.firstTradeAt = cur.firstTradeAt ?? t.firstTradeAt;
    return false;
  }
  async getTokens(keys: readonly string[]): Promise<Map<string, MiToken>> {
    const out = new Map<string, MiToken>();
    for (const k of keys) {
      const t = this.tokens.get(k);
      if (t) out.set(k, { ...t });
    }
    return out;
  }
  async setTokenLaunchbox(key: string, launchboxKey: string): Promise<void> {
    const t = this.tokens.get(key);
    if (t) t.launchboxKey = launchboxKey;
  }
  async setTokenFirstTrade(key: string, at: number): Promise<void> {
    const t = this.tokens.get(key);
    if (t && (t.firstTradeAt === null || at < t.firstTradeAt)) t.firstTradeAt = at;
  }
  async searchTokens(text: string, limit: number): Promise<MiToken[]> {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    return [...this.tokens.values()].filter((t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.address === q).slice(0, limit);
  }

  async insertPool(p: MiPool): Promise<boolean> {
    if (this.pools.has(p.key)) return false;
    this.pools.set(p.key, { ...p });
    return true;
  }
  async getPools(keys: readonly string[]): Promise<Map<string, MiPool>> {
    const out = new Map<string, MiPool>();
    for (const k of keys) {
      const p = this.pools.get(k);
      if (p) out.set(k, { ...p });
    }
    return out;
  }
  async updatePool(key: string, patch: Partial<MiPool>): Promise<void> {
    const p = this.pools.get(key);
    if (p) Object.assign(p, patch);
  }
  async poolsOfAdapter(adapterId: string, states: readonly PoolState[], limit: number, order: 'newest' | 'recent-trade'): Promise<MiPool[]> {
    return [...this.pools.values()]
      .filter((p) => p.adapterId === adapterId && states.includes(p.state) && !p.paused && (order === 'newest' || p.lastTradeAt !== null))
      .sort((a, b) => (order === 'newest' ? b.createdBlock - a.createdBlock : (b.lastTradeAt ?? 0) - (a.lastTradeAt ?? 0)) || (a.key < b.key ? -1 : 1))
      .slice(0, limit)
      .map((p) => ({ ...p }));
  }

  async poolsNeedingHistory(adapterId: string, limit: number): Promise<MiPool[]> {
    return [...this.pools.values()].filter((p) => p.adapterId === adapterId && !p.historyDone && !p.paused).slice(0, limit).map((p) => ({ ...p }));
  }

  async listPools(q: PoolQuery): Promise<PoolPage> {
    const text = q.text?.trim().toLowerCase() ?? '';
    const tokenSymbols = new Map<string, MiToken>();
    for (const t of this.tokens.values()) tokenSymbols.set(t.key, t);
    let rows = [...this.pools.values()].filter((p) => {
      if (q.chain && p.chain !== q.chain) return false;
      if (q.dex && p.dex !== q.dex) return false;
      if (q.states && !q.states.includes(p.state)) return false;
      if (q.createdAfter !== undefined && p.createdAt < q.createdAfter) return false;
      if (q.tokenKey && `${p.chain}:${p.base}` !== q.tokenKey && `${p.chain}:${p.quote}` !== q.tokenKey) return false;
      if (text) {
        const t = tokenSymbols.get(`${p.chain}:${p.base}`);
        const hit = p.address === text || p.base === text || (t !== undefined && (t.symbol.toLowerCase().includes(text) || t.name.toLowerCase().includes(text)));
        if (!hit) return false;
      }
      return true;
    });
    const metric = (p: MiPool): number => {
      switch (q.sort) {
        case 'volume24h':
          return p.stats?.volumeUsd.h24 ?? p.stats?.volumeQuote.h24 ?? 0;
        case 'liquidity':
          return p.stats?.liquidityUsd ?? p.stats?.liquidityQuote ?? 0;
        case 'recentTrade':
          return p.lastTradeAt ?? 0;
        default:
          return p.createdAt;
      }
    };
    rows.sort((a, b) => metric(b) - metric(a) || (a.key < b.key ? 1 : -1));
    const cur = decodeCursor(q.cursor);
    if (cur && typeof cur[0] === 'number' && typeof cur[1] === 'string') {
      const [m, k] = cur as [number, string];
      rows = rows.filter((p) => metric(p) < m || (metric(p) === m && p.key < k));
    }
    const page = rows.slice(0, q.limit);
    const next = rows.length > q.limit && page.length > 0 ? encodeCursor([metric(page[page.length - 1]!), page[page.length - 1]!.key]) : null;
    return { pools: page.map((p) => ({ ...p })), nextCursor: next };
  }
  async countPools(by: { chain?: MiChain; state?: PoolState }): Promise<number> {
    return [...this.pools.values()].filter((p) => (!by.chain || p.chain === by.chain) && (!by.state || p.state === by.state)).length;
  }

  async putTrades(adapterId: string, trades: readonly MiTrade[]): Promise<number> {
    let n = 0;
    for (const t of trades) {
      const k = tradeKey(t.chain, t.pool, t.id);
      if (!this.trades.has(k)) {
        this.trades.set(k, { ...t });
        this.tradeAdapter.set(k, adapterId);
        n++;
      }
    }
    return n;
  }
  private sortedTrades(chain: MiChain, pool: string): MiTrade[] {
    return [...this.trades.values()].filter((t) => t.chain === chain && t.pool === pool).sort((a, b) => a.time - b.time || a.block - b.block || (a.id < b.id ? -1 : 1));
  }
  async recentTrades(chain: MiChain, pool: string, limit: number, before?: number): Promise<MiTrade[]> {
    const all = this.sortedTrades(chain, pool).filter((t) => before === undefined || t.time < before);
    return all.reverse().slice(0, limit);
  }
  async tradesSince(chain: MiChain, pool: string, fromSec: number, limit: number): Promise<MiTrade[]> {
    return this.sortedTrades(chain, pool).filter((t) => t.time >= fromSec).slice(0, limit);
  }
  async lastTradeBefore(chain: MiChain, pool: string, beforeSec: number): Promise<MiTrade | null> {
    const all = this.sortedTrades(chain, pool).filter((t) => t.time < beforeSec);
    return all.length ? { ...all[all.length - 1]! } : null;
  }
  async pruneTrades(beforeSec: number, limit: number): Promise<number> {
    let n = 0;
    for (const [k, t] of [...this.trades]) {
      if (n >= limit) break;
      if (t.time < beforeSec) {
        this.trades.delete(k);
        this.tradeAdapter.delete(k);
        n++;
      }
    }
    return n;
  }
  async deleteTradesFrom(adapterId: string, block: number): Promise<number> {
    let n = 0;
    for (const [k, t] of [...this.trades]) {
      if (this.tradeAdapter.get(k) === adapterId && t.block >= block) {
        this.trades.delete(k);
        this.tradeAdapter.delete(k);
        n++;
      }
    }
    return n;
  }
  async deletePoolsCreatedFrom(adapterId: string, block: number): Promise<number> {
    let n = 0;
    for (const [k, p] of [...this.pools]) {
      if (p.adapterId === adapterId && p.createdBlock >= block) {
        for (const [tk, t] of [...this.trades]) if (t.chain === p.chain && t.pool === p.address) {
          this.trades.delete(tk);
          this.tradeAdapter.delete(tk);
        }
        this.pools.delete(k);
        n++;
      }
    }
    return n;
  }

  async getCheckpoint(adapterId: string): Promise<Checkpoint | null> {
    const c = this.checkpoints.get(adapterId);
    return c ? { ...c } : null;
  }
  async setCheckpoint(c: Checkpoint): Promise<void> {
    this.checkpoints.set(c.adapterId, { ...c });
  }
  async putBlockHash(adapterId: string, block: number, hash: string): Promise<void> {
    let m = this.hashes.get(adapterId);
    if (!m) this.hashes.set(adapterId, (m = new Map()));
    m.set(block, hash);
  }
  async getBlockHash(adapterId: string, block: number): Promise<string | null> {
    return this.hashes.get(adapterId)?.get(block) ?? null;
  }
  async blockHashAtOrBelow(adapterId: string, block: number): Promise<{ block: number; hash: string } | null> {
    let best: { block: number; hash: string } | null = null;
    for (const [b, h] of this.hashes.get(adapterId) ?? []) if (b <= block && (best === null || b > best.block)) best = { block: b, hash: h };
    return best;
  }
  async pruneBlockHashes(adapterId: string, belowBlock: number): Promise<void> {
    const m = this.hashes.get(adapterId);
    if (m) for (const b of [...m.keys()]) if (b < belowBlock) m.delete(b);
  }
  async putHealth(h: AdapterHealth): Promise<void> {
    this.health.set(h.adapterId, { ...h });
  }
  async listHealth(): Promise<AdapterHealth[]> {
    return [...this.health.values()].map((h) => ({ ...h }));
  }

  async disabledAdapters(): Promise<Map<string, { reason: string; at: number }>> {
    return new Map(this.disabled);
  }
  async setAdapterDisabled(adapterId: string, disabled: boolean, reason: string, now: number): Promise<void> {
    if (disabled) this.disabled.set(adapterId, { reason, at: now });
    else this.disabled.delete(adapterId);
  }
  async appendAudit(e: AuditEntry): Promise<void> {
    this.audit.push({ ...e });
  }
  async listAudit(limit: number): Promise<AuditEntry[]> {
    return [...this.audit].reverse().slice(0, limit);
  }
  async createJob(j: BackfillJob): Promise<void> {
    this.jobs.set(j.id, { ...j });
  }
  async claimJob(): Promise<BackfillJob | null> {
    const j = [...this.jobs.values()].filter((x) => x.status === 'pending').sort((a, b) => a.requestedAt - b.requestedAt)[0];
    if (!j) return null;
    j.status = 'running';
    return { ...j };
  }
  async updateJob(id: string, patch: Partial<BackfillJob>): Promise<void> {
    const j = this.jobs.get(id);
    if (j) Object.assign(j, patch);
  }
  async listJobs(limit: number): Promise<BackfillJob[]> {
    return [...this.jobs.values()].sort((a, b) => b.requestedAt - a.requestedAt).slice(0, limit).map((j) => ({ ...j }));
  }
}
