/**
 * The swap, as a window over the page: review it, watch it go through, see how it ended.
 *
 *   review      "Confirm swap": what you pay, what you receive, the few numbers that matter, then Cancel / Confirm & swap
 *   signing     the same card, softened, with the Aretia mark and "Confirm in your wallet"
 *   tracking    "Sent": waiting for the network, with the seconds counted
 *   done        "Swap complete", with a link to the transaction
 *   failed / unconfirmed   what happened, and what to try
 *
 * This file only draws. The swap itself (quotes, signing, tracking) stays in walletSwings.ts, which describes where the swap
 * stands as a SheetModel and says what each button does.
 */
import { loadingBlock } from '../lib/loader';
import './walletSwapSheet.css';

export type SheetStage = 'review' | 'signing' | 'tracking' | 'done' | 'failed' | 'unconfirmed';

export interface SheetToken {
  symbol: string;
  amount: string;
  icon: string | null;
}

export interface SheetModel {
  stage: SheetStage;
  chainName: string;
  pay: SheetToken;
  receive: SheetToken;
  /** "1 BNB ≈ 12,345 TRUMP", when the numbers allow it. */
  rate: string | null;
  /** The few numbers that matter, label and value. */
  rows: [string, string][];
  /** When the price on screen is read again by itself (ms since 1970), for the countdown in the review. */
  refreshAt: number | null;
  /** Things that stop the swap going ahead, and things worth knowing. */
  blockers: string[];
  notices: string[];
  canConfirm: boolean;
  confirmLabel: string;
  /** A tick box that must be set first (a risky token), and the full account of the route, both built by the swap. */
  ack: HTMLElement | null;
  details: HTMLElement | null;
  walletName: string | null;
  /** Failure text, and the usual reasons. */
  error: string | null;
  hint: string | null;
  txUrl: string | null;
  timing: string | null;
  /** Offered after a wallet gave up on a batch: send the steps one at a time. */
  stepByStep: boolean;
}

export interface SheetActions {
  confirm(): void;
  /** The review was closed without swapping. */
  cancel(): void;
  /** The result was read and closed. */
  done(): void;
  /** Closed while the swap carries on in the background. */
  hide(): void;
  /** After a failure: back to a fresh quote. */
  retry(): void;
  stepByStep?(): void;
}

export interface SwapSheet {
  /** Shows the sheet for this model, or updates it in place. */
  show(model: SheetModel): void;
  hide(): void;
  isOpen(): boolean;
}

/** Which window the swap's state calls for, or null when there is none (still quoting, idle, ...). Pure. */
export function stageFor(phase: string, execution: { status: string } | null | undefined, hasError: boolean): SheetStage | null {
  if (phase === 'review' || phase === 'signing' || phase === 'tracking') return phase;
  if (phase !== 'done') return null;
  if (execution?.status === 'confirmed') return 'done';
  // Sent but neither confirmed nor failed: say it is not confirmed yet, unless an error was reported.
  return execution && execution.status !== 'failed' && !hasError ? 'unconfirmed' : 'failed';
}

/** "1 BNB ≈ 12,345 TRUMP" from the two amounts, or null when either is missing or zero. Pure. */
export function rateLabel(paid: number, received: number, paySymbol: string, receiveSymbol: string): string | null {
  if (!(paid > 0) || !(received > 0) || !Number.isFinite(paid) || !Number.isFinite(received)) return null;
  return `1 ${paySymbol} ≈ ${new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 }).format(received / paid)} ${receiveSymbol}`;
}

