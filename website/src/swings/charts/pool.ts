/**
 * Which pool a token's chart should show, and what the header says about it. The chart itself is GeckoTerminal's
 * embedded TradingView chart (candles, indicators, trades), the same one the Trade tab shows; this module finds the
 * pool to embed and reads its price, 24h change, volume, liquidity and trade count for the header.
 *
 * Choosing the pool is the part that needs care. A pool's reported liquidity is self-reported and can be inflated by a
 * made-up token on the other side, so pools paired with a major token (a main stablecoin or the wrapped native coin)
 * come first, and only then does depth decide. Without that, SOL's chart picked a memecoin pool that claimed $180M.
 *
 * Only the token's address goes to the price service. Nothing about the wallet does.
 */
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type ChainId } from '../core/types.js';
import { HUB_TOKENS } from '../dex/hubs.js';

/** GeckoTerminal's network ids. */
export const GECKO_NETWORK: Readonly<Record<ChainId, string>> = { solana: 'solana', ethereum: 'eth', bnb: 'bsc', polygon: 'polygon_pos', base: 'base', arbitrum: 'arbitrum', optimism: 'optimism', avalanche: 'avax', robinhood: 'robinhood' };

export interface PoolInfo {
  network: string;
  pool: string;
  poolName: string;
  /** Price of the token itself, in US dollars. */
  priceUsd: number | null;
  change24h: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  trades24h: number | null;
  /** First token of the drawn pair (the chart prices this one) and the second. Set when the chart comes from DexScreener. */
  baseSymbol?: string;
  quoteSymbol?: string;
  /** True when the token being looked at is the pair's first token, so the chart shows the token itself. */
  targetIsBase?: boolean;
  /** The first token's picture. */
  icon?: string | null;
}

export interface GeckoPool {
  attributes?: {
    address?: string;
    name?: string;
    reserve_in_usd?: string | number;
    base_token_price_usd?: string | number;
    quote_token_price_usd?: string | number;
    price_change_percentage?: { h24?: string | number };
    volume_usd?: { h24?: string | number };
    transactions?: { h24?: { buys?: number; sells?: number } };
  };
  relationships?: { base_token?: { data?: { id?: string } }; quote_token?: { data?: { id?: string } } };
}

const SOLANA_MAJORS = ['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'];
export const majorsOf = (chain: ChainId): Set<string> => new Set((chain === 'solana' ? SOLANA_MAJORS : (HUB_TOKENS[chain] ?? []).map((h) => h.address)).map((a) => a.toLowerCase()));

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** Picks the pool whose price means most for this token, or null when none is usable. Pure. */
export function pickPool(chain: ChainId, address: string, pools: GeckoPool[]): PoolInfo | null {
  const network = GECKO_NETWORK[chain];
  const token = address.toLowerCase();
  const majors = majorsOf(chain);
  const idOf = (v: string | undefined): string => (v ?? '').toLowerCase().replace(`${network}_`, '');
  const ranked = pools
    .map((p, order) => {
      const base = idOf(p.relationships?.base_token?.data?.id);
      const quote = idOf(p.relationships?.quote_token?.data?.id);
      const isBase = base === token;
      const other = isBase ? quote : base;
      return { p, order, isBase, liq: num(p.attributes?.reserve_in_usd), paired: majors.has(other), involved: isBase || quote === token };
    })
    .filter((x) => x.involved && typeof x.p.attributes?.address === 'string' && /^[A-Za-z0-9]{20,}$/.test(x.p.attributes.address))
    .sort((a, b) => (a.paired === b.paired ? 0 : a.paired ? -1 : 1) || (b.liq ?? -1) - (a.liq ?? -1) || a.order - b.order);
  const best = ranked[0];
  if (!best) return null;
  const a = best.p.attributes!;
  const price = num(best.isBase ? a.base_token_price_usd : a.quote_token_price_usd);
  const buys = a.transactions?.h24?.buys;
  const sells = a.transactions?.h24?.sells;
  return {
    network,
    pool: a.address!,
    poolName: a.name ?? 'pool',
    priceUsd: price !== null && price > 0 ? price : null,
    change24h: num(a.price_change_percentage?.h24),
    volume24hUsd: num(a.volume_usd?.h24),
    liquidityUsd: best.liq,
    trades24h: typeof buys === 'number' && typeof sells === 'number' ? buys + sells : null,
  };
}

