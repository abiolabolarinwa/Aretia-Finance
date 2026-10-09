/**
 * Aretia Token Registry: the one place token records are validated, merged and queried.
 *
 * The UI and workers talk to TokenRegistryService; the service talks to a TokenRepository. Postgres
 * (Supabase) is one repository implementation (see supabase.ts); tests use the in-memory one. Identity
 * is always `chain:address` (core/token.ts). Third-party text is untrusted and is cleaned on the way in.
 */
import { isOffensive, isUnsafeName } from './safeText.js';
import { normalizeTokenRef, tokenKey } from '../core/token.js';
import type { ChainId, RiskStatus, TokenMarket, TokenRecord, TokenRef, TokenRisk } from '../core/types.js';

/** The same record with an abusive name and its picture removed. */
export function maskIfOffensive(r: TokenRecord): TokenRecord {
  return isUnsafeName(r.symbol, r.name) ? { ...r, symbol: '[hidden]', name: 'Name hidden because it is abusive or imitates another token', logo: null } : r;
}

export interface RecentFilter {
  chain?: ChainId;
  /** Only tokens whose best-known age is at most this many hours. */
  maxAgeHours?: number;
  minLiquidityUsd?: number;
  minVolumeUsd?: number;
  riskStatuses?: RiskStatus[];
  /** Leave out tokens rated High risk or Restricted. */
  hideRisky?: boolean;
  sort?: 'newest' | 'liquidity' | 'volume';
  limit?: number;
}

export interface TokenRepository {
  get(ref: TokenRef): Promise<TokenRecord | null>;
  /** Every record with this exact address on any chain. */
  findByAddress(address: string): Promise<TokenRecord[]>;
  upsert(record: TokenRecord): Promise<void>;
  /** Case-insensitive substring match on symbol or name. */
  searchText(query: string, limit: number): Promise<TokenRecord[]>;
  /** Candidates for the New Tokens list. Filtering by age/risk is applied by the service. */
  listRecent(chain: ChainId | undefined, limit: number): Promise<TokenRecord[]>;
  /** Tokens whose snapshot is oldest (or missing), first detected after `since`, for the refresh job. */
  listForMarketRefresh?(chain: ChainId, since: number, limit: number): Promise<TokenRecord[]>;
  getCursor(source: string): Promise<string | null>;
  setCursor(source: string, cursor: string): Promise<void>;
}

/** What a discovery source (or a user adding a token) knows. Every field except the ref is optional and untrusted. */
export interface TokenCandidate {
  ref: TokenRef;
  symbol?: string | null;
  name?: string | null;
  decimals?: number | null;
  logo?: string | null;
  createdAt?: number | null;
  firstPoolAt?: number | null;
  pool?: { venue: string; address: string } | null;
  liquidityUsd?: number | null;
  volume24hUsd?: number | null;
  holderCount?: number | null;
  /** Market numbers read with the pool, kept as the token's snapshot. */
  market?: TokenMarket | null;
  source: string;
  /** True when decimals/name came from the chain itself rather than an API. */
  onchain?: boolean;
}

