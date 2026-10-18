/**
 * "Featured launches" inside the web wallet: a labelled strip at the top of the Markets list and on the Launch page. It is drawn only
 * while src/data/featured.ts has an item running today; with nothing to show it draws nothing at all. It never appears outside the wallet.
 */
import { renderFeatured } from '../lib/featuredStrip';
import { openPromote } from './walletPromote';

/** A strip for the Markets list, or null when nothing is featured today. */
export function featuredForMarkets(): HTMLElement | null {
  const box = document.createElement('section');
  box.className = 'wapp-feat';
  box.setAttribute('aria-label', 'Featured launches');
  return renderFeatured(box, { onGetFeatured: () => openPromote('featured') }) > 0 ? box : null;
}

/** Fills the strip on the Launch page (the element with data-featured-launch), and hides it when nothing is featured. */
export function mountLaunchFeatured(root: ParentNode = document): void {
  const box = root.querySelector<HTMLElement>('[data-featured-launch]');
  if (box) renderFeatured(box, { onGetFeatured: () => openPromote('featured') });
  // The entry is always there, so a creator can ask even while nothing is featured.
  root.querySelector<HTMLElement>('[data-promote-open]')?.addEventListener('click', () => openPromote('featured'));
}
