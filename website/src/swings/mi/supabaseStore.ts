/**
 * MiStore over Supabase's PostgREST interface (plain fetch, service-role key, server side only). Schema: migration 0017.
 * Idempotence relies on primary keys with `resolution=ignore-duplicates`; counts of what was new come from `return=representation`.
 */
import type { ChainId } from '../core/types.js';
import { supabaseHeaders } from '../tokens/supabaseAuth.js';
import { decodeCursor, encodeCursor, type MiStore, type PoolPage, type PoolQuery } from './store.js';
import type { AdapterHealth, AuditEntry, BackfillJob, Checkpoint, MiPool, MiToken, MiTrade, PoolState } from './types.js';

export class MiMissingTableError extends Error {
  constructor() {
    super('The Market Indexer tables have not been created yet (migration 0017_market_indexer.sql).');
  }
}

type Row = Record<string, unknown>;
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const nz = (v: unknown): number => n(v) ?? 0;
const q = (v: string): string => `"${v.replace(/[^A-Za-z0-9:._-]/g, '')}"`;
const clampLimit = (v: number, max = 1000): number => Math.max(1, Math.min(max, Math.floor(v)));
export const MAX_OFFSET = 5_000;

const tokenFromRow = (r: Row): MiToken => ({ key: String(r.key), chain: r.chain as ChainId, address: String(r.address), symbol: String(r.symbol ?? ''), name: String(r.name ?? ''), decimals: nz(r.decimals), firstSeenAt: nz(r.first_seen_at), firstTradeAt: n(r.first_trade_at), launchboxKey: (r.launchbox_key as string | null) ?? null });
const tokenToRow = (t: MiToken, now: number): Row => ({ key: t.key, chain: t.chain, address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, first_seen_at: t.firstSeenAt, first_trade_at: t.firstTradeAt, launchbox_key: t.launchboxKey, updated_at: now });

export const poolFromRow = (r: Row): MiPool => ({
  key: String(r.key),
  chain: r.chain as ChainId,
  address: String(r.address),
  adapterId: String(r.adapter_id),
  dex: String(r.dex),
  kind: r.kind as MiPool['kind'],
  feeTier: n(r.fee_tier),
  base: String(r.base),
  quote: String(r.quote),
  baseDecimals: nz(r.base_decimals),
  quoteDecimals: nz(r.quote_decimals),
  baseIsToken0: r.base_is_token0 === true,
  createdBlock: nz(r.created_block),
  createdTx: String(r.created_tx),
  createdAt: nz(r.created_at),
  state: r.state as PoolState,
  stateReason: String(r.state_reason ?? ''),
  stateAt: nz(r.state_at),
  reserveBase: (r.reserve_base as string | null) ?? null,
  reserveQuote: (r.reserve_quote as string | null) ?? null,
  reserveBlock: n(r.reserve_block),
  firstTradeAt: n(r.first_trade_at),
  lastTradeAt: n(r.last_trade_at),
  paused: r.paused === true,
  stats: (r.stats as MiPool['stats']) ?? null,
});

const POOL_COLUMNS: Record<string, string> = { adapterId: 'adapter_id', feeTier: 'fee_tier', baseDecimals: 'base_decimals', quoteDecimals: 'quote_decimals', baseIsToken0: 'base_is_token0', createdBlock: 'created_block', createdTx: 'created_tx', createdAt: 'created_at', stateReason: 'state_reason', stateAt: 'state_at', reserveBase: 'reserve_base', reserveQuote: 'reserve_quote', reserveBlock: 'reserve_block', firstTradeAt: 'first_trade_at', lastTradeAt: 'last_trade_at' };
const poolColumn = (k: string): string => POOL_COLUMNS[k] ?? k;

function poolToRow(p: MiPool, now: number): Row {
  const row: Row = { updated_at: now };
  for (const [k, v] of Object.entries(p)) row[poolColumn(k)] = v;
  row.vol24_usd = p.stats?.volumeUsd.h24 ?? null;
  row.liquidity_usd = p.stats?.liquidityUsd ?? null;
  return row;
}

