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
  more.addEventListener('click', () => set(!root.hasAttribute('data-more-open')));
  scrim.addEventListener('click', () => set(false));
  root.querySelectorAll<HTMLElement>('.wapp__nav [data-nav]').forEach((b) => b.addEventListener('click', () => set(false)));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.hasAttribute('data-more-open')) set(false);
  });
  window.addEventListener('hashchange', () => set(false));
}
