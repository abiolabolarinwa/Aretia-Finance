/**
 * Draws the "Featured launches" strip into a container. It lives inside the Aretia web wallet (Markets and Launch), never on the
 * public home page; see src/scripts/walletFeatured.ts for how it is mounted there. Anything else can call it the same way:
 *
 *   import { renderFeatured } from '../lib/featuredStrip';
 *   renderFeatured(document.querySelector('[data-featured]'));
 *
 * It draws only what src/lib/featured.ts says is running today, and when there is nothing to show it hides the container and
 * draws nothing. It styles itself. Everything is set with textContent; links are built from the validated address, never from markup.
 */
import { FEATURED } from '../data/featured';
import { VERIFIED } from '../data/verified';
import { FEATURED_LABEL, FEATURED_NOTE, featuredNow, tokenHref, type FeaturedItem } from './featured';
import { verifiedBadge } from './verifiedBadge';
import type { VerifiedEntry } from './verified';

const STYLE_ID = 'aretia-featured-style';
const CSS = `
.aft{display:grid;gap:.5rem;margin:0;padding:0;color:#0e0b2b;font-family:inherit}
.aft[hidden]{display:none}
.aft__head{display:flex;align-items:baseline;justify-content:space-between;gap:.75rem}
.aft__head h2{margin:0;font-size:.8rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.aft__head a{font-size:.78rem;font-weight:600;color:inherit;text-decoration:underline;text-underline-offset:3px;white-space:nowrap}
.aft__list{display:flex;gap:.6rem;margin:0;padding:0 0 .25rem;list-style:none;overflow-x:auto;scroll-snap-type:x proximity;-webkit-overflow-scrolling:touch}
.aft__list>li{flex:0 0 min(17rem,82%);scroll-snap-align:start;min-width:0}
.aft__card{display:grid;grid-template-columns:auto 1fr;gap:.2rem .65rem;align-items:center;height:100%;padding:.7rem .8rem;color:inherit;text-decoration:none;background:#fff;border:1px solid rgba(14,11,43,.12);border-radius:14px}
.aft__card:focus-visible{outline:2px solid var(--color-brand-bright,#2a9d6b);outline-offset:2px}
.aft__img{grid-row:1/4;width:2.6rem;height:2.6rem;border-radius:10px;object-fit:cover;background:#e9e9ef}
.aft__tag{grid-column:2;font-size:.64rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#4a4670}
.aft__card:not(:has(.aft__img)) .aft__tag,.aft__card:not(:has(.aft__img)) .aft__title,.aft__card:not(:has(.aft__img)) .aft__blurb,.aft__card:not(:has(.aft__img)) .aft__v{grid-column:1/-1}
.aft__title{grid-column:2;font-size:.95rem;line-height:1.2;overflow-wrap:anywhere}
.aft__blurb{grid-column:2;font-size:.82rem;line-height:1.35;color:#1d1a3d;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.aft__v{grid-column:2}
.aft__note{margin:0;font-size:.7rem;line-height:1.35;color:#4a4670}
@media (hover:hover){.aft__card:hover{border-color:rgba(14,11,43,.35)}}
@media (min-width:900px){.aft--stack .aft__list{flex-direction:column;overflow:visible}.aft--stack .aft__list>li{flex:none}}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.append(s);
}

const CHAIN_NAME: Record<string, string> = { solana: 'Solana', bnb: 'BNB Chain', ethereum: 'Ethereum', polygon: 'Polygon' };

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export function featuredCard(i: FeaturedItem, verified: readonly VerifiedEntry[] = VERIFIED, now: number = Date.now()): HTMLElement {
  const li = el('li');
  const a = el('a', 'aft__card');
  a.href = tokenHref(i);
  if (i.image) {
    const img = el('img', 'aft__img');
    img.alt = '';
    img.width = 42;
    img.height = 42;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.src = i.image;
    img.addEventListener('error', () => img.remove(), { once: true });
    a.append(img);
  }
  a.append(el('span', 'aft__tag', `${FEATURED_LABEL} · ${CHAIN_NAME[i.chain] ?? i.chain}`), el('strong', 'aft__title', i.title), el('span', 'aft__blurb', i.blurb));
  // A link cannot hold a button, so the badge here is the plain label; its dialog is one tap away on the token's page.
  const badge = verifiedBadge(i.chain, i.token, { plain: true, list: verified, now });
  if (badge) {
    badge.classList.add('aft__v');
    a.append(badge);
  }
  li.append(a);
  return li;
}

/**
 * Fills `box` with the strip, or hides it and leaves it empty when nothing is running. `stack` lays the cards in a column on wide
 * screens (for a narrow home-page column); otherwise they stay in a scrolling row. Returns how many items are showing.
 */
export function renderFeatured(box: HTMLElement | null, opts: { stack?: boolean; onGetFeatured?: () => void; list?: readonly FeaturedItem[]; verified?: readonly VerifiedEntry[]; now?: number } = {}): number {
  if (!box) return 0;
  const now = opts.now ?? Date.now();
  const items = featuredNow(opts.list ?? FEATURED, now);
  box.textContent = '';
  if (items.length === 0) {
    box.hidden = true;
    return 0;
  }
  ensureStyle();
  box.classList.add('aft');
  box.classList.toggle('aft--stack', opts.stack === true);
  const head = el('div', 'aft__head');
  head.append(el('h2', '', 'Featured launches'));
  const get = el('a', '', 'Get featured');
  get.href = '/featured#request';
  get.target = '_blank';
  get.rel = 'noopener';
  const open = opts.onGetFeatured;
  if (open) {
    // Inside the wallet the request form opens on the spot instead of leaving it.
    get.removeAttribute('target');
    get.addEventListener('click', (e) => {
      e.preventDefault();
      open();
    });
  }
  head.append(get);
  const list = el('ul', 'aft__list');
  for (const i of items) list.append(featuredCard(i, opts.verified ?? VERIFIED, now));
  box.append(head, list, el('p', 'aft__note', FEATURED_NOTE));
  box.hidden = false;
  return items.length;
}
