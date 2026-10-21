/**
 * The public token page: /token#/<chain>/<address>. Anyone can open it from a shared link, with no wallet.
 * Each block reads its own source and fills in on its own, so a slow or failed source never blanks the rest;
 * a block that cannot read says so in words instead of showing an empty box or a made-up number.
 */
import { CHAINS } from '../swings/core/types.js';
import { DexScreenerPoolFinder } from '../swings/charts/dexscreener.js';
import { fetchPairDetail, type PairDetail } from '../swings/charts/pairDetail.js';
import { embedUrl, GECKO_NETWORK } from '../swings/charts/pool.js';
import { compactUsd, formatAge, formatChange, formatPrice } from '../swings/market/types.js';
import { searchTokens } from '../swings/tokens/globalSearch.js';
import { cleanText, isUnsafeName } from '../swings/tokens/safeText.js';
import { impersonationWarning } from '../swings/tokens/impersonation.js';
import { publicRead, readErc20 } from '../swings/chains/evmSession.js';
import { isChainEnabled, loadRuntime } from '../swings/runtime.js';
import { mountTvChart, preloadChartingLibrary, type TvChart } from './walletTvChart';
import { fetchAccount, loadWeb3 } from './walletSend';
import { parseMintAccount } from './walletLaunchChain';
import { curveAddress } from './walletCurveTx';
import { curveProgramFor, parseCurveAccount, curveShareHash } from './walletCurveCore';
import { evmCurveChain, parseCurveReturn, evmCurveShareHash } from './walletCurveEvmCore';
import { curveReadData } from './walletCurveEvmTx';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from './walletTools';
import {
  buyRoute,
  evmCurveView,
  evmTokenFacts,
  shareText,
  shortAddress,
  solanaCurveView,
  solanaMintFacts,
  solanaMintUnreadable,
  swapPath,
  tokenPageUrl,
  type CurveView,
  type Fact,
  type TokenPageRef,
} from './tokenPageCore';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const EXPLORER: Record<string, (a: string) => string> = {
  solana: (a) => `https://solscan.io/token/${a}`,
  bnb: (a) => `https://bscscan.com/token/${a}`,
  ethereum: (a) => `https://etherscan.io/token/${a}`,
  polygon: (a) => `https://polygonscan.com/token/${a}`,
};

function avatar(symbol: string, url: string | null): HTMLElement {
  const letters = el('span', 'tkp-avatar', (symbol || '?').slice(0, 2).toUpperCase());
  if (!url || !/^https:\/\//.test(url)) return letters;
  const img = el('img', 'tkp-avatar');
  img.alt = '';
  img.width = 56;
  img.height = 56;
  img.referrerPolicy = 'no-referrer';
  img.src = url;
  img.addEventListener('error', () => img.replaceWith(letters), { once: true });
  return img;
}

function section(title: string): { box: HTMLElement; body: HTMLElement } {
  const box = el('section', 'tkp-card');
  box.append(el('h2', 'tkp-h', title));
  const body = el('div', 'tkp-body');
  box.append(body);
  return { box, body };
}

function factList(facts: Fact[]): HTMLElement {
  const dl = el('dl', 'tkp-facts');
  for (const f of facts) {
    const row = el('div', `tkp-fact tkp-fact--${f.tone}`);
    row.append(el('dt', '', f.label), el('dd', '', f.value));
    dl.append(row);
  }
  return dl;
}

function stat(label: string, value: string): HTMLElement {
  const d = el('div', 'tkp-stat');
  d.append(el('span', 'tkp-k', label), el('strong', 'tkp-v', value));
  return d;
}

function copyButton(value: string, label: string): HTMLButtonElement {
  const b = el('button', 'tkp-copy', 'Copy');
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      b.textContent = 'Copied';
    } catch {
      b.textContent = 'Select and copy';
    }
    window.setTimeout(() => (b.textContent = 'Copy'), 1600);
  });
  return b;
}

export interface TokenPageHandle {
  dispose(): void;
}

