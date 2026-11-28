/**
 * Phones: Settings, opened from the Settings tile in the logo's sheet. One place for what a person sets for themselves:
 * appearance, hiding amounts, notifications and price alerts, locking the wallet, the connected wallet, what this phone keeps
 * (recently viewed tokens, saved recipients) and help. Every row uses the control the page already has (the theme switch, the eye
 * button, the bell, the lock, the wallet button), so each setting behaves exactly as it does elsewhere.
 */
import { clearRecent, loadRecent } from './walletRecentTokens';
import { BOOK_KEY } from './walletAddressBook';
import { openInsight, closeInsight } from './walletInsights';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const press = (sel: string): void => document.querySelector<HTMLElement>(sel)?.click();

function savedCount(): number {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(BOOK_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.length : 0;
  } catch {
    return 0;
  }
}

function section(title: string, rows: HTMLElement[]): HTMLElement {
  const s = el('section', 'wst__sec');
  s.append(el('h3', 'wst__title', title));
  const list = el('div', 'wst__list');
  list.append(...rows);
  s.append(list);
  return s;
}

/** A row: a name, a line under it, and either a control on the right or a chevron when the whole row is a button. */
function row(name: string, sub: string, right: HTMLElement | null, onPress?: () => void): HTMLElement {
  const r = el(onPress ? 'button' : 'div', 'wst__row');
  if (r instanceof HTMLButtonElement) {
    r.type = 'button';
    r.addEventListener('click', onPress!);
  }
  const text = el('span', 'wst__text');
  text.append(el('strong', '', name));
  if (sub) text.append(el('small', '', sub));
  r.append(text, right ?? el('span', 'wst__chev', '›'));
  return r;
}

function toggle(on: boolean, label: string, flip: () => void): HTMLButtonElement {
  const b = el('button', 'wst__switch');
  b.type = 'button';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', String(on));
  b.setAttribute('aria-label', label);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    flip();
    b.setAttribute('aria-checked', String(b.getAttribute('aria-checked') !== 'true'));
  });
  return b;
}

/** Builds the page fresh each time it opens, so every value is the current one. */
export function settingsPage(): HTMLElement {
  const page = el('div', 'wst');
  const go = (hash: string): void => {
    closeInsight();
    location.hash = hash;
  };
  const then = (fn: () => void) => (): void => {
    closeInsight();
    window.setTimeout(fn, 60);
  };

  // Appearance
  const dark = document.documentElement.dataset.theme === 'dark';
  const seg = el('div', 'wst__seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Appearance');
  for (const [mode, label] of [['light', 'Light'], ['dark', 'Dark']] as const) {
    const b = el('button', '', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String((mode === 'dark') === dark));
    b.addEventListener('click', () => {
      const isDark = document.documentElement.dataset.theme === 'dark';
      if ((mode === 'dark') !== isDark) press('header.nav [data-theme-toggle]');
      seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
    seg.append(b);
  }
  const hideBtn = document.querySelector<HTMLElement>('[data-hide]');
  page.append(
    section('Appearance', [
      row('Theme', 'Light or dark, on this device', seg),
      row('Hide amounts', 'Show •••• instead of balances and values', toggle(hideBtn?.getAttribute('aria-pressed') === 'true', 'Hide amounts', () => hideBtn?.click())),
    ]),
  );

  // Notifications
  const browserOn = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  page.append(
    section('Notifications', [
      row('Notifications', 'What Aretia told you recently', null, then(() => press('[data-bell]'))),
      row('Price alerts', 'Phone or Telegram alerts for your favourites', null, () => go('#/favourites')),
      row('This phone', browserOn === 'granted' ? 'Allowed to show notifications' : browserOn === 'denied' ? 'Blocked: allow Aretia in the phone settings' : browserOn === 'default' ? 'Not asked yet: turn alerts on in Price alerts' : 'Not available here', el('span', `wst__dot is-${browserOn}`)),
    ]),
  );

  // Wallet and security
  const connected = document.querySelector('header.nav .aw-connect-btn')?.getAttribute('data-connected') === 'true';
  page.append(
    section('Wallet and security', [
      row(connected ? 'Connected wallet' : 'Connect a wallet', connected ? 'Switch or disconnect' : 'Phantom, Solflare and others', null, then(() => press('header.nav .aw-connect-btn'))),
      row('Lock wallet', 'Protect this wallet on this device', null, then(() => press('[data-lock]'))),
      row('Shield', 'Check a token or an address before you trust it', null, () => go('#/shield')),
    ]),
  );

  // On this device
  const recent = loadRecent().length;
  const people = savedCount();
  const clearBtn = el('button', 'wst__link', recent > 0 ? 'Clear' : 'None');
  clearBtn.type = 'button';
  clearBtn.disabled = recent === 0;
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearRecent();
    clearBtn.textContent = 'Cleared';
    clearBtn.disabled = true;
  });
  page.append(
    section('On this device', [
      row('Recently viewed tokens', recent === 1 ? '1 token' : `${recent} tokens`, clearBtn),
      row('Saved recipients', people === 1 ? '1 recipient, used in Pay' : `${people} recipients, used in Pay`, null, () => go('#/send')),
    ]),
  );

  // Help
  const link = (name: string, sub: string, href: string): HTMLElement => {
    const a = el('a', 'wst__row');
    a.href = href;
    const text = el('span', 'wst__text');
    text.append(el('strong', '', name), el('small', '', sub));
    a.append(text, el('span', 'wst__chev', '›'));
    return a;
  };
  page.append(
    section('Help and about', [
      link('Contact support', 'Ask a question or report a problem', '/contact'),
      link('Terms', 'The terms of using Aretia', '/terms'),
      link('Privacy', 'What Aretia keeps and why', '/privacy'),
    ]),
  );
  page.append(el('p', 'wst__foot', 'Aretia never holds your keys. Settings here are kept on this device only.'));
  return page;
}

export function openSettings(): void {
  openInsight({ label: 'Settings', el: settingsPage() });
}
