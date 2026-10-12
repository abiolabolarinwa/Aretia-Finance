/**
 * Aretia's price chart: TradingView's licensed Advanced Charts library, drawn in the page from Aretia's own datafeed
 * (src/swings/charts/tvDatafeed.ts) instead of a third party's embedded page.
 *
 * The library files are not in the repository (they are licensed and fetched at build time, see
 * scripts/fetch-charting-library.ts) and are served from this site's own /charting_library/. When they are missing, or
 * fail to start, `onUnavailable` is called so the screen can show its fallback chart instead of an empty box.
 */
import type { ChainId } from '../swings/core/types.js';
import { createPoolDatafeed, type TvDatafeed } from '../swings/charts/tvDatafeed.js';

const LIBRARY_PATH = '/charting_library/';
const LIBRARY_SCRIPT = `${LIBRARY_PATH}charting_library.standalone.js`;

interface TvWidget {
  remove(): void;
  onChartReady(cb: () => void): void;
}
interface TvGlobal {
  widget: new (options: Record<string, unknown>) => TvWidget;
}

export interface TvChartOptions {
  chain: ChainId;
  pool: string;
  /** The name on the chart, such as "DOPE / USD". */
  label: string;
  /** Which token of the pool is priced: the first ("base", the default) or the second ("quote"). */
  token?: 'base' | 'quote';
  priceHint?: number | null;
  exchange?: string | null;
  interval?: string;
  /** Show the drawing tools on the left. */
  toolbar?: boolean;
  /** Shown in a sandboxed frame if the chart cannot be drawn (library not installed, blocked, or failed to start). */
  fallbackUrl?: string;
  /** The frame's accessible name. */
  title?: string;
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

/** What is turned off: the datafeed carries one pool, so there is nothing to search or compare, and nothing is saved to a server. */
const DISABLED = ['header_symbol_search', 'symbol_search_hot_key', 'header_compare', 'header_saveload', 'header_screenshot', 'display_market_status', 'popup_hints'];

/** Draws the chart into `host`. Returns a handle to take it down again. */
export function mountTvChart(host: HTMLElement, o: TvChartOptions, feed: TvDatafeed = createPoolDatafeed({ chain: o.chain, pool: o.pool, label: o.label, ...(o.token ? { token: o.token } : {}), ...(o.priceHint !== undefined ? { priceHint: o.priceHint } : {}), ...(o.exchange !== undefined ? { exchange: o.exchange } : {}) })): TvChart {
  let widget: TvWidget | null = null;
  let disposed = false;
  host.replaceChildren();
  host.classList.add('wapp-tv');

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

  loadChartingLibrary()
    .then((TradingView) => {
      if (disposed) return;
      try {
        widget = new TradingView.widget({
          container: host,
          library_path: LIBRARY_PATH,
          datafeed: feed,
          symbol: `${o.chain}:${o.pool}`,
          interval: o.interval ?? '15',
          locale: 'en',
          timezone: 'Etc/UTC',
          theme: 'light',
          autosize: true,
          loading_screen: { backgroundColor: '#ffffff', foregroundColor: '#0e5c45' },
          disabled_features: [...DISABLED, ...(o.toolbar ? [] : ['left_toolbar'])],
          overrides: { 'paneProperties.background': '#ffffff', 'paneProperties.backgroundType': 'solid', 'mainSeriesProperties.candleStyle.upColor': '#16a34a', 'mainSeriesProperties.candleStyle.downColor': '#dc2626', 'mainSeriesProperties.candleStyle.borderUpColor': '#16a34a', 'mainSeriesProperties.candleStyle.borderDownColor': '#dc2626', 'mainSeriesProperties.candleStyle.wickUpColor': '#16a34a', 'mainSeriesProperties.candleStyle.wickDownColor': '#dc2626' },
        });
      } catch {
        unavailable();
      }
    })
    .catch(unavailable);

  return {
    dispose() {
      disposed = true;
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
