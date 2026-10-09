/**
 * TokenRepository over Supabase's PostgREST API, using plain fetch (no SDK dependency). Server-side
 * only: it needs the service-role key, which must never reach the browser. See
 * supabase/migrations/0001_token_registry.sql for the schema.
 */
import { CHAINS, type ChainId, type TokenMarket, type TokenRecord, type TokenRef } from '../core/types.js';
import { tokenKey } from '../core/token.js';
import type { TokenRepository } from './registry.js';

interface Row {
  key: string;
  chain: ChainId;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logo: string | null;
  first_detected_at: number;
  discovery_source: string;
  created_at_chain: number | null;
  first_pool_at: number | null;
  discovery_status: 'discovered' | 'tradable';
  liquidity_usd: number | null;
  volume_24h_usd: number | null;
  holder_count: number | null;
  pools: TokenRecord['pools'];
  metadata: TokenRecord['metadata'];
  verified: boolean;
  metadata_confidence: TokenRecord['metadataConfidence'];
  risk: TokenRecord['risk'];
  risk_status: string | null;
  risk_score: number | null;
  market?: TokenMarket | null;
  market_at?: number | null;
  updated_at: number;
}

export const toRow = (r: TokenRecord): Row => ({
  key: tokenKey(r.ref),
  chain: r.ref.chain,
  address: r.ref.address,
  symbol: r.symbol,
  name: r.name,
  decimals: r.decimals,
  logo: r.logo,
  first_detected_at: r.firstDetectedAt,
  discovery_source: r.discoverySource,
  created_at_chain: r.createdAt,
  first_pool_at: r.firstPoolAt,
  discovery_status: r.discoveryStatus,
  liquidity_usd: r.liquidityUsd,
  volume_24h_usd: r.volume24hUsd,
  holder_count: r.holderCount,
  pools: r.pools,
  metadata: r.metadata,
  verified: r.verified,
  metadata_confidence: r.metadataConfidence,
  risk: r.risk,
  risk_status: r.risk?.status ?? null,
  risk_score: r.risk?.score ?? null,
  ...(r.market ? { market: r.market, market_at: r.market.at } : {}),
  updated_at: r.updatedAt,
});

export const fromRow = (w: Row): TokenRecord => ({
  ref: { chain: w.chain, address: w.address },
  symbol: w.symbol,
  name: w.name,
  decimals: w.decimals,
  logo: w.logo,
  firstDetectedAt: Number(w.first_detected_at),
  discoverySource: w.discovery_source,
  createdAt: w.created_at_chain === null ? null : Number(w.created_at_chain),
  firstPoolAt: w.first_pool_at === null ? null : Number(w.first_pool_at),
  discoveryStatus: w.discovery_status,
  liquidityUsd: w.liquidity_usd,
  volume24hUsd: w.volume_24h_usd,
  holderCount: w.holder_count,
  pools: w.pools ?? [],
  metadata: w.metadata ?? {},
  verified: w.verified,
  metadataConfidence: w.metadata_confidence,
  risk: w.risk,
  market: w.market ?? null,
  updatedAt: Number(w.updated_at),
});

/** Escapes a value for use inside a PostgREST `ilike` filter. */
const likeEscape = (s: string): string => s.replace(/[\\%_*(),]/g, (c) => `\\${c}`);

import { supabaseHeaders } from './supabaseAuth.js';

export class SupabaseTokenRepository implements TokenRepository {
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
    // Status only: the body can echo the query or the project, so it is never surfaced.
    if (!res.ok) throw new Error(`The token database answered ${res.status}.`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  private async rows(path: string): Promise<TokenRecord[]> {
    const data = (await this.call(path)) as Row[];
    return data.map(fromRow);
  }

  async get(ref: TokenRef): Promise<TokenRecord | null> {
    return (await this.rows(`token_registry?key=eq.${encodeURIComponent(tokenKey(ref))}&limit=1`))[0] ?? null;
  }
  findByAddress(address: string): Promise<TokenRecord[]> {
    return this.rows(`token_registry?address=eq.${encodeURIComponent(address)}&limit=10`);
  }
  async upsert(record: TokenRecord): Promise<void> {
    const post = (row: unknown): Promise<unknown> => this.call('token_registry?on_conflict=key', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
    try {
      await post(toRow(record));
    } catch (e) {
      // Before the market columns exist (migration 0006) the database refuses them; the token is still saved without.
      if (!record.market || !(e instanceof Error) || !/answered 400/.test(e.message)) throw e;
      await post(toRow({ ...record, market: null }));
    }
  }
  listForMarketRefresh(chain: ChainId, since: number, limit: number): Promise<TokenRecord[]> {
    return this.rows(`token_registry?chain=eq.${chain}&first_detected_at=gte.${Math.floor(since)}&order=market_at.asc.nullsfirst&limit=${limit}`);
  }
  searchText(query: string, limit: number): Promise<TokenRecord[]> {
    const q = encodeURIComponent(`*${likeEscape(query)}*`);
    return this.rows(`token_registry?or=(symbol.ilike.${q},name.ilike.${q})&order=liquidity_usd.desc.nullslast&limit=${limit}`);
  }
  listRecent(chain: ChainId | undefined, limit: number): Promise<TokenRecord[]> {
    const filter = chain && chain in CHAINS ? `chain=eq.${chain}&` : '';
    return this.rows(`token_registry?${filter}order=first_detected_at.desc&limit=${limit}`);
  }
  async getCursor(source: string): Promise<string | null> {
    const data = (await this.call(`discovery_cursors?source=eq.${encodeURIComponent(source)}&select=cursor&limit=1`)) as { cursor: string }[];
    return data[0]?.cursor ?? null;
  }
  async setCursor(source: string, cursor: string): Promise<void> {
    await this.call('discovery_cursors?on_conflict=source', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ source, cursor, updated_at: Date.now() }) });
  }
}