export class SupabaseMiStore implements MiStore {
  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await this.fetchImpl(`${this.url.replace(/\/$/, '')}/rest/v1/${path}`, { ...init, headers: { ...supabaseHeaders(this.serviceKey), 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });
    if (!res.ok) {
      if (res.status === 404 || res.status === 400) {
        const text = await res.text().catch(() => '');
        if (/PGRST205|PGRST200|42P01|does not exist|schema cache/i.test(text)) throw new MiMissingTableError();
      }
      throw new Error(`The Market Indexer database answered ${res.status}.`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  private rows(path: string): Promise<Row[]> {
    return this.call(path) as Promise<Row[]>;
  }

  // ---- tokens
  async upsertToken(t: MiToken): Promise<boolean> {
    const out = (await this.call('mi_tokens?on_conflict=key', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify([tokenToRow(t, this.now())]) })) as unknown[] | null;
    if (Array.isArray(out) && out.length > 0) return true;
    const k = encodeURIComponent(t.key);
    // Fill what was unknown and keep the earliest sighting; nothing known is overwritten.
    await this.call(`mi_tokens?key=eq.${k}&first_seen_at=gt.${t.firstSeenAt}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ first_seen_at: t.firstSeenAt }) });
    if (t.launchboxKey) await this.call(`mi_tokens?key=eq.${k}&launchbox_key=is.null`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ launchbox_key: t.launchboxKey }) });
    if (t.symbol) await this.call(`mi_tokens?key=eq.${k}&symbol=eq.`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ symbol: t.symbol }) });
    if (t.name) await this.call(`mi_tokens?key=eq.${k}&name=eq.`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ name: t.name }) });
    return false;
  }
  async getTokens(keys: readonly string[]): Promise<Map<string, MiToken>> {
    const out = new Map<string, MiToken>();
    for (let i = 0; i < keys.length; i += 50) {
      const list = keys.slice(i, i + 50).map(q).join(',');
      for (const r of await this.rows(`mi_tokens?key=in.(${list})&select=*`)) out.set(String(r.key), tokenFromRow(r));
    }
    return out;
  }
  async setTokenLaunchbox(key: string, launchboxKey: string): Promise<void> {
    await this.call(`mi_tokens?key=eq.${encodeURIComponent(key)}&launchbox_key=is.null`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ launchbox_key: launchboxKey }) });
  }
  async setTokenFirstTrade(key: string, at: number): Promise<void> {
    const k = encodeURIComponent(key);
    await this.call(`mi_tokens?key=eq.${k}&or=(first_trade_at.is.null,first_trade_at.gt.${at})`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ first_trade_at: at }) });
  }
  async searchTokens(text: string, limit: number): Promise<MiToken[]> {
    const t = text.trim().toLowerCase().replace(/[^a-z0-9 ._:-]/g, '');
    if (!t) return [];
    const filter = /^0x[0-9a-f]{40}$/.test(t) ? `address=eq.${t}` : `or=(symbol.ilike.*${t}*,name.ilike.*${t}*)`;
    return (await this.rows(`mi_tokens?${filter}&select=*&limit=${clampLimit(limit, 50)}`)).map(tokenFromRow);
  }

  // ---- pools
  async insertPool(p: MiPool): Promise<boolean> {
    const out = (await this.call('mi_pools?on_conflict=key', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify([poolToRow(p, this.now())]) })) as unknown[] | null;
    return Array.isArray(out) && out.length > 0;
  }
  async getPools(keys: readonly string[]): Promise<Map<string, MiPool>> {
    const out = new Map<string, MiPool>();
    for (let i = 0; i < keys.length; i += 50) {
      const list = keys.slice(i, i + 50).map(q).join(',');
      for (const r of await this.rows(`mi_pools?key=in.(${list})&select=*`)) out.set(String(r.key), poolFromRow(r));
    }
    return out;
  }
  async updatePool(key: string, patch: Partial<MiPool>): Promise<void> {
    const body: Row = { updated_at: this.now() };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) body[poolColumn(k)] = v;
    if ('stats' in patch) {
      body.vol24_usd = patch.stats?.volumeUsd.h24 ?? null;
      body.liquidity_usd = patch.stats?.liquidityUsd ?? null;
    }
    await this.call(`mi_pools?key=eq.${encodeURIComponent(key)}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify(body) });
  }
  async poolsOfAdapter(adapterId: string, states: readonly PoolState[], limit: number, order: 'newest' | 'recent-trade'): Promise<MiPool[]> {
    const list = states.map((s) => `"${s}"`).join(',');
    const ord = order === 'newest' ? 'created_block.desc,key.asc' : 'last_trade_at.desc.nullslast,key.asc';
    const extra = order === 'recent-trade' ? '&last_trade_at=not.is.null' : '';
    return (await this.rows(`mi_pools?adapter_id=eq.${encodeURIComponent(adapterId)}&state=in.(${list})&paused=is.false${extra}&select=*&order=${ord}&limit=${clampLimit(limit, 1000)}`)).map(poolFromRow);
  }
  async listPools(query: PoolQuery): Promise<PoolPage> {
    const f: string[] = [];
    if (query.chain) f.push(`chain=eq.${query.chain}`);
    if (query.dex) f.push(`dex=eq.${encodeURIComponent(query.dex)}`);
    if (query.states?.length) f.push(`state=in.(${query.states.map((s) => `"${s}"`).join(',')})`);
    if (query.createdAfter !== undefined) f.push(`created_at=gte.${Math.floor(query.createdAfter)}`);
    if (query.tokenKey) {
      const [c, a] = [query.tokenKey.slice(0, query.tokenKey.indexOf(':')), query.tokenKey.slice(query.tokenKey.indexOf(':') + 1)];
      const addr = q(a);
      f.push(`chain=eq.${c.replace(/[^a-z]/g, '')}`, `or=(base.eq.${addr},quote.eq.${addr})`);
    }
    if (query.text?.trim()) {
      const t = query.text.trim().toLowerCase().replace(/[^a-z0-9 ._-]/g, '');
      if (/^0x[0-9a-f]{40}$/.test(t)) f.push(`or=(address.eq.${t},base.eq.${t})`);
      else if (t) {
        const tokens = await this.searchTokens(t, 50);
        if (tokens.length === 0) return { pools: [], nextCursor: null };
        f.push(`base=in.(${tokens.map((x) => q(x.address)).join(',')})`);
      }
    }
    const col = { newest: 'created_at', volume24h: 'vol24_usd', liquidity: 'liquidity_usd', recentTrade: 'last_trade_at' }[query.sort];
    const limit = clampLimit(query.limit, 100);
    const cur = decodeCursor(query.cursor);
    let order = `${col}.desc.nullslast,key.desc`;
    let offset = 0;
    if (query.sort === 'newest') {
      if (cur && typeof cur[0] === 'number' && typeof cur[1] === 'string') f.push(`or=(created_at.lt.${cur[0]},and(created_at.eq.${cur[0]},key.lt.${q(cur[1])}))`);
    } else if (cur && cur[0] === 'o' && typeof cur[1] === 'number') {
      offset = Math.min(MAX_OFFSET, Math.max(0, Math.floor(cur[1])));
    } else order = `${col}.desc.nullslast,key.desc`;
    const rows = (await this.rows(`mi_pools?${f.join('&')}${f.length ? '&' : ''}select=*&order=${order}&limit=${limit + 1}${offset ? `&offset=${offset}` : ''}`)).map(poolFromRow);
    const page = rows.slice(0, limit);
    let next: string | null = null;
    if (rows.length > limit && page.length > 0) {
      if (query.sort === 'newest') next = encodeCursor([page[page.length - 1]!.createdAt, page[page.length - 1]!.key]);
      else if (offset + limit < MAX_OFFSET) next = encodeCursor(['o', offset + limit]);
    }
    return { pools: page, nextCursor: next };
  }
  async countPools(by: { chain?: ChainId; state?: PoolState }): Promise<number> {
    const f = [by.chain ? `chain=eq.${by.chain}` : '', by.state ? `state=eq.${by.state}` : ''].filter(Boolean).join('&');
    const res = await this.fetchImpl(`${this.url.replace(/\/$/, '')}/rest/v1/mi_pools?${f}${f ? '&' : ''}select=key`, { method: 'HEAD', headers: { ...supabaseHeaders(this.serviceKey), prefer: 'count=exact' } });
    if (res.status === 404) throw new MiMissingTableError();
    if (!res.ok) throw new Error(`The Market Indexer database answered ${res.status}.`);
    const total = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1];
    return total ? Number(total) : 0;
  }

