/**
 * The site's anonymous counters for the owner's admin page (docs/admin-page.md). Each call sends a few words to /api/swings-beacon:
 * that a visit happened, that a swap ended (network, the two coin symbols, the wallet's name) or that something failed (a category
 * and the kind of error, never its message). No address, amount, transaction, cookie or identifier is sent, and the server adds one to
 * a daily count without storing the visitor's IP. Nothing is sent when the browser says Do Not Track or Global Privacy Control, and a
 * failed send is dropped.
 */
const MAX_ISSUES_PER_PAGE = 5;
let issuesSent = 0;
let started = false;

function optedOut(): boolean {
  try {
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
    return nav.doNotTrack === '1' || nav.globalPrivacyControl === true || location.pathname.startsWith('/owner-admin');
  } catch {
    return true;
  }
}

export function sendBeacon(payload: Record<string, unknown>): void {
  try {
    if (optedOut() || typeof navigator.sendBeacon !== 'function') return;
    navigator.sendBeacon('/api/swings-beacon', new Blob([JSON.stringify(payload)], { type: 'text/plain' }));
  } catch {
    // dropped on purpose
  }
}

export function trackIssue(area: string, detail?: string): void {
  if (issuesSent >= MAX_ISSUES_PER_PAGE) return;
  issuesSent++;
  sendBeacon({ k: 'issue', area, detail });
}

const reported = new Set<string>();
/** A swap that ended. Each (id, status) is sent once, however often the page records it. */
export function trackSwap(input: { id: string; chain: string; from: string; to: string; wallet: string | null; status: string }): void {
  if (input.status !== 'confirmed' && input.status !== 'failed') return;
  const once = `${input.id}:${input.status}`;
  if (reported.has(once)) return;
  reported.add(once);
  sendBeacon({ k: 'swap', chain: input.chain, from: input.from, to: input.to, wallet: input.wallet, status: input.status });
}

/** One visit per browser tab session, plus the listeners that count script errors. Safe to call twice. */
export function startSiteBeacon(): void {
  if (started) return;
  started = true;
  try {
    if (!sessionStorage.getItem('aretia-visit')) {
      sessionStorage.setItem('aretia-visit', '1');
      sendBeacon({ k: 'visit' });
    }
  } catch {
    // no session storage: the visit is not counted rather than counted on every page
  }
  addEventListener('error', (e) => trackIssue('js-error', (e.error as { name?: string } | null)?.name ?? 'Error'));
  addEventListener('unhandledrejection', (e) => trackIssue('unhandled-rejection', (e.reason as { name?: string } | null)?.name ?? 'Error'));
}
