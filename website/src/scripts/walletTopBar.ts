/**
 * Phones: the site bar shows the connected wallet's value (the same figure as the dashboard's portfolio card) with a Deposit button,
 * or a Connect button before a wallet is connected. Search becomes a round button beside the bottom bar that opens the search box
 * over the page. Wider screens keep their bar as it was (see the max-width 720px rules in wallet/index.astro).
 */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** What the balance button says: the dashboard's total once it is known, a dash before. */
export function balanceText(total: string | null | undefined): string {
  const t = (total ?? '').trim();
  return t === '' || t === '—' ? '—' : t;
}

export function initTopBar(): void {
  const bar = document.querySelector<HTMLElement>('header.nav .nav__bar');
  const root = document.querySelector<HTMLElement>('[data-wapp]');
  if (!bar || !root || bar.querySelector('.nav-balance')) return;

  const box = el('div', 'nav-balance');
  const value = el('button', 'nav-balance__value', '—');
  value.type = 'button';
  value.title = 'Your wallet’s value: open Home';
  value.addEventListener('click', () => {
    location.hash = '#/dashboard';
  });
  const connect = el('button', 'nav-balance__btn', 'Connect');
  connect.type = 'button';
  connect.addEventListener('click', () => document.querySelector<HTMLElement>('[data-connect]')?.click());
  const deposit = el('button', 'nav-balance__btn nav-balance__deposit', 'Deposit');
  deposit.setAttribute('aria-label', 'Deposit');
  deposit.type = 'button';
  deposit.title = 'Receive crypto, or top up with a card or bank transfer';
  deposit.addEventListener('click', () => {
    location.hash = '#/send';
    // Pay opens on Send; Deposit means its Receive choice.
    window.setTimeout(() => document.querySelector<HTMLElement>('[data-pay-tab="receive"]')?.click(), 60);
  });
  box.append(value, connect, deposit);
  const brand = bar.querySelector('.nav__brand');
  if (brand) brand.after(box);
  else bar.prepend(box);

  const total = document.querySelector<HTMLElement>('[data-total]');
  const sync = (): void => {
    const on = root.dataset.connected === 'true';
    value.hidden = !on;
    deposit.hidden = !on;
    connect.hidden = on;
    value.textContent = balanceText(total?.textContent);
  };
  if (total) new MutationObserver(sync).observe(total, { childList: true, characterData: true, subtree: true });
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-connected'] });
  sync();

  // Search: a round button beside the bottom bar opens the search box over the page; Escape or a tap elsewhere closes it.
  const fab = el('button', 'wapp-search-fab');
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Search any token');
  fab.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M16 16l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  document.body.append(fab);
  const html = document.documentElement;
  const close = (): void => html.classList.remove('is-searching');
  fab.addEventListener('click', () => {
    const open = !html.classList.contains('is-searching');
    html.classList.toggle('is-searching', open);
    if (open) window.setTimeout(() => document.querySelector<HTMLInputElement>('[data-wapp-search] input')?.focus(), 30);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Node;
    if (!html.classList.contains('is-searching') || fab.contains(t) || document.querySelector('[data-wapp-search]')?.contains(t)) return;
    close();
  });
  window.addEventListener('hashchange', close);
}