export function mountPublicTokenPage(root: HTMLElement, ref: TokenPageRef): TokenPageHandle {
  const { chain, address } = ref;
  const info = CHAINS[chain];
  const ctl = new AbortController();
  let chart: TvChart | null = null;
  let alive = true;

  root.replaceChildren();
  const link = tokenPageUrl(chain, address);

  // ---- header
  const head = el('header', 'tkp-head');
  const title = el('div', 'tkp-title');
  const nameEl = el('h1', 'tkp-name', shortAddress(address));
  const subEl = el('p', 'tkp-sub', info.name);
  const logoHost = el('span', 'tkp-logohost');
  logoHost.append(avatar('?', null));
  title.append(nameEl, subEl);
  const addr = el('div', 'tkp-addr');
  addr.append(el('code', 'tkp-code', address), copyButton(address, 'Copy the token address'));
  const actions = el('div', 'tkp-actions');
  const buy = el('a', 'tkp-btn tkp-btn--primary', 'Buy in the Aretia wallet') as HTMLAnchorElement;
  buy.href = swapPath(chain, address);
  const share = el('button', 'tkp-btn', 'Share');
  share.type = 'button';
  const shareNote = el('p', 'tkp-fine');
  shareNote.setAttribute('role', 'status');
  actions.append(buy, share);
  head.append(logoHost, title, addr, actions, shareNote);

  let symbol = '';
  share.addEventListener('click', async () => {
    const data = { title: `${symbol || 'Token'} on Aretia`, text: shareText(symbol || 'This token', chain), url: link };
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share(data);
        return;
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(link);
      shareNote.textContent = 'Link copied.';
    } catch {
      shareNote.textContent = `Copy this link: ${link}`;
    }
  });

  const about = section('About this token');
  const market = section('Price and chart');
  const curve = section('Aretia Curve');
  curve.box.hidden = true;
  const warn = el('p', 'tkp-fine tkp-warn', 'Anyone can create a token, and Aretia does not endorse the tokens it shows. A token page shows what can be read from the chain, not whether the token is a good idea. Liquidity can be withdrawn by whoever put it there.');
  root.append(head, curve.box, market.box, about.box, warn);

  about.body.append(el('p', 'tkp-fine', 'Reading the chain…'));
  market.body.append(el('p', 'tkp-fine', 'Looking for the pool this token trades on…'));

  // A warning above everything else when the name is hidden or imitates a well-known token.
  const nameWarn = el('p', 'tkp-fine tkp-warn');
  nameWarn.setAttribute('role', 'alert');
  nameWarn.hidden = true;
  root.prepend(nameWarn);

  const setIdentity = (rawSym: string, rawName: string, icon: string | null): void => {
    // Names come from the token's creator: invisible and stacking characters are dropped, and a look-alike or abusive name is not shown.
    let sym = cleanText(rawSym, 32);
    let name = cleanText(rawName, 64);
    if (!sym) return;
    if (isUnsafeName(sym, name)) {
      nameWarn.textContent = 'This token’s name is hidden: it is abusive or uses look-alike letters to pass for another token. Check the address before you buy.';
      nameWarn.hidden = false;
      sym = shortAddress(address);
      name = '';
    } else {
      const imitates = impersonationWarning(chain, address, sym, name);
      nameWarn.textContent = imitates ?? '';
      nameWarn.hidden = imitates === null;
    }
    symbol = sym;
    nameEl.textContent = sym;
    subEl.textContent = `${name ? `${name} · ` : ''}${info.name}`;
    logoHost.replaceChildren(avatar(sym, icon));
    document.title = `${sym} on ${info.name} | Aretia`;
    buy.textContent = `Buy ${sym} in the Aretia wallet`;
  };

  // ---- identity and what the token itself says
  const factsRows: Fact[] = [];
  const paintAbout = (extra: Fact[] = []): void => {
    about.body.replaceChildren(factList([...factsRows, ...extra]));
    const ex = el('a', 'tkp-link', 'View on the block explorer') as HTMLAnchorElement;
    ex.href = EXPLORER[chain]!(address);
    ex.target = '_blank';
    ex.rel = 'noopener noreferrer';
    about.body.append(ex);
  };

  let mintDecimals: number | null = null;

  async function readSolana(): Promise<void> {
    try {
      const [web3, acc] = await Promise.all([loadWeb3(), fetchAccount(address)]);
      if (!alive) return;
      if (!acc || (acc.owner !== TOKEN_PROGRAM_ID && acc.owner !== TOKEN_2022_PROGRAM_ID)) {
        factsRows.push({ label: 'On-chain', value: 'No token mint exists at this address on Solana.', tone: 'unknown' });
        return paintAbout();
      }
      // The base layout is the same in both token programs; the reader insists on the Token-2022 owner, so tell it so.
      const facts = parseMintAccount(web3, TOKEN_2022_PROGRAM_ID, acc.data);
      if (!facts) {
        factsRows.push(...solanaMintUnreadable());
        return paintAbout();
      }
      mintDecimals = facts.decimals;
      if (facts.metadata) setIdentity(facts.metadata.symbol, facts.metadata.name, null);
      factsRows.push(...solanaMintFacts(facts));
      factsRows.push({ label: 'Token program', value: acc.owner === TOKEN_2022_PROGRAM_ID ? 'Token-2022' : 'SPL Token', tone: 'plain' });
      paintAbout();
      void readSolanaCurve(web3);
    } catch {
      if (!alive) return;
      factsRows.push(...solanaMintUnreadable());
      paintAbout();
    }
  }

  async function readSolanaCurve(web3: Awaited<ReturnType<typeof loadWeb3>>): Promise<void> {
    const program = curveProgramFor('mainnet');
    if (!program) return; // the Solana curve program is not on mainnet yet, so there is nothing to read
    try {
      const acc = await fetchAccount(curveAddress(web3, program, address));
      const c = acc ? parseCurveAccount(web3, acc.owner, program, acc.data) : null;
      if (!alive || !c || mintDecimals === null) return;
      paintCurve(solanaCurveView(c, mintDecimals), `/wallet${curveShareHash(address)}`);
    } catch {
      // no curve found or unreadable: the block stays hidden
    }
  }

  async function readEvm(): Promise<void> {
    const read = publicRead(chain);
    try {
      const facts = await readErc20(read, address);
      if (!alive) return;
      if (!facts) {
        factsRows.push({ label: 'On-chain', value: `No readable ERC-20 token exists at this address on ${info.name}.`, tone: 'unknown' });
        return paintAbout();
      }
      mintDecimals = facts.decimals;
      setIdentity(facts.symbol, facts.name, null);
      let supply: bigint | null = null;
      try {
        const hex = await read('eth_call', [{ to: address, data: '0x18160ddd' }, 'latest']);
        if (typeof hex === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(hex)) supply = BigInt(hex);
      } catch {
        supply = null;
      }
      if (!alive) return;
      factsRows.push(...evmTokenFacts(supply, facts.decimals));
      paintAbout();
      const cc = evmCurveChain(chain);
      if (cc) {
        try {
          const state = parseCurveReturn(await read('eth_call', [{ to: cc.curve, data: curveReadData(address) }, 'latest']));
          const view = state ? evmCurveView(state, facts.decimals, cc.symbol) : null;
          if (alive && view) paintCurve(view, `/wallet${evmCurveShareHash(chain, address)}`);
        } catch {
          // unreadable: the block stays hidden
        }
      }
    } catch {
      if (!alive) return;
      factsRows.push({ label: 'On-chain', value: 'Could not be read just now. Try again in a moment.', tone: 'unknown' });
      paintAbout();
    }
  }

  let curveShown: CurveView | null = null;
  function paintCurve(v: CurveView, openPath: string): void {
    curveShown = v;
    curve.box.hidden = false;
    const bar = el('div', 'tkp-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(v.percent));
    bar.setAttribute('aria-label', 'Share of the curve sold');
    const fill = el('span', 'tkp-bar-fill');
    fill.style.width = `${v.percent}%`;
    bar.append(fill);
    const grid = el('div', 'tkp-grid2');
    grid.append(stat('Raised', `${v.raised} ${v.coin}`), stat('Target', `${v.target} ${v.coin}`), stat('Price now', `${v.priceNow} ${v.coin} per token`), stat('Sold', `${v.percent}%`));
    curve.body.replaceChildren(el('p', 'tkp-status', v.statusText), bar, grid, el('p', 'tkp-fine', `Creator: ${shortAddress(v.creator)}. Read from the curve on-chain. The Aretia Curve has not been through a completed independent audit.`));
    if (buyRoute(v, true) === 'curve') {
      const a = el('a', 'tkp-btn tkp-btn--primary', 'Buy on the curve') as HTMLAnchorElement;
      a.href = openPath;
      curve.body.append(a);
      buy.href = openPath;
      buy.textContent = 'Buy on the Aretia Curve';
    }
  }

  // ---- identity from search (name, picture) when the chain itself does not carry them
  void searchTokens(address, undefined, ctl.signal, { accept: (h) => h.chain === chain && (chain === 'solana' ? h.address === address : h.address.toLowerCase() === address), limit: 1 })
    .then((hits) => {
      const h = hits[0];
      if (alive && h && (!symbol || !logoHost.querySelector('img'))) setIdentity(h.symbol, h.name, h.icon);
    })
    .catch(() => undefined);

  // ---- market: the pool, the numbers, the chart
  preloadChartingLibrary();
  const finder = new DexScreenerPoolFinder();
  void (async () => {
    try {
      const found = await finder.find(chain, address, ctl.signal);
      if (!alive) return;
      let detail: PairDetail | null = null;
      try {
        detail = await fetchPairDetail(chain, found.pool, undefined, undefined, ctl.signal);
      } catch {
        detail = null;
      }
      if (!alive) return;
      if (detail && (!symbol || symbol === '')) setIdentity(detail.baseSymbol, detail.name, detail.icon);
      else if (detail && detail.icon && !logoHost.querySelector('img')) logoHost.replaceChildren(avatar(symbol, detail.icon));
      const plot = el('div', 'tkp-chart');
      plot.setAttribute('role', 'img');
      plot.setAttribute('aria-label', `${symbol || 'Token'} price chart`);
      const stats = el('div', 'tkp-grid2');
      if (detail) {
        stats.append(stat('Price', formatPrice(detail.priceUsd)), stat('24h change', formatChange(detail.change.h24)), stat('Liquidity', compactUsd(detail.liquidityUsd)), stat('Volume 24h', compactUsd(detail.volumeUsd.h24)), stat('Market cap', compactUsd(detail.marketCapUsd)), stat('Pool age', formatAge(detail.ageMs)));
      }
      const poolLine = el('p', 'tkp-fine', `Trades on ${detail?.dex ?? 'a pool'} (${detail ? `${detail.baseSymbol} / ${detail.quoteSymbol}` : 'pair not named'}) on ${info.name}. Pool: ${shortAddress(found.pool)}. Whether this pool’s liquidity is locked cannot be read here; check the pool itself.`);
      market.body.replaceChildren(stats, plot, poolLine);
      chart = mountTvChart(plot, { chain, pool: found.pool, symbol: symbol || detail?.baseSymbol || 'Token', ...(detail?.quoteSymbol ? { quoteSymbol: detail.quoteSymbol } : {}), priceHint: detail?.priceUsd ?? null, interval: '15', toolbar: window.matchMedia('(min-width: 720px)').matches, fallbackUrl: embedUrl({ network: GECKO_NETWORK[chain], pool: found.pool }), title: `${symbol || 'Token'} price chart` });
    } catch {
      if (!alive) return;
      market.body.replaceChildren(el('p', 'tkp-fine', curveShown ? 'No chart yet. While the curve is open this token has no pool to chart; it will appear here once it moves to one.' : 'No trading pool was found for this token yet, so there is no price or chart to show. Brand-new tokens can take a few minutes to appear.'));
    }
  })();

  // ---- the swap route: say so when the network’s swaps are off
  void loadRuntime().then(() => {
    if (!alive) return;
    if (buyRoute(curveShown, isChainEnabled(chain)) === 'off') {
      buy.removeAttribute('href');
      buy.setAttribute('aria-disabled', 'true');
      buy.textContent = `Swaps on ${info.name} are off right now`;
    }
  });

  if (info.kind === 'solana') void readSolana();
  else void readEvm();

  return {
    dispose() {
      alive = false;
      ctl.abort();
      chart?.dispose();
      chart = null;
      root.replaceChildren();
    },
  };
}
