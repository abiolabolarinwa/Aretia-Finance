/**
 * The Marketplace's data: GeckoTerminal's public pool lists (trending, top by volume, newest), read into table rows.
 * Only networks Swings supports are kept, abusive names are dropped, and anything a pool does not report stays null.
 *
 * The public service allows about 30 requests a minute per visitor, so answers are reused for a minute and the
 * all-networks views ask each network once.
 */
import { GECKO_NETWORK } from '../charts/pool.js';
import { CHAIN_IDS, SwingsError, type ChainId } from '../core/types.js';
import { isUnsafeName } from '../tokens/safeText.js';
import type { Changes, MarketRow } from './types.js';

export type MarketKind = 'trending' | 'top' | 'gainers' | 'new';
export type Window = 'm5' | 'h1' | 'h6' | 'h24';
const DURATION: Record<Window, string> = { m5: '5m', h1: '1h', h6: '6h', h24: '24h' };

const NETWORK_TO_CHAIN = new Map<string, ChainId>(CHAIN_IDS.map((c) => [GECKO_NETWORK[c], c]));

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const clean = (v: unknown, max: number): string => (typeof v === 'string' ? [...v].filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127).join('').trim().slice(0, max) : '');

interface Pool {
  attributes?: {
    name?: string;
    address?: string;
    base_token_price_usd?: string | number;
    fdv_usd?: string | number | null;
    market_cap_usd?: string | number | null;
    price_change_percentage?: Partial<Record<Window, string | number>>;
    transactions?: Partial<Record<Window, { buys?: number; sells?: number; buyers?: number; sellers?: number }>>;
    volume_usd?: Partial<Record<Window, string | number>>;
    reserve_in_usd?: string | number;
    pool_created_at?: string;
  };
  relationships?: { base_token?: { data?: { id?: string } }; network?: { data?: { id?: string } } };
}
interface Token {
  id?: string;
  type?: string;
  attributes?: { address?: string; name?: string; symbol?: string; decimals?: number; image_url?: string | null };
}