/** DexScreener's names for the networks. */
export const DEXSCREENER_CHAIN: Readonly<Record<ChainId, string>> = { solana: 'solana', ethereum: 'ethereum', bnb: 'bsc', polygon: 'polygon', base: 'base', arbitrum: 'arbitrum', optimism: 'optimism', avalanche: 'avalanche', robinhood: 'robinhood' };

/**
 * The chart the wallet shows for now: DexScreener's embedded chart and trades for a pool, in the same light style the
 * Trade tab uses. (Aretia's own TradingView chart will replace it when it is ready.)
 */
export function dexScreenerEmbedUrl(chain: ChainId, pool: string, interval = '15', opts: { toolbar?: boolean } = {}): string {
  const q = new URLSearchParams({ embed: '1', theme: 'light', chartTheme: 'light', trades: '1', info: '0', tabs: '0', chartLeftToolbar: opts.toolbar ? '1' : '0', loadChartSettings: '0', chartStyle: '1', chartType: 'usd', interval });
  return `https://dexscreener.com/${DEXSCREENER_CHAIN[chain]}/${encodeURIComponent(pool)}?${q}`;
}

/** GeckoTerminal's own TradingView chart (kept for tests and as a fallback), with its trades table and no info panel. */
export function embedUrl(info: Pick<PoolInfo, 'network' | 'pool'>, resolution = '15m'): string {
  return `https://www.geckoterminal.com/${info.network}/pools/${encodeURIComponent(info.pool)}?${new URLSearchParams({ embed: '1', info: '0', swaps: '1', grayscale: '0', light_chart: '1', chart_type: 'price', resolution })}`;
}

export class GeckoPoolFinder {
  /** The service allows about 30 requests a minute per visitor. Recent answers are reused for a short while. */
  private readonly cache = new Map<string, { at: number; info: PoolInfo }>();

  constructor(
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly base = 'https://api.geckoterminal.com/api/v2',
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 20_000,
  ) {}

  async find(chain: ChainId, address: string, signal?: AbortSignal, fresh = false): Promise<PoolInfo> {
    const ref = normalizeTokenRef(chain, address);
    if (!ref) throw new SwingsError('invalid', 'That is not a valid token address.');
    const key = `${chain}:${ref.address}`;
    const hit = this.cache.get(key);
    if (hit && !fresh && this.now() - hit.at < this.ttlMs) return hit.info;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/networks/${GECKO_NETWORK[chain]}/tokens/${encodeURIComponent(ref.address)}/pools?page=1`, { headers: { accept: 'application/json' }, signal });
    } catch {
      throw new SwingsError('provider-failed', 'The price service could not be reached. It may be busy; try again in a minute.');
    }
    if (res.status === 404) throw new SwingsError('no-route', 'No trading pool was found for this token.');
    if (!res.ok) throw new SwingsError('provider-failed', res.status === 429 ? 'The price service is busy. Try again in a minute.' : `The price service answered ${res.status}.`);
    let body: { data?: GeckoPool[] };
    try {
      body = (await res.json()) as { data?: GeckoPool[] };
    } catch {
      throw new SwingsError('provider-failed', 'The price service returned something unreadable.');
    }
    const info = pickPool(chain, ref.address, Array.isArray(body.data) ? body.data : []);
    if (!info) throw new SwingsError('no-route', 'No trading pool was found for this token.');
    this.cache.set(key, { at: this.now(), info });
    return info;
  }
}
