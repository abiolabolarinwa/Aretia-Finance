/**
 * Phones: the "More" button in the wallet's bottom bar opens every section as a sheet (see the max-width 720px rules in
 * wallet/index.astro). Picking a section, tapping outside, pressing Escape or going to another page closes it. On wider
 * screens the button is hidden and this does nothing.
 */
export function initMoreSheet(root: HTMLElement | null = document.querySelector<HTMLElement>('[data-wapp]')): void {
  const more = root?.querySelector<HTMLButtonElement>('[data-more]');
  const scrim = root?.querySelector<HTMLElement>('[data-more-scrim]');
  const label = more?.querySelector<HTMLElement>('[data-more-label]');
  if (!root || !more || !scrim) return;
  // The dimmed backdrop belongs behind the sheet: inside the bar it was drawn over the sheet's own buttons and took their taps.
  root.append(scrim);
  const set = (open: boolean): void => {
    if (open) root.setAttribute('data-more-open', '');
    else root.removeAttribute('data-more-open');
    scrim.hidden = !open;
    more.setAttribute('aria-expanded', String(open));
    if (label) label.textContent = open ? 'Close' : 'More';
  };
  more.addEventListener('click', () => {
    const open = !root.hasAttribute('data-more-open');
    if (open) paintExtras();
    set(open);
  });

  // Phones: Appearance (light or dark) and Wallet live in this sheet instead of the site bar. They press the site bar's own buttons,
  // which stay on the page out of sight, so the theme and the wallet window behave exactly as before.
  const svg = (paths: string): SVGSVGElement => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '16');
    s.setAttribute('height', '16');
    s.setAttribute('aria-hidden', 'true');
    for (const d of paths.split('|')) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      s.append(p);
    }
    return s;
  };
  const extra = (cls: string, onPress: () => void): { b: HTMLButtonElement; label: HTMLSpanElement } => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `wapp__nav-extra ${cls}`;
    const label = document.createElement('span');
    label.className = 'wapp__label';
    b.addEventListener('click', () => {
      set(false);
      onPress();
    });
    more.before(b);
    return { b, label };
  };
  const theme = extra('wapp__nav-theme', () => document.querySelector<HTMLButtonElement>('header.nav [data-theme-toggle]')?.click());
  const wallet = extra('wapp__nav-wallet', () => document.querySelector<HTMLButtonElement>('header.nav .aw-connect-btn')?.click());
  function paintExtras(): void {
    const dark = document.documentElement.dataset.theme === 'dark';
    theme.label.textContent = dark ? 'Light mode' : 'Dark mode';
    theme.b.replaceChildren(svg(dark ? 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z|M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' : 'M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z'), theme.label);
    const on = document.querySelector('header.nav .aw-connect-btn')?.getAttribute('data-connected') === 'true';
    wallet.label.textContent = on ? 'Wallet' : 'Connect';
    wallet.b.classList.toggle('is-connected', on);
    wallet.b.replaceChildren(svg('M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3|M4 7.5V17a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H6.5A2.5 2.5 0 0 1 4 7.5z|M16 13.5h.01'), wallet.label);
  }
  paintExtras();
  scrim.addEventListener('click', () => set(false));
  root.querySelectorAll<HTMLElement>('.wapp__nav [data-nav]').forEach((b) => b.addEventListener('click', () => set(false)));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.hasAttribute('data-more-open')) set(false);
  });
  window.addEventListener('hashchange', () => set(false));
}
