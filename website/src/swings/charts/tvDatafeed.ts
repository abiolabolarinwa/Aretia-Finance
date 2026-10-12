/**
 * The data behind Aretia's TradingView chart: candles for one pool from GeckoTerminal's public OHLCV service, shaped
 * for TradingView's datafeed interface. Only the pool address (and the network it is on) is sent; nothing about the
 * wallet is.
 *
 * TradingView's library types are not imported here: the library is licensed code that is fetched at build time and
 * is not in the repository, so the few shapes used are written out below. Pure apart from the injected fetch and timers,
 * so it is tested without the library.
 */
import type { ChainId } from '../core/types.js';
import { GECKO_NETWORK } from './pool.js';

/** One bar in the shape TradingView reads: `time` in milliseconds, volume in US dollars. */
export interface TvBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Resolution {
  /** GeckoTerminal's timeframe and its aggregate (candles of `aggregate` x timeframe). */
  tf: 'minute' | 'hour' | 'day';
  aggregate: number;
  seconds: number;
}

/** What the chart's interval buttons offer, and how each maps onto the service. */
export const RESOLUTIONS: Readonly<Record<string, Resolution>> = {
  '1': { tf: 'minute', aggregate: 1, seconds: 60 },
  '5': { tf: 'minute', aggregate: 5, seconds: 300 },
  '15': { tf: 'minute', aggregate: 15, seconds: 900 },
  '60': { tf: 'hour', aggregate: 1, seconds: 3600 },
  '240': { tf: 'hour', aggregate: 4, seconds: 14_400 },
  '1D': { tf: 'day', aggregate: 1, seconds: 86_400 },
};
export const SUPPORTED_RESOLUTIONS = Object.keys(RESOLUTIONS);

/** The service answers at most this many candles per request. */
const MAX_PER_REQUEST = 1000;
/** About 30 requests a minute are allowed per visitor, so live updates are polled gently. */
const LIVE_POLL_MS = 20_000;
const CACHE_MS = 8_000;

export interface PoolChartOptions {
  chain: ChainId;
  pool: string;
  /** Which token of the pool the chart prices: the first ("base") or the second ("quote"). */
  token?: 'base' | 'quote';
  /** The name shown on the chart, such as "DOPE / USD". */
  label: string;
  /** A recent price, used only to choose how many decimals the price scale shows. */
  priceHint?: number | null;
  exchange?: string | null;
}

export interface TvSymbolInfo {
  name: string;
  ticker: string;
  description: string;
  type: string;
  session: string;
  timezone: string;
  exchange: string;
  listed_exchange: string;
  format: 'price';
  minmov: number;
  pricescale: number;
  has_intraday: boolean;
  has_daily: boolean;
  has_weekly_and_monthly: boolean;
  supported_resolutions: string[];
  volume_precision: number;
  data_status: 'streaming';
}

interface PeriodParams {
  from: number;
  to: number;
  countBack?: number;
  firstDataRequest: boolean;
}

/** The part of TradingView's IBasicDataFeed that this chart uses. */
export interface TvDatafeed {
  onReady(cb: (config: Record<string, unknown>) => void): void;
  searchSymbols(input: string, exchange: string, type: string, cb: (r: unknown[]) => void): void;
  resolveSymbol(name: string, onResolve: (info: TvSymbolInfo) => void, onError: (reason: string) => void): void;
  getBars(info: TvSymbolInfo, resolution: string, params: PeriodParams, onResult: (bars: TvBar[], meta: { noData: boolean }) => void, onError: (reason: string) => void): void;
  subscribeBars(info: TvSymbolInfo, resolution: string, onTick: (bar: TvBar) => void, uid: string): void;
  unsubscribeBars(uid: string): void;
}

/** Decimals for the price scale: enough for four significant digits, from $60,000 coins down to $0.0000004 ones. */
export function priceScaleFor(price: number | null | undefined): number {
  if (!price || !Number.isFinite(price) || price <= 0) return 1e6;
  const decimals = Math.min(12, Math.max(2, 3 - Math.floor(Math.log10(price))));
  return 10 ** decimals;
}

/** Reads GeckoTerminal's candle list ([seconds, open, high, low, close, volume], newest first) into bars, oldest first. Pure. */
export function parseBars(body: unknown): TvBar[] {
  const list = (body as { data?: { attributes?: { ohlcv_list?: unknown } } } | null)?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const bars = new Map<number, TvBar>();
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [ts, o, h, l, c, v] = row.map(Number) as [number, number, number, number, number, number];
    if (![ts, o, h, l, c].every(Number.isFinite) || o <= 0 || h <= 0 || l <= 0 || c <= 0 || h < l) continue;
    bars.set(ts, { time: ts * 1000, open: o, high: h, low: l, close: c, volume: Number.isFinite(v) && v > 0 ? v : 0 });
  }
  return [...bars.values()].sort((a, b) => a.time - b.time);
}

