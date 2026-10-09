/**
 * The price chart for the Swings screens. It looks and works like the Trade tab's: a header with the token, its price
 * and 24h change, three stat cards (24h volume, liquidity, 24h trades), and GeckoTerminal's embedded TradingView chart
 * with its indicators toolbar and trades table underneath. It reuses the Trade tab's styles, so the two screens match.
 *
 * Which pool is shown is decided in src/swings/charts/pool.ts (pools paired with a major token first). The embed is a
 * third-party page in a sandboxed frame: it receives only the pool address in its URL, and nothing about the wallet.
 *
 * The element is created once and moved between renders by the caller, so the frame is not reloaded every time the
 * screen redraws; it only reloads when the token changes. The header refreshes every 30 seconds while it is on screen.
 */
import { dexScreenerEmbedUrl, type PoolInfo } from '../swings/charts/pool.js';
import { DexScreenerPoolFinder, type PoolFinder } from '../swings/charts/dexscreener.js';
import { cachedLogo } from '../swings/tokens/logos.js';
import { SwingsError, type ChainId } from '../swings/core/types.js';
import { TIMEFRAMES } from '../swings/market/candles.js';
import { drawCandles, fetchOwnCandles, MIN_CANDLES, OWN_TIMEFRAMES, type OwnTimeframe } from './walletOwnChart';

export interface ChartPanel {
  element: HTMLElement;
  /** Shows the token's chart. Does nothing if it is already showing exactly this token. */
  show(chain: ChainId, address: string, symbol: string, icon?: string | null): void;
  hide(): void;
}