/** Strips control characters and bidi overrides, collapses whitespace, caps length. Rendered as text only. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Only https images; anything else (data:, javascript:, http:) is dropped. */
export function cleanLogo(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export interface AgeInfo {
  ms: number;
  /** What the age is measured from. 'detected' means only that Aretia saw it then: not a claim about creation. */
  basis: 'created' | 'first-pool' | 'detected';
}

export function ageInfo(r: Pick<TokenRecord, 'createdAt' | 'firstPoolAt' | 'firstDetectedAt'>, now: number): AgeInfo {
  if (r.createdAt !== null) return { ms: Math.max(0, now - r.createdAt), basis: 'created' };
  if (r.firstPoolAt !== null) return { ms: Math.max(0, now - r.firstPoolAt), basis: 'first-pool' };
  return { ms: Math.max(0, now - r.firstDetectedAt), basis: 'detected' };
}

export interface SearchResult {
  record: TokenRecord;
  /** True when another distinct token shares this symbol: the UI must show the address. */
  symbolCollision: boolean;
}

export class TokenRegistryService {
  constructor(
    private readonly repo: TokenRepository,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Validates and merges a candidate. Returns null if the token identity is malformed. Existing facts
   * are kept: first detection time and source never move, and on-chain metadata is not overwritten by API text.
   */
  async ingest(candidate: TokenCandidate): Promise<TokenRecord | null> {
    const ref = normalizeTokenRef(candidate.ref.chain, candidate.ref.address);
    if (!ref) return null;
    const existing = await this.repo.get(ref);
    const now = this.now();

    const decimals = typeof candidate.decimals === 'number' && Number.isInteger(candidate.decimals) && candidate.decimals >= 0 && candidate.decimals <= 36 ? candidate.decimals : null;
    const keepOnchain = existing?.metadataConfidence === 'onchain' && !candidate.onchain;
    const symbol = cleanText(candidate.symbol, 24) || existing?.symbol || ref.address.slice(0, 6);
    const name = cleanText(candidate.name, 64) || existing?.name || '';

    const pools = [...(existing?.pools ?? [])];
    if (candidate.pool && !pools.some((p) => p.address === candidate.pool!.address)) pools.push({ venue: cleanText(candidate.pool.venue, 32), address: candidate.pool.address.slice(0, 64) });

    const firstPoolAt = minDefined(existing?.firstPoolAt, finiteOrNull(candidate.firstPoolAt));
    const record: TokenRecord = {
      ref,
      symbol: keepOnchain ? existing!.symbol : symbol,
      name: keepOnchain ? existing!.name : name,
      decimals: keepOnchain ? existing!.decimals : (decimals ?? existing?.decimals ?? 0),
      logo: cleanLogo(candidate.logo) ?? existing?.logo ?? null,
      firstDetectedAt: existing?.firstDetectedAt ?? now,
      discoverySource: existing?.discoverySource ?? cleanText(candidate.source, 40),
      createdAt: existing?.createdAt ?? finiteOrNull(candidate.createdAt),
      firstPoolAt,
      discoveryStatus: pools.length > 0 ? 'tradable' : (existing?.discoveryStatus ?? 'discovered'),
      liquidityUsd: finiteOrNull(candidate.liquidityUsd) ?? existing?.liquidityUsd ?? null,
      volume24hUsd: finiteOrNull(candidate.volume24hUsd) ?? existing?.volume24hUsd ?? null,
      holderCount: finiteOrNull(candidate.holderCount) ?? existing?.holderCount ?? null,
      pools: pools.slice(0, 20),
      metadata: existing?.metadata ?? {},
      verified: existing?.verified ?? false,
      metadataConfidence: candidate.onchain || existing?.metadataConfidence === 'onchain' ? 'onchain' : decimals !== null ? 'api' : (existing?.metadataConfidence ?? 'unknown'),
      risk: existing?.risk ?? null,
      market: candidate.market ?? existing?.market ?? null,
      updatedAt: now,
    };
    await this.repo.upsert(record);
    return record;
  }

  /** Stores a fresh market snapshot on an existing record. */
  async setMarket(ref: TokenRef, market: TokenMarket): Promise<void> {
    const r = await this.repo.get(ref);
    if (r) await this.repo.upsert({ ...r, market, volume24hUsd: market.volume24hUsd ?? r.volume24hUsd, liquidityUsd: market.liquidityUsd ?? r.liquidityUsd, updatedAt: this.now() });
  }

  /** Stores a risk assessment (and any contract facts) on an existing record. */
  async attachRisk(ref: TokenRef, risk: TokenRisk, metadata: TokenRecord['metadata'] = {}): Promise<void> {
    const r = await this.repo.get(ref);
    if (!r) return;
    await this.repo.upsert({ ...r, risk, metadata: { ...r.metadata, ...metadata }, updatedAt: this.now() });
  }

  /**
   * Universal search. An address (Solana mint or 0x contract) is matched exactly on every chain it could
   * belong to. Text matches symbol or name, and any symbol shared by different tokens is flagged.
   */
  async search(query: string, limit = 20): Promise<SearchResult[]> {
    const q = cleanText(query, 80);
    if (q.length < 2) return [];
    // Searching for an abusive word finds nothing, so the list cannot be used to pull abusive names up.
    if (isOffensive(q)) return [];
    const asAddress = /^0x[0-9a-fA-F]{40}$/.test(q) ? q.toLowerCase() : q;
    const exact = await this.repo.findByAddress(asAddress);
    const records = exact.length > 0 ? exact : await this.repo.searchText(q, limit);
    // An abusive token reached by its exact address is shown with its name masked: the address is the user's own choice.
    const shown = (exact.length > 0 ? records.map(maskIfOffensive) : records.filter((r) => !isUnsafeName(r.symbol, r.name))).slice(0, limit);
    // A collision is judged against the whole registry, not just this page of results.
    const out: SearchResult[] = [];
    for (const record of shown) {
      const same = (await this.repo.searchText(record.symbol, 50)).filter((r) => r.symbol.toLowerCase() === record.symbol.toLowerCase());
      out.push({ record, symbolCollision: new Set(same.map((r) => tokenKey(r.ref))).size > 1 });
    }
    return out;
  }

  /** The New Tokens list. Discovery is not endorsement: nothing here ranks by "quality". */
  async listNew(filter: RecentFilter = {}): Promise<TokenRecord[]> {
    const now = this.now();
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 1000);
    const rows = await this.repo.listRecent(filter.chain, 1000);
    const kept = rows.filter((r) => {
      if (isUnsafeName(r.symbol, r.name)) return false;
      if (filter.hideRisky && (r.risk?.status === 'high' || r.risk?.status === 'restricted')) return false;
      if (filter.maxAgeHours !== undefined && ageInfo(r, now).ms > filter.maxAgeHours * 3_600_000) return false;
      if (filter.minLiquidityUsd !== undefined && (r.liquidityUsd ?? 0) < filter.minLiquidityUsd) return false;
      if (filter.minVolumeUsd !== undefined && (r.volume24hUsd ?? 0) < filter.minVolumeUsd) return false;
      if (filter.riskStatuses && !filter.riskStatuses.includes(r.risk?.status ?? 'unknown')) return false;
      return true;
    });
    const sort = filter.sort ?? 'newest';
    kept.sort((a, b) => (sort === 'liquidity' ? (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0) : sort === 'volume' ? (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0) : ageInfo(a, now).ms - ageInfo(b, now).ms));
    return kept.slice(0, limit);
  }
}

function minDefined(a: number | null | undefined, b: number | null): number | null {
  const xs = [a, b].filter((x): x is number => typeof x === 'number');
  return xs.length > 0 ? Math.min(...xs) : null;
}

export class InMemoryTokenRepository implements TokenRepository {
  private readonly rows = new Map<string, TokenRecord>();
  private readonly cursors = new Map<string, string>();

  async get(ref: TokenRef): Promise<TokenRecord | null> {
    return this.rows.get(tokenKey(ref)) ?? null;
  }
  async findByAddress(address: string): Promise<TokenRecord[]> {
    return [...this.rows.values()].filter((r) => r.ref.address === address);
  }
  async upsert(record: TokenRecord): Promise<void> {
    this.rows.set(tokenKey(record.ref), structuredClone(record));
  }
  async searchText(query: string, limit: number): Promise<TokenRecord[]> {
    const q = query.toLowerCase();
    return [...this.rows.values()].filter((r) => r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)).slice(0, limit);
  }
  async listForMarketRefresh(chain: ChainId, since: number, limit: number): Promise<TokenRecord[]> {
    return [...this.rows.values()].filter((r) => r.ref.chain === chain && r.firstDetectedAt >= since).sort((a, b) => (a.market?.at ?? 0) - (b.market?.at ?? 0)).slice(0, limit);
  }
  async listRecent(chain: ChainId | undefined, limit: number): Promise<TokenRecord[]> {
    return [...this.rows.values()].filter((r) => !chain || r.ref.chain === chain).sort((a, b) => b.firstDetectedAt - a.firstDetectedAt).slice(0, limit);
  }
  async getCursor(source: string): Promise<string | null> {
    return this.cursors.get(source) ?? null;
  }
  async setCursor(source: string, cursor: string): Promise<void> {
    this.cursors.set(source, cursor);
  }
}
