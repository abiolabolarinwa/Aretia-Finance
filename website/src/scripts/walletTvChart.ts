/**
 * Aretia's price chart: TradingView's licensed Advanced Charts library, drawn in the page from Aretia's own datafeed
 * (src/swings/charts/tvDatafeed.ts) instead of a third party's embedded page.
 *
 * The library files are not in the repository (they are licensed and fetched at build time, see
 * scripts/fetch-charting-library.ts) and are served from this site's own /charting_library/. When they are missing, or
 * fail to start, `onUnavailable` is called so the screen can show its fallback chart instead of an empty box.
 */
import type { ChainId } from '../swings/core/types.js';
import { holdLowPriority } from '../swings/charts/geckoGate.js';
import { createPoolDatafeed, SUPPORTED_RESOLUTIONS, type ChartStatus, type TvDatafeed } from '../swings/charts/tvDatafeed.js';

const LIBRARY_PATH = '/charting_library/';
const LIBRARY_SCRIPT = `${LIBRARY_PATH}charting_library.standalone.js`;

interface TvWidget {
  remove(): void;
  onChartReady(cb: () => void): void;
  activeChart(): { onIntervalChanged(): { subscribe(ctx: null, cb: (interval: string) => void): void }; getPanes?(): { getMainSourcePriceScale?(): { setMode(mode: number): void } | null }[] };
  headerReady(): Promise<void>;
  createButton(): HTMLElement;
}
interface TvGlobal {
  widget: new (options: Record<string, unknown>) => TvWidget;
}

export interface TvChartOptions {
  chain: ChainId;
  pool: string;
  /** The token being charted, such as "DOPE". The chart is named "DOPE / USD", or "DOPE / SOL" when prices are shown in the other token. */
  symbol: string;
  /** The other side of the pool, such as "SOL". When given, a "USD / SOL" switch appears in the chart's toolbar. */
  quoteSymbol?: string;
  /** Which token of the pool is priced: the first ("base", the default) or the second ("quote"). */
  token?: 'base' | 'quote';
  /** A recent price in US dollars, used only to choose how many decimals the price scale shows. */
  priceHint?: number | null;
  exchange?: string | null;
  interval?: string;
  /** Show the drawing tools on the left. */
  toolbar?: boolean;
  /** Shown in a sandboxed frame if the chart cannot be drawn (library not installed, blocked, or failed to start). */
  fallbackUrl?: string;
  /** The frame's accessible name. */
  title?: string;
  /** 'aretia': a market read by Aretia's own Market Indexer; candles come from its stored trades and no outside service is asked. */
  source?: 'aretia';
  /** With source 'aretia': false when the quote is not a dollar stablecoin, so prices can only be shown in the quote token. */
  usdAvailable?: boolean;
}

export interface TvChart {
  dispose(): void;
}

let loading: Promise<TvGlobal> | null = null;

/** Loads the library once per page. Rejects when the files are not there. */
export function loadChartingLibrary(): Promise<TvGlobal> {
  const ready = (): TvGlobal | undefined => (window as unknown as { TradingView?: TvGlobal }).TradingView;
  const have = ready();
  if (have) return Promise.resolve(have);
  loading ??= new Promise<TvGlobal>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = LIBRARY_SCRIPT;
    script.async = true;
    script.onload = () => {
      const tv = ready();
      if (tv) resolve(tv);
      else reject(new Error('The chart library did not start.'));
    };
    script.onerror = () => reject(new Error('The chart library is not installed.'));
    document.head.append(script);
  }).catch((e: unknown) => {
    // Allow a later screen to try again (a failed load must not stick for the whole visit).
    loading = null;
    throw e;
  });
  return loading;
}

/**
 * Loads the chart library in the background, before any chart is opened, so the first chart does not wait for it. Safe to call
 * any number of times, and to ignore: if it fails, opening a chart tries again.
 */
export function preloadChartingLibrary(): void {
  const start = (): void => void loadChartingLibrary().catch(() => undefined);
  // After the page has settled, so it does not compete with what the reader is looking at.
  if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 4_000 });
  else setTimeout(start, 1_500);
}

/** What is turned off: the datafeed carries one pool, so there is nothing to search or compare, and nothing is saved to a server. */
const DISABLED = ['header_symbol_search', 'symbol_search_hot_key', 'header_compare', 'header_saveload', 'header_screenshot', 'display_market_status', 'popup_hints'];

/** Which unit prices are shown in: US dollars, or the other token of the pool. The choice lasts for the visit, so it carries from token to token. */
let lastCurrency: 'usd' | 'token' = 'usd';

/** How many times a chart that failed to load is started again, and how long it waits before the first (then twice, three times as long). */
const MAX_RESTARTS = 3;
const RESTART_AFTER_MS = 8_000;

/** The timeframe the reader last chose (1h, 4h...), so it survives opening another token or flipping the unit. */
let lastInterval: string | null = null;

