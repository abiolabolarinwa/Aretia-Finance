/**
 * Launch Box storage. The indexer and the API talk to `LaunchStore`; tests use a fake, production uses Supabase's REST interface with
 * the service key (the browser never sees it). A table that does not exist yet (the migration has not been run) is reported as
 * `MissingTableError` so the page can say so instead of failing.
 */
import { supabaseHeaders } from '../tokens/supabaseAuth.js';
import { tokenKey, type LaunchChain, type LaunchRecord } from './core.js';

export class MissingTableError extends Error {
  constructor() {
    super('The Launch Box tables have not been created yet (migration 0012).');
  }
}

export interface StoredLaunch extends LaunchRecord {
  indexedAt: number;
  poolDex: string | null;
  poolAddress: string | null;
  poolUrl: string | null;
  poolSeenAt: number | null;
  curveAddress: string | null;
}

export interface CursorRow {
  chain: LaunchChain;
  cursor: string | null;
  updatedAt: number;
  stats: Record<string, unknown> | null;
}

export interface LaunchStore {
  getCursor(chain: LaunchChain): Promise<CursorRow | null>;
  cursors(): Promise<CursorRow[]>;
  setCursor(chain: LaunchChain, cursor: string | null, now: number, stats: Record<string, unknown> | null): Promise<void>;
  /** Inserts the tokens that are not stored yet; one that already exists is left exactly as it is. Returns how many were new. */
  insertNew(records: readonly LaunchRecord[], now: number): Promise<number>;
  /** Which of these addresses are stored already. */
  existing(chain: LaunchChain, addresses: readonly string[]): Promise<Set<string>>;
  count(chain: LaunchChain): Promise<number>;
  /** Newest first. */
  list(limit: number): Promise<StoredLaunch[]>;
  /** Fills fields that were unknown (never overwrites a known value with null). */
  patch(chain: LaunchChain, address: string, fields: Partial<Pick<StoredLaunch, 'name' | 'symbol' | 'decimals' | 'supply' | 'creator' | 'createdAt' | 'tx' | 'poolDex' | 'poolAddress' | 'poolUrl' | 'poolSeenAt' | 'curveAddress'>>): Promise<void>;
}

interface Row {
  key: string;
  chain: LaunchChain;
  address: string;
  name: string;
  symbol: string;
  decimals: number | null;
  supply: string | null;
  creator: string | null;
  created_at: number | null;
  tx: string | null;
  source: LaunchRecord['source'];
  indexed_at: number;
  pool_dex: string | null;
  pool_address: string | null;
  pool_url: string | null;
  pool_seen_at: number | null;
  curve_address: string | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export const fromRow = (r: Row): StoredLaunch => ({
  chain: r.chain,
  address: r.address,
  name: r.name,
  symbol: r.symbol,
  decimals: num(r.decimals),
  supply: r.supply,
  creator: r.creator,
  createdAt: num(r.created_at),
  tx: r.tx,
  source: r.source,
  indexedAt: Number(r.indexed_at),
  poolDex: r.pool_dex,
  poolAddress: r.pool_address,
  poolUrl: r.pool_url,
  poolSeenAt: num(r.pool_seen_at),
  curveAddress: r.curve_address,
});

const COLUMN: Record<string, string> = { name: 'name', symbol: 'symbol', decimals: 'decimals', supply: 'supply', creator: 'creator', createdAt: 'created_at', tx: 'tx', poolDex: 'pool_dex', poolAddress: 'pool_address', poolUrl: 'pool_url', poolSeenAt: 'pool_seen_at', curveAddress: 'curve_address' };

export class SupabaseLaunchStore implements LaunchStore {
  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await this.fetchImpl(`${this.url.replace(/\/$/, '')}/rest/v1/${path}`, {
      ...init,
      headers: { ...supabaseHeaders(this.serviceKey), 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
    });
    if (!res.ok) {
      // PostgREST says 404 (PGRST205) or Postgres 42P01 when the table is not there. Status and code only: the body can echo the query.
      if (res.status === 404 || res.status === 400) {
        const text = await res.text().catch(() => '');
        if (/PGRST205|PGRST200|42P01|does not exist|schema cache/i.test(text)) throw new MissingTableError();
      }
      throw new Error(`The Launch Box database answered ${res.status}.`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async getCursor(chain: LaunchChain): Promise<CursorRow | null> {
    const rows = (await this.call(`launchbox_cursors?chain=eq.${chain}&select=chain,cursor,updated_at,stats&limit=1`)) as { chain: LaunchChain; cursor: string | null; updated_at: number; stats: Record<string, unknown> | null }[];
    const r = rows[0];
    return r ? { chain: r.chain, cursor: r.cursor, updatedAt: Number(r.updated_at), stats: r.stats } : null;
  }

  async cursors(): Promise<CursorRow[]> {
    const rows = (await this.call('launchbox_cursors?select=chain,cursor,updated_at,stats')) as { chain: LaunchChain; cursor: string | null; updated_at: number; stats: Record<string, unknown> | null }[];
    return rows.map((r) => ({ chain: r.chain, cursor: r.cursor, updatedAt: Number(r.updated_at), stats: r.stats }));
  }

  async setCursor(chain: LaunchChain, cursor: string | null, now: number, stats: Record<string, unknown> | null): Promise<void> {
    await this.call('launchbox_cursors?on_conflict=chain', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ chain, cursor, updated_at: now, stats }) });
  }

