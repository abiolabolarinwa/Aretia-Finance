/**
 * The sponsor card for a wallet slot: a paid one when a sponsorship is running for it, otherwise Aretia's own "Sponsor
 * space" card pointing to /advertise. Plain text and one link, nothing loaded from the advertiser, nothing tracked.
 * Every paid card says "Ad" and who it is from, and its link says it is sponsored.
 */
import type { ChainId } from '../swings/core/types.js';
import { SPONSORS } from '../data/sponsors';
import { pickSponsor, sponsorsFor, type SlotId, type Sponsor } from '../lib/sponsors';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function link(text: string, href: string, rel: string, external: boolean): HTMLAnchorElement {
  const a = el('a', 'wapp-ad__cta', text);
  a.href = href;
  a.rel = rel;
  if (external) a.target = '_blank';
  return a;
}

function paid(s: Sponsor): HTMLElement {
  const box = el('aside', 'wapp-ad wapp-ad--paid');
  box.setAttribute('aria-label', `Advertisement from ${s.advertiser}`);
  const top = el('div', 'wapp-ad__top');
  top.append(el('span', 'wapp-ad__tag', 'Ad'), el('span', 'wapp-ad__by', s.advertiser));
  const body = el('div', 'wapp-ad__body');
  if (s.image) {
    const img = el('img', 'wapp-ad__img');
    img.alt = '';
    img.width = 36;
    img.height = 36;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.src = s.image;
    img.addEventListener('error', () => img.remove(), { once: true });
    body.append(img);
  }
  const text = el('div', 'wapp-ad__text');
  text.append(el('strong', '', s.headline), el('p', '', s.body));
  body.append(text);
  box.append(top, body, link(s.cta, s.href, 'sponsored nofollow noopener noreferrer', true));
  return box;
}

function house(compact: boolean): HTMLElement {
  const box = el('aside', `wapp-ad wapp-ad--house${compact ? ' wapp-ad--compact' : ''}`);
  box.setAttribute('aria-label', 'Sponsor space');
  const top = el('div', 'wapp-ad__top');
  top.append(el('span', 'wapp-ad__tag wapp-ad__tag--plain', 'Sponsor space'));
  const text = el('div', 'wapp-ad__text');
  text.append(el('strong', '', 'Reach people while they choose a token.'));
  if (!compact) text.append(el('p', '', 'A fixed-price sponsor card, clearly labelled, with no tracking.'));
  box.append(top, text, link('Advertise with Aretia', '/advertise', '', false));
  return box;
}

/** The card for a slot. `seed` keeps the same sponsor for the same token while the screen redraws. */
export function sponsorBlock(slot: SlotId, ctx: { chain?: ChainId; seed: string; compact?: boolean }, list: readonly Sponsor[] = SPONSORS, now: number = Date.now()): HTMLElement {
  const pick = pickSponsor(sponsorsFor(list, slot, now, ctx.chain ? { chain: ctx.chain } : {}), ctx.seed);
  return pick ? paid(pick) : house(ctx.compact === true);
}
