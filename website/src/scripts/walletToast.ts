/**
 * The small pop-up for price alerts. One shows at a time, stays for exactly two seconds, then is removed at once; any
 * others wait their turn. It is announced politely to screen readers, and the Favourites page keeps a list of recent
 * alerts so nothing is lost once a pop-up has gone.
 */
export const TOAST_MS = 2000;

export interface Toast {
  title: string;
  detail?: string;
  /** Colours the edge: up (green), down (red) or plain. The title also carries an arrow, so colour is never the only signal. */
  tone?: 'up' | 'down' | 'info';
  icon?: string | null;
}

export function createToaster(doc: Document = document, ms: number = TOAST_MS) {
  const queue: Toast[] = [];
  let host: HTMLElement | null = null;
  let showing = false;

  function ensureHost(): HTMLElement {
    if (host?.isConnected) return host;
    host = doc.createElement('div');
    host.className = 'wapp-toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    doc.body.append(host);
    return host;
  }

  function next(): void {
    const t = queue.shift();
    if (!t) {
      showing = false;
      return;
    }
    showing = true;
    const box = doc.createElement('div');
    box.className = `wapp-toast wapp-toast--${t.tone ?? 'info'}`;
    if (t.icon && /^https:\/\//.test(t.icon)) {
      const img = doc.createElement('img');
      img.alt = '';
      img.width = 28;
      img.height = 28;
      img.referrerPolicy = 'no-referrer';
      img.src = t.icon;
      img.addEventListener('error', () => img.remove(), { once: true });
      box.append(img);
    }
    const text = doc.createElement('div');
    const title = doc.createElement('strong');
    title.textContent = t.title;
    text.append(title);
    if (t.detail) {
      const d = doc.createElement('span');
      d.textContent = t.detail;
      text.append(d);
    }
    box.append(text);
    ensureHost().replaceChildren(box);
    setTimeout(() => {
      box.remove();
      next();
    }, ms);
  }

  return {
    show(t: Toast): void {
      queue.push(t);
      if (!showing) next();
    },
  };
}
