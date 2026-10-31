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
import { DEXSCREENER_CHAIN, GECKO_NETWORK } from './pool.js';
import { CancelledRead, spaced } from './geckoGate.js';
import { markRouteDown, markRouteUp, routeIsDown } from './upstreamHealth.js';

/** The name Aretia's candle route is remembered under while it is failing. */
const CANDLES_ROUTE = 'candles';
/** The chart's reads go ahead of the trades table's in the queue for GeckoTerminal. */
const CHART_PRIORITY = 1;

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
  /** Prices in US dollars (the default), or in the other token of the pool. */
  currency?: 'usd' | 'token';
  /** A recent price, used only to choose how many decimals the price scale shows. */
  priceHint?: number | null;
  exchange?: string | null;
  /**
   * 'aretia': the pool is one Aretia's own Market Indexer follows, so candles come from its stored on-chain trades
   * (/api/swings-ohlcv?source=aretia). GeckoTerminal and DexScreener are NOT asked for such a pool: an outside source must never
   * stand in for, or override, what the indexer read from the chain.
   */
  source?: 'aretia';
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
  /** Starts reading the first candles for an interval now, before the chart asks for them. Optional: the chart works without it. */
  warm?(resolution: string): void;
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

/** The last candle's price follows the pool's live price this often: 60 reads a minute, against the 300 a minute DexScreener allows a visitor. */
const LIVE_PRICE_MS = 1_000;
/** After a live reading, the candle data's own close is not trusted over it for this long (candle data runs a little behind). */
const LIVE_PRICE_TRUST_MS = 12_000;

const positive = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * The price of the charted token from DexScreener's pair answer. The answer prices the pair's first token in dollars and
 * in the second token; the other three cases follow from those two numbers. Null when the answer lacks what is needed. Pure.
 */
export function livePriceFrom(body: unknown, side: 'base' | 'quote', currency: 'usd' | 'token'): number | null {
  const pair = (body as { pairs?: { priceUsd?: unknown; priceNative?: unknown }[] } | null)?.pairs?.[0];
  const usd = positive(pair?.priceUsd);
  const native = positive(pair?.priceNative);
  if (side === 'base') return currency === 'usd' ? usd : native;
  if (currency === 'usd') return usd !== null && native !== null ? usd / native : null;
  return native !== null ? 1 / native : null;
}

/**
 * Moves the candle on screen to a new price, or starts a new one when a new candle period has begun. A reading that jumps
 * to a third or triple of the last price in one step is a glitch in the source, not a market move, and is ignored. Pure.
 */
export function applyLivePrice(current: TvBar | null, price: number, slotMs: number): TvBar | null {
  if (current && current.time > slotMs) return null;
  if (current && (price > current.close * 3 || price < current.close / 3)) return null;
  if (current && current.time === slotMs) return { ...current, close: price, high: Math.max(current.high, price), low: Math.min(current.low, price) };
  const open = current?.close ?? price;
  return { time: slotMs, open, high: Math.max(open, price), low: Math.min(open, price), close: price, volume: 0 };
}

/**
 * History loads try this many times before giving up. Direct reads are already spaced about two seconds apart by the gate, so
 * the extra wait before a retry is short.
 */
const LOAD_ATTEMPTS = 3;
const RETRY_BASE_MS = 300;

/** If Aretia's own candle endpoint has not answered in this long, GeckoTerminal is read directly as well and the first good answer wins. */
const HEDGE_MS = 700;

/** How many candles an early read (see `warm`) asks for: more than the chart's first request, so it can serve it. */
const WARM_LIMIT = 500;

/** Candles already read, shared by every datafeed so a read started early serves the chart that opens a moment later. */
const store = new Map<string, { at: number; bars: TvBar[]; limit: number }>();
const inFlight = new Map<string, { limit: number; promise: Promise<TvBar[]> }>();

/** For tests, and for a page that wants a clean slate. */
export function resetCandleStore(): void {
  store.clear();
  inFlight.clear();
}

/**
 * Whichever of two reads gives a good answer first. A read that fails only counts against it if the other fails as well, and
 * then the direct read's own error is the one reported, since that is the more useful message. Pure apart from the promises.
 */