/** Reads one GeckoTerminal pool-list answer into rows. Pure. */
export function parseGeckoPools(body: unknown, now: number): MarketRow[] {
  const b = body as { data?: Pool[]; included?: Token[] } | null;
  if (!b || !Array.isArray(b.data)) return [];
  const tokens = new Map<string, Token>();
  for (const t of b.included ?? []) if (t?.type === 'token' && typeof t.id === 'string') tokens.set(t.id, t);
  const rows: MarketRow[] = [];
  for (const p of b.data) {
    const a = p.attributes;
    const tokenId = String(p.relationships?.base_token?.data?.id ?? '');
    // Some lists name the network on each pool, some do not; the token's own id always starts with it.
    const chain = NETWORK_TO_CHAIN.get(String(p.relationships?.network?.data?.id ?? '')) ?? [...NETWORK_TO_CHAIN].find(([id]) => tokenId.startsWith(`${id}_`))?.[1];
    const token = tokens.get(tokenId);
    const address = token?.attributes?.address;
    const pool = a?.address;
    if (!a || !chain || !token || typeof address !== 'string' || typeof pool !== 'string' || !/^[A-Za-z0-9]{20,}$/.test(pool)) continue;
    if (chain !== 'solana' && !/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
    const [first, second] = clean(a.name, 80).split(' / ');
    const symbol = clean(token.attributes?.symbol, 20) || clean(first, 20);
    const name = clean(token.attributes?.name, 60);
    const quoteSymbol = clean((second ?? '').split(' ')[0], 20);
    if (!symbol || isUnsafeName(symbol, name)) continue;
    const tx = (w: Window): { buys?: number; sells?: number; buyers?: number; sellers?: number } | undefined => a.transactions?.[w];
    const t24 = tx('h24');
    const created = typeof a.pool_created_at === 'string' ? Date.parse(a.pool_created_at) : NaN;
    const change: Changes = { m5: num(a.price_change_percentage?.m5), h1: num(a.price_change_percentage?.h1), h6: num(a.price_change_percentage?.h6), h24: num(a.price_change_percentage?.h24) };
    const image = token.attributes?.image_url;
    const dec = token.attributes?.decimals;
    const price = num(a.base_token_price_usd);
    rows.push({
      chain,
      address,
      symbol,
      quoteSymbol,
      name,
      icon: typeof image === 'string' && /^https:\/\//.test(image) && image.length < 500 ? image : null,
      decimals: typeof dec === 'number' && Number.isInteger(dec) && dec >= 0 && dec <= 36 ? dec : null,
      pool,
      priceUsd: price !== null && price > 0 ? price : null,
      capUsd: num(a.market_cap_usd) ?? num(a.fdv_usd),
      ageMs: Number.isFinite(created) ? Math.max(0, now - created) : null,
      txns24h: typeof t24?.buys === 'number' && typeof t24?.sells === 'number' ? t24.buys + t24.sells : null,
      volume24hUsd: num(a.volume_usd?.h24),
      traders24h: typeof t24?.buyers === 'number' && typeof t24?.sellers === 'number' ? t24.buyers + t24.sellers : null,
      change,
      liquidityUsd: num(a.reserve_in_usd),
      risk: null,
      fresh: false,
    });
  }
  return rows;
}

export interface MarketQuery {
  kind: MarketKind;
  /** '' means every supported network. */
  chain: ChainId | '';
  window: Window;
  /** GeckoTerminal's page of 20 pools; it serves pages 1 to 10. */
  page?: number;
}

export class GeckoMarket {
  private readonly cache = new Map<string, { at: number; rows: MarketRow[] }>();

  constructor(
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 60_000,
    private readonly base = 'https://api.geckoterminal.com/api/v2',
  ) {}

  private async list(path: string, signal?: AbortSignal): Promise<MarketRow[]> {
    const hit = this.cache.get(path);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.rows;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { headers: { accept: 'application/json' }, signal });
    } catch {
      throw new SwingsError('provider-failed', 'The market service could not be reached. It may be busy; try again in a minute.');
    }
    if (!res.ok) throw new SwingsError('provider-failed', res.status === 429 ? 'The market service is busy. Try again in a minute.' : `The market service answered ${res.status}.`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new SwingsError('provider-failed', 'The market service returned something unreadable.');
    }
    const rows = parseGeckoPools(body, this.now());
    this.cache.set(path, { at: this.now(), rows });
    return rows;
  }

  async load(q: MarketQuery, signal?: AbortSignal): Promise<MarketRow[]> {
    const inc = 'include=base_token';
    const page = Math.min(Math.max(Math.floor(q.page ?? 1), 1), 10);
    const networks = q.chain ? [GECKO_NETWORK[q.chain]] : [];
    let rows: MarketRow[];
    if (q.kind === 'trending') {
      rows = q.chain ? await this.list(`/networks/${networks[0]}/trending_pools?${inc}&duration=${DURATION[q.window]}&page=${page}`, signal) : await this.list(`/networks/trending_pools?${inc}&duration=${DURATION[q.window]}&page=${page}`, signal);
    } else if (q.kind === 'new') {
      rows = q.chain ? await this.list(`/networks/${networks[0]}/new_pools?${inc}&page=${page}`, signal) : await this.list(`/networks/new_pools?${inc}&page=${page}`, signal);
    } else {
      // Top and Gainers start from the busiest pools. With no network chosen, each supported network is asked once.
      const nets = q.chain ? networks : CHAIN_IDS.map((c) => GECKO_NETWORK[c]);
      const lists = await Promise.allSettled(nets.map((n) => this.list(`/networks/${n}/pools?${inc}&sort=h24_volume_usd_desc&page=${page}`, signal)));
      const ok = lists.filter((l): l is PromiseFulfilledResult<MarketRow[]> => l.status === 'fulfilled');
      if (ok.length === 0) throw (lists[0] as PromiseRejectedResult).reason;
      rows = ok.flatMap((l) => l.value);
      rows.sort((a, b) => (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1));
      if (q.kind === 'gainers') rows = rows.filter((r) => (r.liquidityUsd ?? 0) >= 10_000 && (r.volume24hUsd ?? 0) >= 10_000).sort((a, b) => (b.change[q.window] ?? -Infinity) - (a.change[q.window] ?? -Infinity));
    }
    // A token can appear in several pools; the first (best-ranked) pool stands for it.
    const seen = new Set<string>();
    return rows.filter((r) => {
      const k = `${r.chain}:${r.chain === 'solana' ? r.address : r.address.toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
}