const REFRESH_MS = 30_000;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const usd = (n: number | null): string => {
  if (n === null) return '–';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** A price with enough digits for both $60,000 coins and $0.0000004 ones. */
export function formatPrice(p: number | null): string {
  if (p === null || !Number.isFinite(p) || p <= 0) return '—';
  if (p >= 1000) return `$${p.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (p >= 1) return `$${p.toFixed(4)}`;
  return `$${p.toPrecision(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}`;
}

export function avatar(symbol: string, icon: string | null | undefined): HTMLElement {
  const initials = (): HTMLElement => node('span', 'wapp-avatar', symbol.slice(0, 2).toUpperCase());
  if (!icon || !/^https:\/\//.test(icon)) return initials();
  const img = node('img', 'wapp-avatar');
  img.alt = '';
  img.width = 32;
  img.height = 32;
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.src = icon;
  img.addEventListener('error', () => img.replaceWith(initials()), { once: true });
  return img;
}

export function createChartPanel(finder: PoolFinder = new DexScreenerPoolFinder()): ChartPanel {
  const element = node('div', 'wapp__chart wapp__stack');
  element.hidden = true;
  const head = node('div', 'wapp__chart-head');
  const title = node('div', 'wapp__chart-title');
  const live = node('span', 'wapp__live');
  live.hidden = true;
  live.append(node('i', ''), document.createTextNode('Live'));
  live.querySelector('i')!.setAttribute('aria-hidden', 'true');
  head.append(title, live);
  const priceRow = node('div', 'wapp__chart-price');
  const price = node('strong', '', '—');
  const change = node('span', '');
  priceRow.append(price, change);
  const stats = node('dl', 'wapp__chart-stats');
  const plot = node('div', 'wapp__chart-plot');
  plot.setAttribute('aria-live', 'polite');
  const note = node('p', 'wapp__fine');
  element.append(head, priceRow, stats, plot, note);

  let current: { chain: ChainId; address: string; symbol: string; icon: string | null } | null = null;
  let framedPool = '';
  let framedKind: 'own' | 'embed' | '' = '';
  let ownTf: OwnTimeframe = '1h';
  let seq = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  function renderHeader(info: PoolInfo | null): void {
    if (!current) return;
    title.textContent = '';
    // The header names the pair that is drawn. When the token is the pair's first token that is just "TOKEN / USD";
    // otherwise (the token is only ever the second token of its pools) it names the real pair, so header and chart agree.
    const mismatch = !!info && info.targetIsBase === false;
    const heading = mismatch ? `${info!.baseSymbol} / ${info!.quoteSymbol}` : `${current.symbol} / USD`;
    title.append(mismatch ? avatar(info!.baseSymbol ?? '?', info!.icon ?? null) : avatar(current.symbol, current.icon ?? info?.icon ?? cachedLogo(current.chain, current.address)), node('span', '', heading));
    price.textContent = formatPrice(info?.priceUsd ?? null);
    const c = info?.change24h ?? null;
    change.className = c === null ? '' : c > 0 ? 'is-up' : c < 0 ? 'is-down' : '';
    change.textContent = c === null ? '' : `${c >= 0 ? '+' : ''}${c.toFixed(2)}% · 24h`;
    stats.textContent = '';
    if (info) {
      for (const [k, v] of [['24h volume', usd(info.volume24hUsd)], ['Liquidity', usd(info.liquidityUsd)], ['24h trades', info.trades24h === null ? '–' : String(info.trades24h)]] as const) {
        const cell = node('div', '');
        cell.append(node('dt', '', k), node('dd', '', v));
        stats.append(cell);
      }
    }
    live.hidden = !info;
    note.textContent = info
      ? mismatch
        ? `${current.symbol} is the second token in its trading pools, so the chart shows ${info.baseSymbol} priced in ${info.quoteSymbol} (pool ${info.poolName}). The price is from this pool only and can differ from other venues.`
        : `Pool: ${info.poolName}. The price comes from this pool only and can differ from other venues.`
      : '';
  }

  function showMessage(text: string): void {
    plot.textContent = '';
    plot.append(node('span', 'wapp__sub', text));
    renderHeader(null);
    framedPool = '';
    framedKind = '';
  }

  function showEmbed(pool: string): void {
    if (!current) return;
    plot.textContent = '';
    const frame = node('iframe', 'wapp__chart-frame');
    frame.title = `${current.symbol} live price chart and trades`;
    frame.loading = 'lazy';
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    frame.src = dexScreenerEmbedUrl(current.chain, pool);
    plot.append(frame);
    framedPool = pool;
    framedKind = 'embed';
  }

  function showOwn(pool: string, candles: Parameters<typeof drawCandles>[1], since: number | null): void {
    if (!current) return;
    let canvas = plot.querySelector<HTMLCanvasElement>('canvas.wapp__own');
    if (framedKind !== 'own' || !canvas) {
      plot.textContent = '';
      const bar = node('div', 'wapp__seg');
      bar.setAttribute('role', 'group');
      bar.setAttribute('aria-label', 'Chart interval');
      for (const tf of OWN_TIMEFRAMES) {
        const b = node('button', 'wapp__chip wapp__chip--btn', tf);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(tf === ownTf));
        b.addEventListener('click', () => {
          ownTf = tf;
          framedKind = '';
          load();
        });
        bar.append(b);
      }
      canvas = node('canvas', 'wapp__own');
      canvas.style.cssText = 'width:100%;height:320px;display:block';
      canvas.setAttribute('role', 'img');
      plot.append(bar, canvas, node('p', 'wapp__fine', ''));
    }
    canvas.setAttribute('aria-label', `${current.symbol} price chart, ${ownTf} candles`);
    drawCandles(canvas, candles, TIMEFRAMES[ownTf]);
    const foot = plot.querySelector('p.wapp__fine');
    if (foot) foot.textContent = `Aretia's own record of this pool's price${since ? `, kept since ${new Date(since).toLocaleDateString()}` : ''}. Readings are taken every few minutes, and a gap is a period Aretia did not record.`;
    framedPool = pool;
    framedKind = 'own';
  }

  function load(): void {
    if (!current) return;
    const mine = ++seq;
    const { chain, address } = current;
    renderHeader(null);
    plot.textContent = '';
    plot.append(node('span', 'wapp__sub', 'Loading chart…'));
    finder
      .find(chain, address)
      .then((info) => {
        if (mine !== seq || !current) return;
        renderHeader(info);
        const { chain: c0, address: a0 } = current;
        void fetchOwnCandles(c0, info.pool, ownTf).then((own) => {
          if (mine !== seq || !current || current.chain !== c0 || current.address !== a0) return;
          if (own && own.candles.length >= MIN_CANDLES) {
            // Aretia's own record is long enough to draw.
            showOwn(info.pool, own.candles, own.since);
            return;
          }
          if (framedPool === info.pool && framedKind === 'embed' && plot.querySelector('iframe')) return;
          showEmbed(info.pool);
        });
      })
      .catch((e: unknown) => {
        if (mine !== seq) return;
        showMessage(e instanceof SwingsError ? e.message : 'The chart could not be loaded.');
      });
  }

  function startTimer(): void {
    clearInterval(timer);
    timer = setInterval(() => {
      // Stop when the panel is gone from the page or the tab is in the background.
      if (!element.isConnected || document.hidden || element.hidden || !current) return;
      const mine = seq;
      finder
        .find(current.chain, current.address, undefined, true)
        .then((info) => {
          if (mine === seq && current) renderHeader(info);
        })
        .catch(() => undefined);
    }, REFRESH_MS);
  }

  return {
    element,
    show(chain, address, symbol, icon = null) {
      element.hidden = false;
      if (current && current.chain === chain && current.address === address) {
        current.symbol = symbol;
        current.icon = icon;
        return;
      }
      current = { chain, address, symbol, icon };
      framedPool = '';
      framedKind = '';
      load();
      startTimer();
    },
    hide() {
      seq++;
      clearInterval(timer);
      current = null;
      framedPool = '';
      framedKind = '';
      plot.textContent = '';
      element.hidden = true;
    },
  };
}