  async insertNew(records: readonly LaunchRecord[], now: number): Promise<number> {
    if (records.length === 0) return 0;
    const body = records.map((r) => ({
      key: tokenKey(r.chain, r.address),
      chain: r.chain,
      address: r.chain === 'solana' ? r.address : r.address.toLowerCase(),
      name: r.name,
      symbol: r.symbol,
      decimals: r.decimals,
      supply: r.supply,
      creator: r.creator,
      created_at: r.createdAt,
      tx: r.tx,
      source: r.source,
      indexed_at: now,
    }));
    // ignore-duplicates: a token already stored is never rewritten, so running twice (or two runs at once) adds nothing twice.
    const out = (await this.call('launchbox_tokens?on_conflict=key', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(body) })) as unknown[] | null;
    return Array.isArray(out) ? out.length : 0;
  }

  async existing(chain: LaunchChain, addresses: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (let i = 0; i < addresses.length; i += 50) {
      const list = addresses.slice(i, i + 50).map((a) => `"${(chain === 'solana' ? a : a.toLowerCase()).replace(/[^A-Za-z0-9]/g, '')}"`).join(',');
      const rows = (await this.call(`launchbox_tokens?chain=eq.${chain}&address=in.(${list})&select=address`)) as { address: string }[];
      for (const r of rows) found.add(r.address);
    }
    return found;
  }

  async count(chain: LaunchChain): Promise<number> {
    const res = await this.fetchImpl(`${this.url.replace(/\/$/, '')}/rest/v1/launchbox_tokens?chain=eq.${chain}&select=key`, { method: 'HEAD', headers: { ...supabaseHeaders(this.serviceKey), prefer: 'count=exact' } });
    if (res.status === 404) throw new MissingTableError();
    if (!res.ok) throw new Error(`The Launch Box database answered ${res.status}.`);
    const range = res.headers.get('content-range') ?? '';
    const total = /\/(\d+)$/.exec(range)?.[1];
    return total ? Number(total) : 0;
  }

  async list(limit: number): Promise<StoredLaunch[]> {
    const rows = (await this.call(`launchbox_tokens?select=*&order=created_at.desc.nullslast,indexed_at.desc&limit=${Math.max(1, Math.min(1000, Math.floor(limit)))}`)) as Row[];
    return rows.map(fromRow);
  }

  async patch(chain: LaunchChain, address: string, fields: Parameters<LaunchStore['patch']>[2]): Promise<void> {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && COLUMN[k]) body[COLUMN[k]!] = v;
    if (Object.keys(body).length === 0) return;
    await this.call(`launchbox_tokens?key=eq.${encodeURIComponent(tokenKey(chain, address))}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify(body) });
  }
}
