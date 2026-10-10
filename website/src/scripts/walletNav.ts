/**
 * Which sidebar entry is marked as the current page for a view. The Swap page is the swap card on the same panel the
 * Markets page is built on, and it has no sidebar entry of its own (it is reached from Markets' Swap button, the
 * dashboard, Intent and the search box), so while it is open the Markets entry stays marked.
 */
export function sidebarItemFor(view: string): string {
  return view === 'swap' ? 'swings' : view;
}

/** Where a token opened from a "swap into this token" button, or the search box, should open, given the page the person is on. */
export type TokenOpenMode = 'swap-page' | 'markets-dialog' | 'go-to-swap';

/**
 * On the Swap page the swap is already there. On Markets, and on Favourites (which is the Markets list filtered to
 * the person's favourites), the swap opens as a window over the list, so they stay where they were. From any other
 * page the wallet goes to the Swap page.
 */
export function tokenOpenMode(hash: string): TokenOpenMode {
  if (hash === '#/swap') return 'swap-page';
  if (hash === '#/swings' || hash === '#/favourites') return 'markets-dialog';
  return 'go-to-swap';
}