  // ---- trades
  async putTrades(adapterId: string, trades: readonly MiTrade[]): Promise<number> {
    let added = 0;
    for (let i = 0; i < trades.length; i += 500) {
      const body = trades.slice(i, i + 500).map((t) => ({ chain: t.chain, pool: t.pool, id: t.id, adapter_id: adapterId, block: t.block, block_hash: t.blockHash, time: t.time, side: t.side, base_amount: t.baseAmount, quote_amount: t.quoteAmount, price: t.price, maker: t.maker }));
      const out = (await this.call('mi_trades?on_conflict=chain,pool,id', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(body) })) as unknown[] | null;
      added += Array.isArray(out) ? out.length : 0;
    }
    return added;
  }
  private tradeFromRow = (r: Row): MiTrade => ({ chain: r.chain as ChainId, pool: String(r.pool), id: String(r.id), block: nz(r.block), blockHash: String(r.block_hash), time: nz(r.time), side: r.side as 'buy' | 'sell', baseAmount: String(r.base_amount), quoteAmount: String(r.quote_amount), price: String(r.price), maker: String(r.maker) });
  async recentTrades(chain: ChainId, pool: string, limit: number, before?: number): Promise<MiTrade[]> {
    const b = before !== undefined ? `&time=lt.${Math.floor(before)}` : '';
    return (await this.rows(`mi_trades?chain=eq.${chain}&pool=eq.${q(pool)}${b}&select=*&order=time.desc,block.desc,id.desc&limit=${clampLimit(limit, 500)}`)).map(this.tradeFromRow);
  }
  async tradesSince(chain: ChainId, pool: string, fromSec: number, limit: number): Promise<MiTrade[]> {
    return (await this.rows(`mi_trades?chain=eq.${chain}&pool=eq.${q(pool)}&time=gte.${Math.floor(fromSec)}&select=*&order=time.asc,block.asc,id.asc&limit=${clampLimit(limit, 10_000)}`)).map(this.tradeFromRow);
  }
  async lastTradeBefore(chain: ChainId, pool: string, beforeSec: number): Promise<MiTrade | null> {
    const r = await this.rows(`mi_trades?chain=eq.${chain}&pool=eq.${q(pool)}&time=lt.${Math.floor(beforeSec)}&select=*&order=time.desc,block.desc,id.desc&limit=1`);
    return r[0] ? this.tradeFromRow(r[0]) : null;
  }
  async deleteTradesFrom(adapterId: string, block: number): Promise<number> {
    const out = (await this.call(`mi_trades?adapter_id=eq.${encodeURIComponent(adapterId)}&block=gte.${Math.floor(block)}`, { method: 'DELETE', headers: { prefer: 'return=representation' } })) as unknown[] | null;
    return Array.isArray(out) ? out.length : 0;
  }
  async deletePoolsCreatedFrom(adapterId: string, block: number): Promise<number> {
    const out = await this.call('rpc/mi_delete_pools_from', { method: 'POST', body: JSON.stringify({ p_adapter: adapterId, p_block: Math.floor(block) }) });
    return nz(out);
  }

  // ---- progress
  async getCheckpoint(adapterId: string): Promise<Checkpoint | null> {
    const r = (await this.rows(`mi_checkpoints?adapter_id=eq.${encodeURIComponent(adapterId)}&select=*&limit=1`))[0];
    return r ? { adapterId: String(r.adapter_id), block: nz(r.block), blockHash: String(r.block_hash), updatedAt: nz(r.updated_at) } : null;
  }
  async setCheckpoint(c: Checkpoint): Promise<void> {
    await this.call('mi_checkpoints?on_conflict=adapter_id', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ adapter_id: c.adapterId, block: c.block, block_hash: c.blockHash, updated_at: c.updatedAt }) });
  }
  async putBlockHash(adapterId: string, block: number, hash: string): Promise<void> {
    await this.call('mi_block_hashes?on_conflict=adapter_id,block', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ adapter_id: adapterId, block, hash }) });
  }
  async getBlockHash(adapterId: string, block: number): Promise<string | null> {
    const r = (await this.rows(`mi_block_hashes?adapter_id=eq.${encodeURIComponent(adapterId)}&block=eq.${Math.floor(block)}&select=hash&limit=1`))[0];
    return r ? String(r.hash) : null;
  }
  async blockHashAtOrBelow(adapterId: string, block: number): Promise<{ block: number; hash: string } | null> {
    const r = (await this.rows(`mi_block_hashes?adapter_id=eq.${encodeURIComponent(adapterId)}&block=lte.${Math.floor(block)}&select=block,hash&order=block.desc&limit=1`))[0];
    return r ? { block: nz(r.block), hash: String(r.hash) } : null;
  }
  async pruneBlockHashes(adapterId: string, belowBlock: number): Promise<void> {
    await this.call(`mi_block_hashes?adapter_id=eq.${encodeURIComponent(adapterId)}&block=lt.${Math.floor(belowBlock)}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
  }
  async putHealth(h: AdapterHealth): Promise<void> {
    await this.call('mi_health?on_conflict=adapter_id', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ adapter_id: h.adapterId, data: h, updated_at: h.lastRunAt }) });
  }
  async listHealth(): Promise<AdapterHealth[]> {
    return (await this.rows('mi_health?select=data&limit=200')).map((r) => r.data as AdapterHealth);
  }

  // ---- controls, audit, jobs
  async disabledAdapters(): Promise<Map<string, { reason: string; at: number }>> {
    const out = new Map<string, { reason: string; at: number }>();
    for (const r of await this.rows('mi_controls?disabled=is.true&select=adapter_id,reason,at&limit=500')) out.set(String(r.adapter_id), { reason: String(r.reason ?? ''), at: nz(r.at) });
    return out;
  }
  async setAdapterDisabled(adapterId: string, disabled: boolean, reason: string, now: number): Promise<void> {
    await this.call('mi_controls?on_conflict=adapter_id', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ adapter_id: adapterId, disabled, reason, at: now }) });
  }
  async appendAudit(e: AuditEntry): Promise<void> {
    await this.call('mi_audit', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ at: e.at, actor: e.actor, action: e.action, target: e.target, detail: e.detail }) });
  }
  async listAudit(limit: number): Promise<AuditEntry[]> {
    return (await this.rows(`mi_audit?select=at,actor,action,target,detail&order=at.desc,id.desc&limit=${clampLimit(limit, 500)}`)).map((r) => ({ at: nz(r.at), actor: String(r.actor), action: String(r.action), target: String(r.target), detail: (r.detail as Record<string, unknown>) ?? {} }));
  }
  private jobFromRow = (r: Row): BackfillJob => ({ id: String(r.id), adapterId: String(r.adapter_id), fromBlock: nz(r.from_block), toBlock: nz(r.to_block), doneBlock: nz(r.done_block), status: r.status as BackfillJob['status'], requestedBy: String(r.requested_by), requestedAt: nz(r.requested_at), error: (r.error as string | null) ?? null });
  async createJob(j: BackfillJob): Promise<void> {
    await this.call('mi_jobs', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ id: j.id, adapter_id: j.adapterId, from_block: j.fromBlock, to_block: j.toBlock, done_block: j.doneBlock, status: j.status, requested_by: j.requestedBy, requested_at: j.requestedAt, error: j.error }) });
  }
  async claimJob(): Promise<BackfillJob | null> {
    const out = (await this.call('rpc/mi_claim_job', { method: 'POST', body: '{}' })) as Row[] | null;
    return Array.isArray(out) && out[0] ? this.jobFromRow(out[0]) : null;
  }
  async updateJob(id: string, patch: Partial<BackfillJob>): Promise<void> {
    const map: Record<string, string> = { doneBlock: 'done_block', status: 'status', error: 'error' };
    const body: Row = {};
    for (const [k, v] of Object.entries(patch)) if (map[k]) body[map[k]!] = v;
    if (Object.keys(body).length) await this.call(`mi_jobs?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify(body) });
  }
  async listJobs(limit: number): Promise<BackfillJob[]> {
    return (await this.rows(`mi_jobs?select=*&order=requested_at.desc&limit=${clampLimit(limit, 200)}`)).map(this.jobFromRow);
  }
}