const TITLES: Record<SheetStage, [string, string]> = {
  review: ['Confirm swap', 'Review the details before sending'],
  signing: ['Confirm in your wallet', 'Approve the request in your wallet to send it'],
  tracking: ['Sent', 'Waiting for the network to confirm'],
  done: ['Swap complete', 'Confirmed on the network'],
  failed: ['Swap failed', 'Your tokens were not swapped'],
  unconfirmed: ['Not confirmed yet', 'Check the transaction before trying again'],
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function avatar(t: SheetToken): HTMLElement {
  const letters = el('span', 'wapp-avatar wapp-ssh__avatar', ([...t.symbol].slice(0, 2).join('') || '?').toUpperCase());
  if (!t.icon || !(/^https:\/\//.test(t.icon) || t.icon.startsWith('/'))) return letters;
  const img = el('img', 'wapp-avatar wapp-ssh__avatar');
  img.alt = '';
  img.width = 40;
  img.height = 40;
  img.referrerPolicy = 'no-referrer';
  img.src = t.icon;
  img.addEventListener('error', () => img.replaceWith(letters), { once: true });
  return img;
}

function side(label: string, t: SheetToken, tone: '' | 'good'): HTMLElement {
  const box = el('div', 'wapp-ssh__side');
  const text = el('div', 'wapp-ssh__sidetext');
  text.append(el('small', 'wapp-ssh__label', label));
  const amount = el('strong', `wapp-ssh__amount${tone ? ` is-${tone}` : ''}`);
  amount.append(document.createTextNode(`${t.amount} `), el('span', 'wapp-ssh__sym', t.symbol));
  text.append(amount);
  box.append(text, avatar(t));
  return box;
}

/** A stable description of what is drawn, so the sheet is rebuilt only when something on it has changed. */
function signature(m: SheetModel): string {
  return JSON.stringify([m.stage, m.pay, m.receive, m.rate, m.rows, m.blockers, m.notices, m.canConfirm, m.confirmLabel, m.error, m.hint, m.txUrl, m.timing, m.stepByStep, m.walletName, !!m.ack, !!m.details]);
}

const CLOSE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 52 52" width="44" height="44" aria-hidden="true"><circle class="wapp-ssh__ring" cx="26" cy="26" r="23" fill="none"/><path class="wapp-ssh__tick" d="M15 27l8 8 15-17" fill="none"/></svg>';
const CROSS_ICON = '<svg viewBox="0 0 52 52" width="44" height="44" aria-hidden="true"><circle class="wapp-ssh__ring" cx="26" cy="26" r="23" fill="none"/><path class="wapp-ssh__tick" d="M18 18l16 16M34 18L18 34" fill="none"/></svg>';

export function mountSwapSheet(actions: SheetActions, doc: Document = document): SwapSheet {
  let overlay: HTMLElement | null = null;
  let card: HTMLElement | null = null;
  let current: SheetModel | null = null;
  let sig = '';
  let timer: ReturnType<typeof setInterval> | undefined;
  let sentAt = 0;
  let returnFocus: HTMLElement | null = null;

  const closeFor = (m: SheetModel): void => {
    if (m.stage === 'review') actions.cancel();
    else if (m.stage === 'done' || m.stage === 'failed') actions.done();
    else actions.hide();
  };

  function onKey(e: KeyboardEvent): void {
    if (!overlay || !current) return;
    if (e.key === 'Escape') {
      // Nothing may be closed while the wallet is waiting for an answer.
      if (current.stage !== 'signing') {
        e.stopPropagation();
        closeFor(current);
      }
      return;
    }
    if (e.key !== 'Tab' || !card) return;
    const focusable = [...card.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, summary, [tabindex]:not([tabindex="-1"])')].filter((n) => n.offsetParent !== null || n === doc.activeElement);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && (doc.activeElement === first || doc.activeElement === card)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && doc.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function tick(): void {
    if (!card || !current) return;
    const left = card.querySelector<HTMLElement>('[data-ssh-refresh]');
    if (left && current.refreshAt !== null) {
      const s = Math.ceil((current.refreshAt - Date.now()) / 1000);
      left.textContent = s > 0 ? `Best price is read again in ${s}s` : 'Reading the best price again…';
    }
    const elapsed = card.querySelector<HTMLElement>('[data-ssh-elapsed]');
    if (elapsed && sentAt) elapsed.textContent = `${Math.max(0, Math.round((Date.now() - sentAt) / 1000))}s`;
  }

  function build(m: SheetModel): HTMLElement {
    const working = m.stage === 'signing' || m.stage === 'tracking';
    const root = el('div', `wapp-ssh__card is-${m.stage}`);
    root.tabIndex = -1;

    const head = el('div', 'wapp-ssh__head');
    const titles = el('div', 'wapp-ssh__titles');
    const [title, sub] = TITLES[m.stage];
    const h = el('h2', 'wapp-ssh__title', title);
    h.id = 'wapp-ssh-title';
    titles.append(h, el('p', 'wapp-ssh__sub', m.stage === 'done' ? `Confirmed on ${m.chainName}` : m.stage === 'review' ? `${sub} · ${m.chainName}` : sub));
    head.append(titles);
    if (m.stage !== 'signing') {
      const x = el('button', 'wapp-ssh__x');
      x.type = 'button';
      x.setAttribute('aria-label', m.stage === 'review' ? 'Cancel the swap' : 'Close');
      x.innerHTML = CLOSE_ICON;
      x.addEventListener('click', () => closeFor(m));
      head.append(x);
    }
    root.append(head);

    const body = el('div', `wapp-ssh__body${working ? ' is-soft' : ''}`);
    if (m.stage === 'done' || m.stage === 'failed') {
      const badge = el('div', `wapp-ssh__badge is-${m.stage}`);
      badge.innerHTML = m.stage === 'done' ? CHECK_ICON : CROSS_ICON;
      body.append(badge);
    }
    const hero = el('div', 'wapp-ssh__hero');
    hero.append(side(m.stage === 'done' ? 'You swapped' : 'You pay', m.pay, ''));
    const arrow = el('div', 'wapp-ssh__arrow');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';
    hero.append(arrow, side(m.stage === 'done' ? 'You received (expected)' : 'You receive (expected)', m.receive, m.stage === 'done' ? 'good' : ''));
    body.append(hero);

    if (m.stage === 'failed' || m.stage === 'unconfirmed') {
      const why = el('div', 'wapp-ssh__why');
      if (m.error) why.append(el('p', '', m.error));
      if (m.hint) why.append(el('p', 'wapp-ssh__fine', m.hint));
      body.append(why);
    }

    const rows = el('dl', 'wapp-ssh__rows');
    const all: [string, string][] = [...(m.rate ? ([['Rate', m.rate]] as [string, string][]) : []), ...m.rows];
    for (const [k, v] of all) {
      const row = el('div');
      row.append(el('dt', '', k), el('dd', '', v));
      rows.append(row);
    }
    body.append(rows);

    if (m.stage === 'review') {
      for (const b of m.blockers) {
        const p = el('p', 'wapp-ssh__alert is-warn', b);
        p.setAttribute('role', 'alert');
        body.append(p);
      }
      for (const n of m.notices) body.append(el('p', 'wapp-ssh__alert', n));
      if (m.ack) body.append(m.ack);
      if (m.details) {
        const more = el('details', 'wapp-ssh__more');
        more.append(el('summary', '', 'All the details'), m.details);
        body.append(more);
      }
      const refresh = el('p', 'wapp-ssh__fine wapp-ssh__refresh');
      refresh.setAttribute('data-ssh-refresh', '');
      body.append(refresh);
    }
    if (m.stage === 'done') {
      if (m.timing) body.append(el('p', 'wapp-ssh__fine', m.timing));
      if (m.txUrl) {
        const a = el('a', 'wapp-ssh__tx', 'View the transaction');
        a.href = m.txUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        body.append(a);
      }
    }
    if (m.stage === 'unconfirmed' && m.txUrl) {
      const a = el('a', 'wapp-ssh__tx', 'View the transaction');
      a.href = m.txUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      body.append(a);
    }
    root.append(body);

    if (working) {
      // The card is softened and a slow colour drifts up from the bottom; the Aretia mark and what is being waited for sit in the middle.
      const veil = el('div', 'wapp-ssh__veil');
      veil.setAttribute('role', 'status');
      veil.append(el('div', 'wapp-ssh__glow'));
      const status = loadingBlock(m.stage === 'signing' ? `Confirm in ${m.walletName ?? 'your wallet'}…` : 'Waiting for the network…', 56);
      status.classList.add('wapp-ssh__status');
      const note = el('p', 'wapp-ssh__fine');
      if (m.stage === 'signing') note.textContent = 'Nothing is sent until you approve.';
      else {
        note.append(document.createTextNode('Do not send it again. You can close this window; it finishes by itself. '));
        const t = el('span');
        t.setAttribute('data-ssh-elapsed', '');
        note.append(t);
      }
      status.append(note);
      veil.append(status);
      root.append(veil);
    }

    const foot = el('div', 'wapp-ssh__foot');
    if (m.stage === 'review') {
      const cancel = el('button', 'wapp-ssh__btn wapp-ssh__btn--ghost', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', () => actions.cancel());
      const go = el('button', 'wapp-ssh__btn wapp-ssh__btn--primary', m.confirmLabel);
      go.type = 'button';
      go.disabled = !m.canConfirm;
      go.addEventListener('click', () => actions.confirm());
      foot.append(cancel, go);
      if (m.stepByStep && m.canConfirm && actions.stepByStep) {
        const steps = el('button', 'wapp-ssh__link', 'Send it one step at a time');
        steps.type = 'button';
        steps.addEventListener('click', () => actions.stepByStep?.());
        foot.classList.add('has-link');
        foot.append(steps);
      }
    } else if (m.stage === 'done') {
      const ok = el('button', 'wapp-ssh__btn wapp-ssh__btn--primary wapp-ssh__btn--wide', 'Done');
      ok.type = 'button';
      ok.addEventListener('click', () => actions.done());
      foot.append(ok);
    } else if (m.stage === 'failed') {
      const close = el('button', 'wapp-ssh__btn wapp-ssh__btn--ghost', 'Close');
      close.type = 'button';
      close.addEventListener('click', () => actions.done());
      const again = el('button', 'wapp-ssh__btn wapp-ssh__btn--primary', 'Try again');
      again.type = 'button';
      again.addEventListener('click', () => actions.retry());
      foot.append(close, again);
    } else if (m.stage === 'unconfirmed') {
      const close = el('button', 'wapp-ssh__btn wapp-ssh__btn--primary wapp-ssh__btn--wide', 'Close');
      close.type = 'button';
      close.addEventListener('click', () => actions.hide());
      foot.append(close);
    }
    if (foot.childElementCount > 0) root.append(foot);
    return root;
  }

  function ensure(): HTMLElement {
    if (overlay) return overlay;
    overlay = el('div', 'wapp-ssh');
    overlay.hidden = true;
    overlay.setAttribute('data-lenis-prevent', '');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'wapp-ssh-title');
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay && current && current.stage !== 'signing') closeFor(current);
    });
    doc.body.append(overlay);
    return overlay;
  }

  return {
    show(model) {
      const was = current;
      current = model;
      const host = ensure();
      if (model.stage === 'tracking' && was?.stage !== 'tracking') sentAt = Date.now();
      if (model.stage !== 'tracking' && model.stage !== 'signing') sentAt = 0;
      const next = signature(model);
      if (host.hidden || !card || next !== sig) {
        const first = host.hidden || !was;
        sig = next;
        const fresh = build(model);
        if (card && !first) {
          card.replaceWith(fresh);
          fresh.classList.add('is-swapped');
        } else {
          host.replaceChildren(fresh);
        }
        card = fresh;
        if (host.hidden) {
          returnFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
          host.hidden = false;
          // The closed look is committed first, so the opening transition runs (a timer or frame callback could be held back in a background tab).
          void host.offsetWidth;
          host.classList.add('is-open');
          doc.addEventListener('keydown', onKey, true);
          doc.documentElement.classList.add('wapp-ssh-lock');
          card.focus({ preventScroll: true });
        } else if (was && was.stage !== model.stage) {
          card.focus({ preventScroll: true });
        }
      }
      if (!timer) timer = setInterval(tick, 1000);
      tick();
    },
    hide() {
      if (!overlay || overlay.hidden) return;
      overlay.classList.remove('is-open');
      overlay.hidden = true;
      overlay.replaceChildren();
      card = null;
      current = null;
      sig = '';
      clearInterval(timer);
      timer = undefined;
      doc.removeEventListener('keydown', onKey, true);
      doc.documentElement.classList.remove('wapp-ssh-lock');
      returnFocus?.focus?.({ preventScroll: true });
      returnFocus = null;
    },
    isOpen() {
      return !!overlay && !overlay.hidden;
    },
  };
}