/** History loads try this many times before giving up, waiting a little longer each time. */
const LOAD_ATTEMPTS = 3;
const RETRY_BASE_MS = 900;

export function createPoolDatafeed(o: PoolChartOptions, deps: { fetchImpl?: typeof fetch; base?: string; now?: () => number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}): TvDatafeed {
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const base = deps.base ?? 'https://api.geckoterminal.com/api/v2';
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? LIVE_POLL_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const network = GECKO_NETWORK[o.chain];
  const side = o.token ?? 'base';
  const cache = new Map<string, { at: number; bars: TvBar[] }>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();

  /**
   * One request for candles. When the visitor's allowance is used up the service refuses without the headers a browser
   * needs, so that shows up as a failed fetch rather than a 429; both are a short wait away from working, so history
   * loads (attempts > 1) try again before giving up.
   */
  async function candles(res: Resolution, beforeSec: number, limit: number, attempts = 1): Promise<TvBar[]> {
    const q = new URLSearchParams({ aggregate: String(res.aggregate), before_timestamp: String(Math.floor(beforeSec)), limit: String(limit), currency: 'usd', token: side });
    const url = `${base}/networks/${network}/pools/${encodeURIComponent(o.pool)}/ohlcv/${res.tf}?${q}`;
    const hit = cache.get(url);
    if (hit && now() - hit.at < CACHE_MS) return hit.bars;
    let response: Response | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        response = await fetchImpl(url, { headers: { accept: 'application/json' } });
      } catch {
        response = null;
      }
      const retryable = response === null || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === attempts) break;
      await sleep(RETRY_BASE_MS * attempt);
    }
    if (response === null) throw new Error('The price service could not be reached.');
    if (response.status === 429) throw new Error('The price service is busy. Try again in a minute.');
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`The price service answered ${response.status}.`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error('The price service returned something unreadable.');
    }
    const bars = parseBars(body);
    cache.set(url, { at: now(), bars });
    return bars;
  }

  const info: TvSymbolInfo = {
    name: o.label,
    ticker: `${network}:${o.pool}`,
    description: o.label,
    type: 'crypto',
    session: '24x7',
    timezone: 'Etc/UTC',
    exchange: o.exchange ?? '',
    listed_exchange: o.exchange ?? '',
    format: 'price',
    minmov: 1,
    pricescale: priceScaleFor(o.priceHint),
    has_intraday: true,
    has_daily: true,
    has_weekly_and_monthly: false,
    supported_resolutions: SUPPORTED_RESOLUTIONS,
    volume_precision: 2,
    data_status: 'streaming',
  };

  return {
    onReady(cb) {
      setTimeout(() => cb({ supported_resolutions: SUPPORTED_RESOLUTIONS, supports_marks: false, supports_timescale_marks: false, supports_time: false, exchanges: [], symbols_types: [] }), 0);
    },
    searchSymbols(_input, _exchange, _type, cb) {
      cb([]);
    },
    resolveSymbol(_name, onResolve) {
      setTimeout(() => onResolve(info), 0);
    },
    getBars(_info, resolution, params, onResult, onError) {
      const res = RESOLUTIONS[resolution];
      if (!res) return onError(`The ${resolution} interval is not available.`);
      const limit = Math.min(MAX_PER_REQUEST, Math.max(200, params.countBack ?? 300));
      // The first request asks for the present, and the live candle is included; later ones page back from the oldest bar the chart has.
      const before = params.firstDataRequest ? params.to + res.seconds : params.to;
      candles(res, before, limit, LOAD_ATTEMPTS)
        .then((bars) => {
          const inRange = bars.filter((b) => (params.firstDataRequest ? b.time <= params.to * 1000 : b.time < params.to * 1000));
          onResult(inRange, { noData: inRange.length === 0 });
        })
        .catch((e: unknown) => onError(e instanceof Error ? e.message : 'The chart data could not be loaded.'));
    },
    subscribeBars(_info, resolution, onTick, uid) {
      const res = RESOLUTIONS[resolution];
      if (!res) return;
      clearInterval(timers.get(uid));
      let latest = 0;
      const tick = (): void => {
        if (typeof document !== 'undefined' && document.hidden) return;
        // Skip the cache so a live poll sees fresh data.
        cache.clear();
        candles(res, Math.floor(now() / 1000) + res.seconds, 2)
          .then((bars) => {
            for (const b of bars) {
              if (b.time < latest) continue;
              latest = b.time;
              onTick(b);
            }
          })
          .catch(() => undefined);
      };
      timers.set(uid, setInterval(tick, pollMs));
    },
    unsubscribeBars(uid) {
      clearInterval(timers.get(uid));
      timers.delete(uid);
    },
  };
}
