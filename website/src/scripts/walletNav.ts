/**
 * Which sidebar entry is marked as the current page for a view. The Swap page is the swap card on the same panel the
 * Markets page is built on, and it has no sidebar entry of its own (it is reached from Markets' Swap button, the
 * dashboard and the search box), so while it is open the Markets entry stays marked.
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
  if (hash === '#/swap' || hash.startsWith('#/swap/')) return 'swap-page';
  if (hash === '#/swings' || hash.startsWith('#/swings/') || hash === '#/favourites') return 'markets-dialog';
  return 'go-to-swap';
}

/** The page a person was last on, kept in this browser only so that opening the wallet again lands there. */
export const LAST_VIEW_KEY = 'aretia.wallet.lastView';
/** Pages worth coming back to. The dashboard is the default anyway, and a game page or a shared check is only ever opened by a link. */
const RESUMABLE = new Set(['send', 'swap', 'launch', 'launchbox', 'carbon', 'swings', 'favourites', 'radar', 'activity', 'referrals']);
type KeyValueStore = { getItem(k: string): string | null; setItem(k: string, v: string): void };

/** Remembers the page, or forgets it when it is not one to come back to. Never throws: storage may be blocked. */
export function rememberView(store: KeyValueStore | null, view: string): void {
  try {
    store?.setItem(LAST_VIEW_KEY, RESUMABLE.has(view) ? view : '');
  } catch {
    // not remembered
  }
}

/**
 * The page to open when the wallet is opened with no page named: only the plain "/wallet" address, never a link to a token, a page or a
 * check, so a shared link always opens what it points at. Null when there is nothing to go back to.
 */
export function viewToResume(store: KeyValueStore | null, pathname: string, hash: string): string | null {
  if (!/^\/wallet\/?$/.test(pathname) || (hash !== '' && hash !== '#')) return null;
  try {
    const v = store?.getItem(LAST_VIEW_KEY) ?? '';
    return RESUMABLE.has(v) ? v : null;
  } catch {
    return null;
  }
}
