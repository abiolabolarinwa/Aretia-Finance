/**
 * Phones: the Markets overview (the 24H activity figures, market mood, rising or falling, busiest venues, top gainers, newly listed,
 * trending) is not laid out on the page. Instead a row of chips names each one, and tapping a chip opens it in a sheet from the
 * bottom of the screen. The cards themselves are the same elements the overview draws (moved into the sheet while it is open and put
 * back when it closes), so their figures and their tap-to-open token rows work as they do on a wider screen. Wider screens show the
 * overview as before and never see the chips (see the max-width 720px rules in wallet/index.astro).
 */
export interface Insight {
  label: string;
  el: HTMLElement;
}

/** The overview pieces in one Markets card, in page order, each with a short name for its chip. */
export function insightsOf(card: ParentNode): Insight[] {
  const out: Insight[] = [];
  // The 24H activity figures are not offered on phones (the owner asked for the list without them).
  const band = card.querySelector<HTMLElement>(':scope > .wapp-ov');
  band?.querySelectorAll<HTMLElement>('.wapp-ov__card, .wapp-ov__panel').forEach((el) => {
    const title = el.querySelector('.wapp-ov__title, .wapp-ov__ptitle')?.textContent?.trim();
    if (!title) return;
    const score = el.querySelector('.wapp-ov__score')?.textContent?.trim();
    out.push({ label: score ? `${title} ${score}` : title, el });
  });
  return out;
}

let sheet: { dialog: HTMLDialogElement; title: HTMLElement; body: HTMLElement } | null = null;
let restore: (() => void) | null = null;

/** Closes the sheet (when something picked inside it is done). */
export function closeInsight(): void {
  closeSheet();
}

function closeSheet(): void {
  restore?.();
  restore = null;
  if (sheet?.dialog.open) {
    if (typeof sheet.dialog.close === 'function') sheet.dialog.close();
    else sheet.dialog.removeAttribute('open');
  }
}

function ensureSheet(): NonNullable<typeof sheet> {
  if (sheet) {
    if (!sheet.dialog.isConnected) document.body.append(sheet.dialog);
    return sheet;
  }
  const dialog = document.createElement('dialog');
  dialog.className = 'wapp-ins-sheet';
  const head = document.createElement('div');
  head.className = 'wapp-ins-sheet__head';
  const title = document.createElement('strong');
  title.id = 'wapp-ins-title';
  dialog.setAttribute('aria-labelledby', title.id);
  // No Close button: a tap outside the sheet or Escape closes it, and the space goes to what the sheet shows.
  head.append(title);
  const body = document.createElement('div');
  body.className = 'wapp-ins-sheet__body';
  dialog.append(head, body);
  // A tap outside the sheet (on the dimmed page) closes it; Escape closes it through the dialog's own cancel.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) closeSheet();
  });
  dialog.addEventListener('close', () => {
    restore?.();
    restore = null;
  });
  document.body.append(dialog);
  sheet = { dialog, title, body };
  return sheet;
}

/** Opens one overview piece in the sheet. The element is moved there and put back in its place when the sheet closes. */
export function openInsight(item: Insight): void {
  closeSheet();
  const s = ensureSheet();
  const mark = document.createComment('insight');
  item.el.before(mark);
  s.body.replaceChildren(item.el);
  s.title.textContent = item.label;
  restore = () => {
    // If the overview was redrawn while the sheet was open, the old piece is simply dropped: the new one is already on the page.
    if (mark.isConnected) mark.replaceWith(item.el);
    else item.el.remove();
  };
  if (typeof s.dialog.showModal === 'function') s.dialog.showModal();
  else s.dialog.setAttribute('open', '');
}

/** Keeps a chip row in each Markets card in step with the overview it holds. */
export function syncInsightChips(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('.wapp-mt__card').forEach((card) => {
    const items = insightsOf(card);
    const signature = items.map((i) => i.label).join('|');
    let row = card.querySelector<HTMLElement>(':scope > .wapp-ins');
    if (row?.dataset.sig === signature) return;
    if (items.length === 0) {
      row?.remove();
      return;
    }
    if (!row) {
      row = document.createElement('div');
      row.className = 'wapp-ins';
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', 'Market overview');
      const bar = card.querySelector(':scope > .wapp-mt__bar');
      if (bar) bar.after(row);
      else card.prepend(row);
    }
    row.dataset.sig = signature;
    row.replaceChildren(
      ...items.map((item, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wapp__chip wapp__chip--btn';
        b.textContent = item.label;
        // Looked up again on tap: the overview is redrawn as the market moves, so the element from this moment may be gone.
        b.addEventListener('click', () => {
          const now = insightsOf(card)[i];
          if (now) openInsight(now);
        });
        return b;
      }),
    );
  });
}

let watching = false;

/** Watches the page for the Markets overview (it is drawn and redrawn by walletSwings) and keeps its chips current. */
export function initInsights(): void {
  if (watching || typeof MutationObserver === 'undefined') return;
  watching = true;
  let queued = false;
  const run = (): void => {
    queued = false;
    syncInsightChips();
  };
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
  }).observe(document.body, { childList: true, subtree: true });
  run();
}
