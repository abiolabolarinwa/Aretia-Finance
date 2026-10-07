/**
 * A price chart for the Swings screens, drawn with TradingView's open-source Lightweight Charts library (loaded only
 * when a chart is first shown, so the wallet page stays light). The data comes from a `CandleSource`
 * (src/swings/charts/candles.ts); the chart says where it came from and what pool it reads, and says so plainly when
 * there is nothing to draw. It holds no wallet or account data, and sends only the token address to the price service.
 *
 * The element is created once and moved between renders by the caller, so the chart is not rebuilt every time the
 * screen redraws; it only reloads when the token or the timeframe changes.
 */
import { GeckoTerminalCandles, priceChangePercent, TIMEFRAMES, type CandleSeries, type CandleSource, type TimeframeId } from '../swings/charts/candles.js';
import { SwingsError, type ChainId } from '../swings/core/types.js';

export interface ChartPanel {
  element: HTMLElement;
  /** Shows the token's chart. Does nothing if it is already showing exactly this. */
  show(chain: ChainId, address: string, symbol: string): void;
  hide(): void;
}

const UP = '#1fa971';
const DOWN = '#e5484d';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const compactUsd = (n: number): string => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(0)}`);

/** A price with enough digits to be useful for both $60,000 coins and $0.0000004 ones. */
export function formatPrice(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return '–';
  if (p >= 1000) return p.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}

export function createChartPanel(source: CandleSource = new GeckoTerminalCandles()): ChartPanel {
  const element = node('div', 'wapp__stack');
  element.hidden = true;
  const title = node('span', 'wapp__eyebrow');
  const tfBar = node('div', 'wapp__seg');
  tfBar.setAttribute('role', 'group');
  tfBar.setAttribute('aria-label', 'Chart timeframe');
  const canvas = node('div', '');
  canvas.style.cssText = 'width:100%;height:260px;position:relative';
  canvas.setAttribute('role', 'img');
  const status = node('p', 'wapp__fine');
  const credit = node('p', 'wapp__fine');
  element.append(title, tfBar, canvas, status, credit);

  let timeframe: TimeframeId = '1h';
  let current: { chain: ChainId; address: string; symbol: string } | null = null;
  let loadedKey = '';
  let controller: AbortController | null = null;
  // The chart objects, created on first successful load.
  let chart: import('lightweight-charts').IChartApi | null = null;
  let candleSeries: import('lightweight-charts').ISeriesApi<'Candlestick'> | null = null;
  let volumeSeries: import('lightweight-charts').ISeriesApi<'Histogram'> | null = null;

  const buttons = (Object.keys(TIMEFRAMES) as TimeframeId[]).map((id) => {
    const b = node('button', 'wapp__chip wapp__chip--btn', TIMEFRAMES[id].label);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (timeframe === id) return;
      timeframe = id;
      load();
    });
    tfBar.append(b);
    return { id, b };
  });
  const markTimeframe = (): void => buttons.forEach(({ id, b }) => b.setAttribute('aria-pressed', String(id === timeframe)));

  function message(text: string): void {
    canvas.style.visibility = 'hidden';
    status.textContent = text;
    credit.textContent = '';
  }

  async function draw(series: CandleSeries, symbol: string, signal: AbortSignal): Promise<void> {
    const lw = await import('lightweight-charts');
    if (signal.aborted) return;
    const text = getComputedStyle(element).color || '#888';
    if (!chart) {
      chart = lw.createChart(canvas, {
        autoSize: true,
        layout: { background: { type: lw.ColorType.Solid, color: 'transparent' }, textColor: text },
        grid: { vertLines: { color: 'rgba(128,128,128,0.12)' }, horzLines: { color: 'rgba(128,128,128,0.12)' } },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
        crosshair: { mode: lw.CrosshairMode.Normal },
        localization: { priceFormatter: formatPrice },
      });
      candleSeries = chart.addSeries(lw.CandlestickSeries, { upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false, priceFormat: { type: 'custom', formatter: formatPrice, minMove: 1e-12 } });
      volumeSeries = chart.addSeries(lw.HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' });
      volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    }
    candleSeries!.setData(series.candles.map((c) => ({ time: c.time as import('lightweight-charts').UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    volumeSeries!.setData(series.candles.map((c) => ({ time: c.time as import('lightweight-charts').UTCTimestamp, value: c.volume, color: c.close >= c.open ? 'rgba(31,169,113,0.35)' : 'rgba(229,72,77,0.35)' })));
    chart.timeScale().fitContent();
    canvas.style.visibility = 'visible';
    const change = priceChangePercent(series.candles);
    const last = series.candles[series.candles.length - 1]!;
    title.textContent = `${symbol} price (USD) · ${formatPrice(last.close)}${change === null ? '' : ` · ${change >= 0 ? '+' : ''}${change.toFixed(2)}% over this range`}`;
    canvas.setAttribute('aria-label', `${symbol} price chart, last price ${formatPrice(last.close)}`);
    status.textContent = `Pool: ${series.poolName}${series.liquidityUsd === null ? '' : ` · liquidity ${compactUsd(series.liquidityUsd)}`}. Price comes from this pool only and can differ from other venues.`;
    credit.textContent = `Price data: ${series.source}. Chart: TradingView Lightweight Charts.`;
  }

  function load(): void {
    if (!current) return;
    markTimeframe();
    const { chain, address, symbol } = current;
    const key = `${chain}:${address}:${timeframe}`;
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    loadedKey = '';
    title.textContent = `${symbol} price (USD)`;
    status.textContent = 'Loading price history…';
    credit.textContent = '';
    source
      .candles(chain, address, timeframe, signal)
      .then(async (series) => {
        if (signal.aborted) return;
        await draw(series, symbol, signal);
        if (!signal.aborted) loadedKey = key;
      })
      .catch((e: unknown) => {
        if (signal.aborted) return;
        message(e instanceof SwingsError ? e.message : 'The chart could not be drawn.');
      });
  }

  return {
    element,
    show(chain, address, symbol) {
      const key = `${chain}:${address}:${timeframe}`;
      element.hidden = false;
      if (current && current.chain === chain && current.address === address && (loadedKey === key || controller)) {
        current.symbol = symbol;
        return;
      }
      current = { chain, address, symbol };
      load();
    },
    hide() {
      controller?.abort();
      controller = null;
      current = null;
      loadedKey = '';
      element.hidden = true;
    },
  };
}
