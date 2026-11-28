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
  b.setAttribute('aria-label', label);
  // A share icon and the word; phones show the icon alone (wallet/index.astro).
  b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" class="wapp-share__icon"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 12v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const text = document.createElement('span');
  text.className = 'wapp-share__text';
  text.textContent = label;
  b.append(text);
  b.addEventListener('click', async () => {
    try {
      if (typeof navigator.share === 'function') return void (await navigator.share(data));
    } catch (e) {
      // The person closed the share sheet: nothing to do.
      if (e instanceof DOMException && e.name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(data.url);
      text.textContent = DONE;
    } catch {
      text.textContent = data.url;
    }
    b.classList.add('is-done');
    window.setTimeout(() => {
      text.textContent = label;
      b.classList.remove('is-done');
    }, 2400);
  });
  return b;
}
