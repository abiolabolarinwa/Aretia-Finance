/**
 * Puts the animated Aretia mark beside the loading messages the pages already show ("Loading…", "Checking the transfer…",
 * "Searching…", a button that says "Working…"), so every loading state on the site looks the same. It watches the page for
 * such messages as they appear, adds the mark, and takes it away again when the message is replaced.
 */
import { markSvg } from './loader.js';

/** A message that says something is in progress: a loading verb, then more words, ending in an ellipsis. */
const LOADING_TEXT = /^(?:Loading|Looking|Checking|Reading|Searching|Fetching|Analy[sz]ing|Finding|Working|Waiting|Saving|Connecting|Preparing|Verifying|Getting|Refreshing)\b[^.!?]{0,90}(?:…|\.\.\.)$/;

export function isLoadingText(text: string): boolean {
  return LOADING_TEXT.test(text.trim());
}

/** Elements that cannot hold a picture, or that are not part of what the person reads. */
const SKIP = new Set(['OPTION', 'SELECT', 'INPUT', 'TEXTAREA', 'SCRIPT', 'STYLE', 'TITLE', 'SVG', 'PATH', 'HEAD']);
const INLINE = new Set(['BUTTON', 'A', 'SPAN', 'SMALL', 'LABEL', 'LI', 'TD']);
const MARK = 'aretia-mark';

function enhance(el: Element): void {
  if (SKIP.has(el.tagName.toUpperCase()) || el.closest('[data-no-loader], .aretia-loading--block')) return;
  const mark = el.querySelector(`:scope > .${MARK}`);
  const others = [...el.children].filter((c) => c !== mark);
  // Only a message that stands alone: an element with other elements inside is a layout, not a loading line.
  if (others.length > 0) return;
  const text = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? '').join('');
  const loading = isLoadingText(text);
  if (loading && !mark) {
    const inline = INLINE.has(el.tagName);
    el.insertAdjacentHTML('afterbegin', markSvg(inline ? '1.15em' : 22));
    el.classList.add('aretia-loading', inline ? 'aretia-loading--inline' : 'aretia-loading--row');
  } else if (!loading && mark) {
    mark.remove();
    el.classList.remove('aretia-loading', 'aretia-loading--inline', 'aretia-loading--row');
  }
}

function scan(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    if (root.parentElement) enhance(root.parentElement);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  enhance(el);
  // Only the elements that directly hold text can be a message.
  for (const d of el.querySelectorAll('*')) if (d.childElementCount === 0 || d.querySelector(`:scope > .${MARK}`)) enhance(d);
}

let started = false;

/** Starts watching the page. Safe to call more than once. */
export function startLoadingMarks(doc: Document = document): void {
  if (started || typeof MutationObserver === 'undefined') return;
  started = true;
  const queue = new Set<Node>();
  let scheduled = false;
  const flush = (): void => {
    scheduled = false;
    const batch = [...queue];
    queue.clear();
    for (const n of batch) if (n.isConnected) scan(n);
  };
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f: () => void) => setTimeout(f, 16))(flush);
  };
  new MutationObserver((records) => {
    for (const r of records) {
      // The mark's own insertion and removal must not start another round.
      if (r.type === 'childList') {
        for (const n of r.addedNodes) if (!(n instanceof Element && n.classList.contains(MARK))) queue.add(n);
        if (r.target.nodeType === Node.ELEMENT_NODE) queue.add(r.target);
      } else if (r.type === 'characterData' && r.target.parentElement) queue.add(r.target.parentElement);
    }
    if (queue.size > 0) schedule();
  }).observe(doc.body, { childList: true, characterData: true, subtree: true });
  queue.add(doc.body);
  schedule();
}