function firstGood(server: Promise<TvBar[] | null>, direct: Promise<TvBar[]>): Promise<TvBar[]> {
  return new Promise<TvBar[]>((resolve, reject) => {
    let failed = 0;
    let directError: unknown = new Error('The price service could not be reached.');
    const oneFailed = (): void => {
      if (++failed === 2) reject(directError);
    };
    server.then((bars) => (bars ? resolve(bars) : oneFailed()), oneFailed);
    direct.then(resolve, (e: unknown) => {
      directError = e;
      oneFailed();
    });
  });
}

export function createPoolDatafeed(
  o: PoolChartOptions,
  deps: {
    fetchImpl?: typeof fetch;
    base?: string;
    now?: () => number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Aretia's own shared, cached candle endpoint (/api/swings-ohlcv). Asked first; GeckoTerminal is asked directly only if it fails. */
    viaServer?: string;
    /** How often the pool's live price is read to move the last candle, in milliseconds; 0 turns it off. */
    livePriceMs?: number;
    dexBase?: string;
    /** Called when the chart's first load of candles fails for good (after its own retries), so the chart can be started again. */
    onLoadFailed?: (message: string) => void;
    /** How long Aretia's endpoint has to answer before GeckoTerminal is also read directly, in milliseconds. */
    hedgeMs?: number;
    /** How long Aretia's own index is waited for before the outside sources are also read (default 600). */
    indexerHeadStartMs?: number;
    /** True once the chart this datafeed serves has been closed: reads still waiting their turn for GeckoTerminal are then dropped. */
    cancelled?: () => boolean;
  } = {},
): TvDatafeed {
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const base = deps.base ?? 'https://api.geckoterminal.com/api/v2';
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? LIVE_POLL_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const network = GECKO_NETWORK[o.chain];
  const side = o.token ?? 'base';
  const currency = o.currency ?? 'usd';
  /** Shown beside the symbol in the chart's legend, like "DOPE / USD · 15 · aretiafinance.org". */
  const exchange = o.exchange ?? 'aretiafinance.org';
  const hedgeMs = deps.hedgeMs ?? HEDGE_MS;
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  /** Per interval: the time of the oldest candle the pool has, once a short answer showed there is nothing before it. */
  const exhausted = new Map<string, number>();
  /** Per interval: the newest candle loaded, where live price readings start from. */
  const newest = new Map<string, TvBar>();
  const priceTimers = new Map<string, ReturnType<typeof setInterval>>();
  const livePriceMs = deps.livePriceMs ?? LIVE_PRICE_MS;
  const dexBase = deps.dexBase ?? 'https://api.dexscreener.com';
  /** Pools the indexer said it does not follow, and until when not to ask again. */
  const indexerUnknown = new Map<string, number>();
  const INDEXER_UNKNOWN_MS = 15_000;
  const INDEXER_HEAD_START_MS = deps.indexerHeadStartMs ?? 600;

  /** The pool's price right now, from DexScreener's pair service (it updates within seconds and allows plenty of requests). Null on any failure. */
  async function fetchLivePrice(): Promise<number | null> {
    if (o.source === 'aretia') return null;
    try {
      const response = await fetchImpl(`${dexBase}/latest/dex/pairs/${DEXSCREENER_CHAIN[o.chain]}/${encodeURIComponent(o.pool)}`, { headers: { accept: 'application/json' } });
      return response.ok ? livePriceFrom(await response.json(), side, currency) : null;
    } catch {
      return null;
    }
  }

  /**
   * Candles from Aretia's own Market Indexer, tried first for a pool that is not flagged as indexed: if the indexer follows the pool it has
   * stored its trades from the chain, so no outside service is needed. Returns the bars when it has some, otherwise null (it does not follow
   * the pool, has no trades in this window, or could not answer) and the caller reads the usual outside sources. A pool it does not know is
   * remembered for 15 seconds (a pool that was just added on request is then picked up soon), so the question is not asked again for each window. Never marks the shared route as down: "unknown pool"
   * is a normal answer, and the route also serves pools that are indexed.
   */
  async function fromIndexer(res: Resolution, beforeSec: number, limit: number): Promise<TvBar[] | null> {
    if (!deps.viaServer || o.source === 'aretia') return null;
    const unknownKey = `${o.chain}|${o.pool}`;
    if ((indexerUnknown.get(unknownKey) ?? 0) > now()) return null;
    const q = new URLSearchParams({ chain: o.chain, pool: o.pool, tf: res.tf, agg: String(res.aggregate), before: String(Math.floor(beforeSec)), limit: String(limit), token: side, currency, source: 'aretia' });
    try {
      const response = await fetchImpl(`${deps.viaServer}?${q}`, { headers: { accept: 'application/json' } });
      if (response.status === 404) {
        indexerUnknown.set(unknownKey, now() + INDEXER_UNKNOWN_MS);
        return null;
      }
      if (!response.ok) return null;
      const bars = parseBars(await response.json());
      return bars.length > 0 ? bars : null;
    } catch {
      return null;
    }
  }

  /**
   * Candles from Aretia's own endpoint, which reads GeckoTerminal once for everyone and keeps the answer, so a visitor's
   * own allowance is not spent. Null on any failure (not deployed, refused, unreadable) so the caller can go direct.
   */
  async function fromServer(res: Resolution, beforeSec: number, limit: number): Promise<TvBar[] | null> {
    if (!deps.viaServer) return null;
    // A route that failed in the last minute is skipped, so each load does not wait on a refusal before going direct.
    const route = o.source === 'aretia' ? `${CANDLES_ROUTE}-aretia` : CANDLES_ROUTE;
    if (routeIsDown(route, now())) return null;
    const q = new URLSearchParams({ chain: o.chain, pool: o.pool, tf: res.tf, agg: String(res.aggregate), before: String(Math.floor(beforeSec)), limit: String(limit), token: side, currency });
    if (o.source) q.set('source', o.source);
    try {
      const response = await fetchImpl(`${deps.viaServer}?${q}`, { headers: { accept: 'application/json' } });
      if (response.ok) {
        markRouteUp(route);
        return parseBars(await response.json());
      }
    } catch {
      // Treated like any other failure below.
    }
    markRouteDown(route, now());
    return null;
  }

  /**
   * One request for candles. When the visitor's allowance is used up the service refuses without the headers a browser
   * needs, so that shows up as a failed fetch rather than a 429; both are a short wait away from working, so history
   * loads (attempts > 1) try again before giving up.
   */
  async function candles(res: Resolution, requestedBefore: number, limit: number, attempts = 1, fresh = false): Promise<TvBar[]> {
    // Round the time up to a whole candle. Asks made a moment apart then share one answer (the symbol lookup and the chart's
    // first request, say), which matters because GeckoTerminal turns away a second request that follows the first closely.
    const beforeSec = Math.ceil(requestedBefore / res.seconds) * res.seconds;
    // An answer holding at least as many candles as asked for serves the newest of them, whatever limit it was fetched with.
    // The store is shared by every datafeed, so a read started when a token is opened (see `warm`) serves the chart that
    // opens a moment later, and a read still under way is joined rather than made twice.
    const key = `${o.chain}|${o.pool}|${side}|${currency}|${o.source ?? ''}|${res.tf}|${res.aggregate}|${beforeSec}`;
    if (!fresh) {
      const hit = store.get(key);
      if (hit && now() - hit.at < CACHE_MS && hit.limit >= limit) return hit.bars.slice(-limit);
      const pending = inFlight.get(key);
      if (pending && pending.limit >= limit) return pending.promise.then((bars) => bars.slice(-limit));
    }
    const promise = loadCandles(res, beforeSec, limit, attempts, key);
    const entry = { limit, promise };
    inFlight.set(key, entry);
    const forget = (): void => {
      if (inFlight.get(key) === entry) inFlight.delete(key);
    };
    promise.then(forget, forget);
    return promise;
  }

  /**
   * Reads candles from whichever source answers first. Aretia's own endpoint is asked first (it shares one read among
   * everyone), but it is often slower than going direct, and it can be refused outright. So if it has not answered within
   * `hedgeMs`, the page also reads GeckoTerminal directly and takes whichever good answer arrives first. When the endpoint
   * fails quickly the direct read simply follows, as before.
   */
  async function loadCandles(res: Resolution, beforeSec: number, limit: number, attempts: number, key: string): Promise<TvBar[]> {
    const keep = (bars: TvBar[]): TvBar[] => {
      store.set(key, { at: now(), bars, limit });
      return bars;
    };
    if (o.source === 'aretia') {
      // An indexed pool has one source: Aretia's stored trades. No outside service is asked, hedged against or fallen back to.
      const own = await fromServer(res, beforeSec, limit);
      if (own === null) throw new Error("Aretia's market index could not be reached.");
      return keep(own);
    }
    // Aretia's own index is asked first and given a short head start: a pool it follows needs no outside service at all. If it does not
    // follow the pool, has nothing for this window or is slow, the usual sources are read, and bars the index sends meanwhile still win.
    const indexed = fromIndexer(res, beforeSec, limit);
    let headStart: ReturnType<typeof setTimeout> | undefined;
    const tooSlow = new Promise<'late'>((resolve) => {
      headStart = setTimeout(() => resolve('late'), INDEXER_HEAD_START_MS);
    });
    const first = await Promise.race([indexed, tooSlow]);
    clearTimeout(headStart);
    if (Array.isArray(first)) return keep(first);
    const usual = async (): Promise<TvBar[]> => {
      const direct = (): Promise<TvBar[]> => readDirect(res, beforeSec, limit, attempts);
      const server = fromServer(res, beforeSec, limit);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), hedgeMs);
      });
      const first = await Promise.race([server, late]);
      clearTimeout(timer);
      if (first !== 'late') return keep(first ?? (await direct()));
      return keep(await firstGood(server, direct()));
    };
    const usualRead = usual();
    return keep(
      await new Promise<TvBar[]>((resolve, reject) => {
        indexed.then((bars) => {
          if (bars) resolve(bars);
        });
        usualRead.then(resolve, (e: unknown) => {
          // The usual sources failed: the index may still answer.
          indexed.then((bars) => (bars ? resolve(bars) : reject(e)), () => reject(e));
        });
      }),
    );
  }

  /** Reads GeckoTerminal itself: spaced out, retried a little, and read into bars. */
  async function readDirect(res: Resolution, beforeSec: number, limit: number, attempts: number): Promise<TvBar[]> {
    const q = new URLSearchParams({ aggregate: String(res.aggregate), before_timestamp: String(beforeSec), limit: String(limit), currency, token: side });
    const url = `${base}/networks/${network}/pools/${encodeURIComponent(o.pool)}/ohlcv/${res.tf}?${q}`;
    let response: Response | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // Direct reads of GeckoTerminal are spaced out; a retry that came too soon after the last read would only be turned away too.
        response = await spaced(() => fetchImpl(url, { headers: { accept: 'application/json' } }), { priority: CHART_PRIORITY, ...(deps.cancelled ? { cancelled: deps.cancelled } : {}) });
      } catch (e) {
        // A read for a chart that has been closed is dropped, not retried.
        if (e instanceof CancelledRead) throw e;
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
    return parseBars(body);
  }

  const info: TvSymbolInfo = {
    name: o.label,
    ticker: `${network}:${o.pool}`,
    description: o.label,
    type: 'crypto',
    session: '24x7',
    timezone: 'Etc/UTC',
    exchange,
    listed_exchange: exchange,
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
    warm(resolution) {
      const res = RESOLUTIONS[resolution];
      if (!res) return;
      // The chart takes a moment to start before it asks for candles; reading them now overlaps the two. A failure here is
      // not the chart's failure: when it asks, it reads again.
      void candles(res, Math.floor(now() / 1000) + res.seconds, currency === 'token' ? MAX_PER_REQUEST : WARM_LIMIT, LOAD_ATTEMPTS).catch(() => undefined);
    },
    onReady(cb) {
      setTimeout(() => cb({ supported_resolutions: SUPPORTED_RESOLUTIONS, supports_marks: false, supports_timescale_marks: false, supports_time: false, exchanges: [], symbols_types: [] }), 0);
    },
    searchSymbols(_input, _exchange, _type, cb) {
      cb([]);
    },
    resolveSymbol(_name, onResolve) {
      if (currency === 'token') {
        // How many decimals the price scale needs depends on the size of the price in the other token, which is only known
        // once candles have been read. The full first page is read now and kept, so the chart's own first request is served
        // from it rather than made a moment later. If this fails, the default scale is used rather than failing the chart.
        candles(RESOLUTIONS['15']!, Math.floor(now() / 1000) + 900, MAX_PER_REQUEST, LOAD_ATTEMPTS)
          .then((bars) => {
            const last = bars[bars.length - 1];
            if (last) info.pricescale = priceScaleFor(last.close);
          })
          .catch(() => undefined)
          .then(() => onResolve(info));
        return;
      }
      setTimeout(() => onResolve(info), 0);
    },
    getBars(_info, resolution, params, onResult, onError) {
      const res = RESOLUTIONS[resolution];
      if (!res) return onError(`The ${resolution} interval is not available.`);
      const limit = Math.min(MAX_PER_REQUEST, Math.max(200, params.countBack ?? 300));
      // The chart pages back for older candles on its own. Once an answer has come back shorter than asked for, the pool's
      // history has run out, so there is nothing older to ask for (and no request spent finding that out).
      if (params.firstDataRequest) exhausted.delete(resolution);
      const oldest = exhausted.get(resolution);
      if (!params.firstDataRequest && oldest !== undefined && params.to * 1000 <= oldest) return onResult([], { noData: true });
      // The first request asks for the present, and the live candle is included; later ones page back from the oldest bar the chart has.
      const before = params.firstDataRequest ? params.to + res.seconds : params.to;
      candles(res, before, limit, LOAD_ATTEMPTS)
        .then((bars) => {
          if (bars.length < limit) exhausted.set(resolution, bars[0]?.time ?? Number.POSITIVE_INFINITY);
          const inRange = bars.filter((b) => (params.firstDataRequest ? b.time <= params.to * 1000 : b.time < params.to * 1000));
          // The newest candle is where live price readings start from.
          if (params.firstDataRequest && inRange.length > 0) newest.set(resolution, inRange[inRange.length - 1]!);
          onResult(inRange, { noData: inRange.length === 0 });
        })
        .catch((e: unknown) => {
          const message = e instanceof Error ? e.message : 'The chart data could not be loaded.';
          // The chart gives up on a failed load and stays empty, so the owner is told and can try the whole chart again.
          if (params.firstDataRequest) deps.onLoadFailed?.(message);
          onError(message);
        });
    },
    subscribeBars(_info, resolution, onTick, uid) {
      const res = RESOLUTIONS[resolution];
      if (!res) return;
      clearInterval(timers.get(uid));
      clearInterval(priceTimers.get(uid));
      let latest = 0;
      /** The candle on screen now, and when its price last moved from a live reading. */
      let current: TvBar | null = newest.get(resolution) ?? null;
      let liveAt = 0;
      const push = (b: TvBar): void => {
        if (b.time < latest) return;
        latest = b.time;
        current = b;
        onTick(b);
      };
      const hidden = (): boolean => typeof document !== 'undefined' && document.hidden;

      // Every few seconds: the pool's price right now moves the last candle's close (and its high or low).
      const price = (): void => {
        if (hidden()) return;
        fetchLivePrice()
          .then((p) => {
            if (p === null) return;
            const slot = Math.floor(now() / 1000 / res.seconds) * res.seconds * 1000;
            const bar = applyLivePrice(current, p, slot);
            if (!bar) return;
            liveAt = now();
            push(bar);
          })
          .catch(() => undefined);
      };
      if (livePriceMs > 0) priceTimers.set(uid, setInterval(price, livePriceMs));

      // Every so often: the real candles, which carry the volume and correct anything the live readings missed.
      const tick = (): void => {
        if (hidden()) return;
        // Skip what is stored so a live poll sees fresh data.
        candles(res, Math.floor(now() / 1000) + res.seconds, 2, 1, true)
          .then((bars) => {
            for (const b of bars) {
              // A candle the live price has just moved keeps that price until the candle data catches up.
              if (current && b.time === current.time && now() - liveAt < LIVE_PRICE_TRUST_MS) {
                push({ ...b, close: current.close, high: Math.max(b.high, current.high), low: Math.min(b.low, current.low) });
              } else push(b);
            }
          })
          .catch(() => undefined);
      };
      timers.set(uid, setInterval(tick, pollMs));
    },
    unsubscribeBars(uid) {
      clearInterval(timers.get(uid));
      timers.delete(uid);
      clearInterval(priceTimers.get(uid));
      priceTimers.delete(uid);
    },
  };
}
