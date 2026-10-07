/**
 * Price history for the charts. A chart needs candles (open, high, low, close, volume per period); this module is
 * the one place that fetches them and the one place that decides whether they can be trusted enough to draw.
 *
 * `CandleSource` is the seam. Today the only source is GeckoTerminal's public OHLCV endpoint for the token's deepest
 * pool, because building Aretia's own candle history needs an indexer that stores every swap, and that does not exist
 * yet. When it does, it plugs in here without touching the chart. Until then the screen says plainly where the data
 * comes from.
 *
 * What it refuses to draw: non-numbers, negative prices, candles whose high is below their low or whose open/close
 * fall outside them, and duplicate or out-of-order times (the chart library rejects those, and GeckoTerminal does
 * return duplicate timestamps for some pools). Bad candles are dropped, not "fixed".
 */
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type ChainId } from '../core/types.js';
import { HUB_TOKENS } from '../dex/hubs.js';

export interface Candle {
  /** Unix seconds at the start of the period. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Volume in the quote currency of the request (US dollars here). */
  volume: number;
}

export type TimeframeId = '15m' | '1h' | '4h' | '1d';

export const TIMEFRAMES: Readonly<Record<TimeframeId, { label: string; unit: 'minute' | 'hour' | 'day'; aggregate: number; limit: number }>> = {
  '15m': { label: '15m', unit: 'minute', aggregate: 15, limit: 192 },
  '1h': { label: '1h', unit: 'hour', aggregate: 1, limit: 168 },
  '4h': { label: '4h', unit: 'hour', aggregate: 4, limit: 180 },
  '1d': { label: '1D', unit: 'day', aggregate: 1, limit: 180 },
};

export interface CandleSeries {
  candles: Candle[];
  /** The pool the prices come from, so the screen can say what it is showing. */
  pool: string;
  poolName: string;
  liquidityUsd: number | null;
  source: string;
}