/** Draws the chart into `host`. Returns a handle to take it down again. */
export function mountTvChart(
  host: HTMLElement,
  o: TvChartOptions,
  makeFeed: (currency: 'usd' | 'token', label: string, onLoadFailed: () => void, cancelled: () => boolean, onStatus?: (s: ChartStatus) => void) => TvDatafeed = (currency, label, onLoadFailed, cancelled, onStatus) =>
    createPoolDatafeed(
      { chain: o.chain, pool: o.pool, label, currency, ...(o.token ? { token: o.token } : {}), ...(currency === 'usd' && o.priceHint !== undefined ? { priceHint: o.priceHint } : {}), ...(o.exchange !== undefined ? { exchange: o.exchange } : {}), ...(o.source ? { source: o.source } : {}) },
      { viaServer: '/api/swings-ohlcv', onLoadFailed, cancelled, ...(onStatus ? { onStatus } : {}) },
    ),
): TvChart {
  let widget: TvWidget | null = null;
  let disposed = false;
  /** True once this chart has been closed; reads still waiting their turn for GeckoTerminal are then dropped. */
  const isClosed = (): boolean => disposed;
  let library: TvGlobal | null = null;
  let restarts = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  // A market the index follows whose quote is not a dollar stablecoin is charted in its quote token only: dollars would mean converting history at today's rate.
  const tokenOnly = o.source === 'aretia' && o.usdAvailable === false && !!o.quoteSymbol;
  const canSwitch = !!o.quoteSymbol && !tokenOnly;
  let currency: 'usd' | 'token' = tokenOnly ? 'token' : canSwitch ? lastCurrency : 'usd';
  host.replaceChildren();
  host.classList.add('wapp-tv');
  // The chart asks for its candles in a moment, once the library has loaded; reads for the trades table wait for it.
  holdLowPriority(4_000);
  // Starting up the chart takes a second or so, and it only asks for candles afterwards. Reading them now overlaps the two,
  // so they are usually there the moment the chart asks. (A throwaway datafeed does the reading into a store they share.)
  try {
    makeFeed(currency, `${o.symbol} / ${currency === 'usd' ? 'USD' : o.quoteSymbol}`, () => undefined, isClosed).warm?.(lastInterval ?? o.interval ?? '15');
  } catch {
    // Not needed for the chart to work.
  }

  const unavailable = (): void => {
    if (disposed || !o.fallbackUrl) return;
    host.classList.remove('wapp-tv');
    const frame = document.createElement('iframe');
    frame.title = o.title ?? 'Price chart';
    frame.src = o.fallbackUrl;
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
    frame.style.cssText = 'display:block;width:100%;height:100%;border:0';
    host.replaceChildren(frame);
  };

  /** The "USD / SOL" switch in the chart's own toolbar, with the unit in use highlighted. Flipping it redraws the chart in the other unit. */
  function addSwitch(w: TvWidget, TradingView: TvGlobal): void {
    void w.headerReady().then(() => {
      if (disposed || widget !== w) return;
      const button = w.createButton();
      const doc = button.ownerDocument;
      const part = (text: string, active: boolean): HTMLElement => {
        const s = doc.createElement('span');
        s.textContent = text;
        s.style.cssText = active ? 'color:#4f46e5;font-weight:700' : 'color:#787b86';
        return s;
      };
      const slash = part(' / ', false);
      button.replaceChildren(part('USD', currency === 'usd'), slash, part(o.quoteSymbol!, currency === 'token'));
      button.title = currency === 'usd' ? `Show prices in ${o.quoteSymbol}` : 'Show prices in US dollars';
      button.addEventListener('click', () => {
        if (disposed) return;
        currency = currency === 'usd' ? 'token' : 'usd';
        lastCurrency = currency;
        try {
          w.remove();
        } catch {
          // Already gone.
        }
        host.replaceChildren();
        build(TradingView);
      });
    }).catch(() => undefined);
  }

  /**
   * A chart whose first load of candles failed stays empty on its own. So it is started again after a pause, a few times,
   * which is usually enough for a busy data source to have recovered, instead of waiting for the reader to reload the page.
   */
  function scheduleRestart(): void {
    if (disposed || restartTimer !== null || restarts >= MAX_RESTARTS || !library) return;
    const lib = library;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (disposed) return;
      restarts++;
      try {
        widget?.remove();
      } catch {
        // Already gone.
      }
      host.replaceChildren();
      build(lib);
    }, RESTART_AFTER_MS * (restarts + 1));
  }

  /** The chart's own area says where its candles came from, or why there are none, instead of a blank chart with red warning icons. */
  let overlay: HTMLElement | null = null;
  let chartReady = false;
  let wide = false;
  function applyAxis(w: TvWidget): void {
    if (!wide || !chartReady) return;
    try {
      // A price that moved a thousandfold (a pool that rugged, or just launched) is unreadable on a straight axis: use the logarithmic one (mode 1).
      w.activeChart().getPanes?.()[0]?.getMainSourcePriceScale?.()?.setMode(1);
    } catch {
      // The library version has no such call: the straight axis stays.
    }
  }
  function showStatus(w: TvWidget | null, s: ChartStatus): void {
    if (disposed) return;
    overlay?.remove();
    overlay = null;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const el = host.ownerDocument.createElement('div');
    el.className = 'wapp-tv-status';
    el.setAttribute('role', 'status');
    if (s.kind === 'ok') {
      const label = s.source === 'aretia-index' ? 'Source: Aretia market index' : s.source === 'geckoterminal' ? 'Source: GeckoTerminal' : s.source === 'geckoterminal-stale' ? 'Source: GeckoTerminal (a little old)' : s.source === 'trades' ? 'Built from the latest trades' : '';
      if (!label) return;
      el.textContent = label;
      if (s.note) el.title = s.note;
      el.style.cssText = 'position:absolute;right:76px;bottom:46px;z-index:5;pointer-events:auto;font:11px/1.3 system-ui,sans-serif;color:#64748b;background:rgba(255,255,255,.85);padding:2px 6px;border-radius:6px;cursor:help;max-width:60%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      wide = !!s.wideRange;
      if (w) applyAxis(w);
    } else {
      const retryable = s.kind === 'failed' && restarts < MAX_RESTARTS && !!library;
      el.style.cssText = 'position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;font:14px/1.45 system-ui,sans-serif;color:#334155;background:rgba(255,255,255,.96)';
      const text = host.ownerDocument.createElement('div');
      text.style.maxWidth = '420px';
      text.textContent = s.kind === 'empty' ? (s.message ?? 'No candles yet for this market.') : retryable ? 'The price services did not answer. Trying again in a few seconds…' : 'No price service answered, so there are no candles to draw right now. The trades below are still live.';
      el.append(text);
      if (!retryable) {
        const b = host.ownerDocument.createElement('button');
        b.type = 'button';
        b.textContent = 'Try again';
        b.style.cssText = 'font:600 13px system-ui,sans-serif;padding:7px 14px;border-radius:8px;border:1px solid #4f46e5;background:#4f46e5;color:#fff;cursor:pointer';
        b.addEventListener('click', () => {
          if (disposed || !library) return;
          restarts = 0;
          try {
            widget?.remove();
          } catch {
            // Already gone.
          }
          host.replaceChildren();
          build(library);
        });
        el.append(b);
      }
    }
    host.append(el);
    overlay = el;
  }

  function build(TradingView: TvGlobal): void {
    library = TradingView;
    chartReady = false;
    wide = false;
    overlay = null;
    const feed = makeFeed(currency, `${o.symbol} / ${currency === 'usd' ? 'USD' : o.quoteSymbol}`, scheduleRestart, isClosed, (s) => showStatus(widget, s));
    try {
        const w = new TradingView.widget({
          container: host,
          library_path: LIBRARY_PATH,
          datafeed: feed,
          symbol: `${o.chain}:${o.pool}`,
          interval: lastInterval ?? o.interval ?? '15',
          locale: 'en',
          timezone: 'Etc/UTC',
          theme: 'light',
          autosize: true,
          loading_screen: { backgroundColor: '#ffffff', foregroundColor: '#0e5c45' },
          disabled_features: [...DISABLED, ...(o.toolbar ? [] : ['left_toolbar'])],
          overrides: { 'paneProperties.background': '#ffffff', 'paneProperties.backgroundType': 'solid', 'mainSeriesProperties.candleStyle.upColor': '#16a34a', 'mainSeriesProperties.candleStyle.downColor': '#dc2626', 'mainSeriesProperties.candleStyle.borderUpColor': '#16a34a', 'mainSeriesProperties.candleStyle.borderDownColor': '#dc2626', 'mainSeriesProperties.candleStyle.wickUpColor': '#16a34a', 'mainSeriesProperties.candleStyle.wickDownColor': '#dc2626' },
        });
        widget = w;
        // Remember the timeframe the reader picks, but only one the datafeed can serve.
        w.onChartReady(() => {
          chartReady = true;
          applyAxis(w);
          try {
            w.activeChart().onIntervalChanged().subscribe(null, (interval) => {
              if (SUPPORTED_RESOLUTIONS.includes(interval)) lastInterval = interval;
            });
          } catch {
            // The chart is already gone.
          }
        });
        if (canSwitch) addSwitch(w, TradingView);
    } catch {
      unavailable();
    }
  }

  loadChartingLibrary()
    .then((TradingView) => {
      if (!disposed) build(TradingView);
    })
    .catch(unavailable);

  return {
    dispose() {
      disposed = true;
      if (restartTimer !== null) clearTimeout(restartTimer);
      restartTimer = null;
      try {
        widget?.remove();
      } catch {
        // The library may already have torn itself down with the page.
      }
      widget = null;
      host.replaceChildren();
    },
  };
}
