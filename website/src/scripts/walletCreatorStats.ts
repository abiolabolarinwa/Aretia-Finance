/**
 * "Your tokens" on the Your pools page: read-only analytics for the Aretia Curve tokens the connected wallet created, on the chosen
 * Ethereum-style network. The reading is in walletCreatorStatsFlow.ts and the arithmetic in walletCreatorStatsCore.ts. Nothing is
 * signed or sent here, and a figure that could not be read from the chain is said to be missing, never shown as zero. Everything read
 * from the chain is shown with textContent, never as markup.
 */
import { EVM_CURVE_ADDRESSES } from './walletCurveEvmCore';
import { chainByKey, type LaunchEvmChainKey } from './walletLaunchEvmCore';
import { readerFor } from './walletLaunchEvm';
import { friendlyEvmError } from './walletLaunchEvmFlow';
import { HistoryUnavailable, readCreatorStats, type CreatorListing, type TokenStats } from './walletCreatorStatsFlow';
import { CANNOT_SHOW, changeText, coinText, shareText } from './walletCreatorStatsCore';

export interface CreatorStatsHost {
  /** The network chosen on the Launch page (a LaunchEvmChainKey). */
  network(): string;
  getAccount(): string | null;
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function createCreatorStats(host: CreatorStatsHost, redraw: () => void): { draw(wrap: HTMLElement): void; load(): Promise<void>; reset(): void } {
  let listing: CreatorListing | null = null;
  let listingKey = '';
  let loading = false;
  let error: string | null = null;

  const keyNow = (): string => `${host.network()}:${host.getAccount()?.toLowerCase() ?? ''}`;
  const curveFor = (net: string): string | null => EVM_CURVE_ADDRESSES[net as LaunchEvmChainKey] ?? null;

  function drawToken(s: TokenStats, symbol: string, explorer: string): HTMLElement {
    const li = h('li', 'lh-pos');
    const top = h('div', 'lh-pos__top');
    top.append(h('h3', 'lh-pos__name', s.symbol));
    li.append(top);
    const rows = h('dl', 'lh-pos__rows');
    const row = (k: string, v: string | HTMLElement): void => {
      const d = h('div');
      const dd = h('dd');
      if (typeof v === 'string') dd.textContent = v;
      else dd.append(v);
      d.append(h('dt', '', k), dd);
      rows.append(d);
    };
    const a = h('a', '', short(s.token));
    a.href = `${explorer}/token/${encodeURIComponent(s.token)}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    row('Token', a);
    row('Holders', s.holders ? `${s.holders.count.toLocaleString('en-US')} wallet${s.holders.count === 1 ? '' : 's'} hold some` : 'Not shown (see below)');
    row('Held by you', s.holders ? `${shareText(s.holders.creatorBalance, s.holders.supply) ?? '0%'} of the supply` : 'Not shown (see below)');
    row('Trades on the Curve', s.totals ? `${s.totals.trades} (${s.totals.buys} buys, ${s.totals.sells} sells) by ${s.totals.traders} wallet${s.totals.traders === 1 ? '' : 's'}` : 'Not shown (see below)');
    row('Volume', s.totals ? coinText(s.totals.volume, symbol) : 'Not shown (see below)');
    row('Trading fees paid', s.totals ? `${coinText(s.totals.fees, symbol)} (paid to Aretia, not to you)` : 'Not shown (see below)');
    row('Last 7 days', s.change7 ? changeText(s.change7, 7, symbol) : 'Not shown (see below)');
    row('Last 30 days', s.change30 ? changeText(s.change30, 30, symbol) : 'Not shown (see below)');
    li.append(rows);
    for (const n of s.notes) li.append(h('p', 'wapp__banner wapp__banner--warn', n));
    return li;
  }

  function draw(wrap: HTMLElement): void {
    const net = host.network();
    const chain = chainByKey(net);
    const box = h('section', 'lh-yp__creator');
    box.append(h('h2', '', 'Your tokens'));
    const curve = curveFor(net);
    if (!chain || !curve) {
      box.append(h('p', 'lh-yp__none', 'The Aretia Curve is not live on this network, so there are no curve figures to show here.'));
      box.append(cannotShow());
      wrap.append(box);
      return;
    }
    if (!host.getAccount()) {
      box.append(h('p', 'lh-yp__none', `Connect an Ethereum-style wallet to see the tokens you created on the Aretia Curve on ${chain.name}.`));
      box.append(cannotShow());
      wrap.append(box);
      return;
    }
    box.append(h('p', 'wapp__fine', 'Read-only figures from the chain for the Aretia Curve tokens this wallet created. Nothing here is estimated: a figure that cannot be read is marked as not shown, never as zero.'));
    if (error) {
      const e = h('p', 'wapp__banner wapp__banner--warn', error);
      e.setAttribute('role', 'alert');
      box.append(e);
    }
    const mine = listing && listingKey === keyNow() ? listing : null;
    if (loading && !mine) box.append(h('p', 'lh-yp__none', 'Reading your tokens from the chain…'));
    else if (mine && mine.tokens.length === 0 && !error) box.append(h('p', 'lh-yp__none', `No Aretia Curve tokens created by this wallet on ${chain.name}. Looked from ${mine.readFrom}, before the Curve existed.`));
    if (mine && mine.tokens.length > 0) {
      const list = h('ul', 'lh-yp__list');
      for (const t of mine.tokens) list.append(drawToken(t, chain.symbol, chain.explorer));
      box.append(list);
      if (mine.truncated) box.append(h('p', 'wapp__fine', 'Showing the first 20 tokens.'));
    }
    const refresh = h('button', 'wapp__btn wapp__btn--ghost', loading ? 'Reading…' : 'Refresh your tokens');
    refresh.type = 'button';
    refresh.disabled = loading;
    refresh.addEventListener('click', () => void load());
    box.append(refresh, cannotShow());
    wrap.append(box);
  }

  function cannotShow(): HTMLElement {
    const d = h('details', 'lh-yp__cannot');
    d.append(h('summary', '', 'What this page cannot show'));
    const ul = h('ul', 'wapp__list');
    for (const t of CANNOT_SHOW) ul.append(h('li', '', t));
    d.append(ul);
    return d;
  }

  async function load(): Promise<void> {
    const net = host.network();
    const account = host.getAccount();
    const curve = curveFor(net);
    const chain = chainByKey(net);
    if (!account || !curve || !chain) return redraw();
    loading = true;
    error = null;
    redraw();
    try {
      const key = keyNow();
      const result = await readCreatorStats({ read: readerFor(chain), nowSeconds: () => Math.floor(Date.now() / 1000) }, curve, account);
      // The wallet or network may have changed while the logs were being read: only keep an answer that is still about the current one.
      if (key === keyNow()) {
        listing = result;
        listingKey = key;
      }
    } catch (e) {
      error =
        e instanceof HistoryUnavailable
          ? 'The free public nodes for this network only keep the last few hours of event history, so Aretia cannot list the tokens you created earlier without a paid node. Nothing is wrong with your tokens or your wallet. Their trades are on the explorer.'
          : `Could not read your tokens from the network: ${friendlyEvmError(e)}`;
    } finally {
      loading = false;
      redraw();
    }
  }

  return {
    draw,
    load,
    reset(): void {
      listing = null;
      listingKey = '';
      error = null;
    },
  };
}

/** The Solana version of the section: it says plainly that nothing can be shown, instead of a guess. */
export function drawSolanaCreatorNote(wrap: HTMLElement): void {
  const box = h('section', 'lh-yp__creator');
  box.append(h('h2', '', 'Your tokens'));
  box.append(h('p', 'lh-yp__none', 'Creator figures are for tokens made on the Aretia Curve on BNB Chain, Ethereum or Polygon. For Solana there is nothing to show yet: the Aretia Curve is not live on Solana mainnet, and Solana has no list of the tokens a wallet created. Switch the network to see yours on an Ethereum-style chain.'));
  wrap.append(box);
}
