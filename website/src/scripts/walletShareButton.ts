/**
 * A Share button: the phone's own share sheet where there is one, otherwise the link is copied. Used on the token page; the Launch done
 * screens have their own (walletTokenLinks.ts) with the same behaviour.
 */
export interface ShareData {
  title: string;
  text: string;
  url: string;
}

const DONE = 'Link copied';

export function shareButton(data: ShareData, label = 'Share'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'wapp__btn wapp__btn--ghost wapp-tp__share';
  b.textContent = label;
  b.addEventListener('click', async () => {
    try {
      if (typeof navigator.share === 'function') return void (await navigator.share(data));
    } catch (e) {
      // The person closed the share sheet: nothing to do.
      if (e instanceof DOMException && e.name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(data.url);
      b.textContent = DONE;
    } catch {
      b.textContent = data.url;
    }
    window.setTimeout(() => (b.textContent = label), 2400);
  });
  return b;
}