export interface CandleSource {
  readonly id: string;
  candles(chain: ChainId, address: string, timeframe: TimeframeId, signal?: AbortSignal): Promise<CandleSeries>;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Turns a raw OHLCV list ([time, open, high, low, close, volume] rows, any order) into candles the chart can draw:
 * valid rows only, oldest first, one per time.
 */
export function parseOhlcv(list: unknown): Candle[] {
  if (!Array.isArray(list)) return [];
  const byTime = new Map<number, Candle>();
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [time, open, high, low, close, volume] = row as unknown[];
    if (!finite(time) || !finite(open) || !finite(high) || !finite(low) || !finite(close) || !finite(volume)) continue;
    if (!Number.isInteger(time) || time <= 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) continue;
    if (high < low || open > high || open < low || close > high || close < low) continue;
    // Some pools return the same period twice; the later row in the list is kept so the result is deterministic.
    byTime.set(time, { time, open, high, low, close, volume });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Change from the first candle's open to the last candle's close, in percent. Null when there is nothing to compare. */
export function priceChangePercent(candles: Candle[]): number | null {
  const first = candles[0];
  const last = candles[candles.length - 1];
  return first && last && first.open > 0 ? ((last.close - first.open) / first.open) * 100 : null;
}

/** GeckoTerminal's network ids. */
export const GECKO_NETWORK: Readonly<Record<ChainId, string>> = { solana: 'solana', ethereum: 'eth', bnb: 'bsc', polygon: 'polygon_pos', base: 'base', arbitrum: 'arbitrum', optimism: 'optimism', avalanche: 'avax' };

interface GeckoPool {
  attributes?: { address?: string; name?: string; reserve_in_usd?: string | number };
  relationships?: { base_token?: { data?: { id?: string } }; quote_token?: { data?: { id?: string } } };
}

/** Tokens a price is meaningfully measured against: the chain's main stablecoins and wrapped native coin. */
const SOLANA_MAJORS = ['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'];
const majorsOf = (chain: ChainId): Set<string> => new Set((chain === 'solana' ? SOLANA_MAJORS : (HUB_TOKENS[chain] ?? []).map((h) => h.address)).map((a) => a.toLowerCase()));

export class GeckoTerminalCandles implements CandleSource {
  readonly id = 'geckoterminal';
  /** The service allows about 30 requests a minute per visitor, and a chart makes two. Recent answers are reused for a minute. */
  private readonly cache = new Map<string, { at: number; series: CandleSeries }>();

  constructor(
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly base = 'https://api.geckoterminal.com/api/v2',
    private readonly now: () => number = Date.now,
  ) {}

  private async json(url: string, signal?: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { accept: 'application/json' }, signal });
    } catch {
      throw new SwingsError('provider-failed', 'The price history service could not be reached. It may be busy; try again in a minute.');
    }
    if (res.status === 404) throw new SwingsError('no-route', 'No price history was found for this token.');
    if (!res.ok) throw new SwingsError('provider-failed', res.status === 429 ? 'The price history service is busy. Try again in a minute.' : `The price history service answered ${res.status}.`);
    try {
      return await res.json();
    } catch {
      throw new SwingsError('provider-failed', 'The price history service returned something unreadable.');
    }
  }

  async candles(chain: ChainId, address: string, timeframe: TimeframeId, signal?: AbortSignal): Promise<CandleSeries> {
    const ref = normalizeTokenRef(chain, address);
    if (!ref) throw new SwingsError('invalid', 'That is not a valid token address.');
    const tf = TIMEFRAMES[timeframe];
    if (!tf) throw new SwingsError('invalid', 'Unknown timeframe.');
    const cacheKey = `${chain}:${ref.address}:${timeframe}`;
    const hit = this.cache.get(cacheKey);
    if (hit && this.now() - hit.at < 60_000) return hit.series;
    const network = GECKO_NETWORK[chain];
    // The pool whose price means most. A pool's reported liquidity is self-reported and can be inflated by a made-up
    // token on the other side, so pools paired with a major token (a stablecoin or the wrapped native coin) come first,
    // and only then does depth decide.
    const majors = majorsOf(chain);
    const pools = ((await this.json(`${this.base}/networks/${network}/tokens/${encodeURIComponent(ref.address)}/pools?page=1`, signal)) as { data?: GeckoPool[] }).data ?? [];
    const idOf = (v: string | undefined): string => (v ?? '').toLowerCase().replace(`${network}_`, '');
    const ranked = pools
      .map((p, order) => {
        const base = idOf(p.relationships?.base_token?.data?.id);
        const quote = idOf(p.relationships?.quote_token?.data?.id);
        const other = base === ref.address.toLowerCase() ? quote : base;
        return { p, order, liq: Number(p.attributes?.reserve_in_usd), paired: majors.has(other) };
      })
      .filter((x) => typeof x.p.attributes?.address === 'string' && /^[A-Za-z0-9]{20,}$/.test(x.p.attributes.address))
      .sort((a, b) => (a.paired === b.paired ? 0 : a.paired ? -1 : 1) || (Number.isFinite(b.liq) ? b.liq : -1) - (Number.isFinite(a.liq) ? a.liq : -1) || a.order - b.order);
    const best = ranked[0];
    if (!best) throw new SwingsError('no-route', 'No trading pool with price history was found for this token.');
    const poolAddress = best.p.attributes!.address!;
    // Prices are quoted for the token itself: the pool's base side, or its quote side when the token is the quote.
    const baseId = (best.p.relationships?.base_token?.data?.id ?? '').toLowerCase();
    const side = baseId === `${network}_${ref.address}`.toLowerCase() ? 'base' : 'quote';
    const url = `${this.base}/networks/${network}/pools/${encodeURIComponent(poolAddress)}/ohlcv/${tf.unit}?aggregate=${tf.aggregate}&limit=${tf.limit}&currency=usd&token=${side}`;
    const body = (await this.json(url, signal)) as { data?: { attributes?: { ohlcv_list?: unknown } } };
    const candles = parseOhlcv(body.data?.attributes?.ohlcv_list);
    if (candles.length < 2) throw new SwingsError('no-route', 'This token has too little price history to draw a chart.');
    const series: CandleSeries = { candles, pool: poolAddress, poolName: best.p.attributes?.name ?? 'pool', liquidityUsd: Number.isFinite(best.liq) ? best.liq : null, source: 'GeckoTerminal' };
    this.cache.set(cacheKey, { at: this.now(), series });
    return series;
  }
}
