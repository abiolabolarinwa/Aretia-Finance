/**
 * "Your token has a public page": the link and a Share button, added to the Launch, pool and curve done screens.
 * The page shows the token's price, chart and facts, and its Buy button opens the Aretia wallet's swap.
 */
import { isTokenPageChain, tokenPagePath, tokenPageUrl } from './tokenPageCore';

/** The text on the Share button after it has done its work. */
const DONE = 'Link copied';

/**
 * Appends a block with a link to the token's public page and a Share button. Does nothing for a network the page
 * does not cover (a test network, say), so a test token is never given a page link that would say "not found".
 */
export function appendTokenShare(into: HTMLElement, chainKey: string, address: string, symbol?: string): void {
  if (!isTokenPageChain(chainKey) || !address) return;
  const box = document.createElement('div');
  box.className = 'wapp__row wapp-tokenshare';
  const open = document.createElement('a');
  open.className = 'wapp__btn wapp__btn--primary';
  open.href = tokenPagePath(chainKey, address);
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = 'Open the public token page';
  const share = document.createElement('button');
  share.type = 'button';
  share.className = 'wapp__btn wapp__btn--ghost';
  share.textContent = 'Share';
  share.addEventListener('click', async () => {
    const url = tokenPageUrl(chainKey, address);
    const data = { title: `${symbol ?? 'My token'} on Aretia`, text: 'Price, chart and facts for this token, on Aretia.', url };
    try {
      if (typeof navigator.share === 'function') return void (await navigator.share(data));
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(url);
      share.textContent = DONE;
    } catch {
      share.textContent = url;
    }
    window.setTimeout(() => (share.textContent = 'Share'), 2400);
  });
  box.append(open, share);
  into.append(box);
}
