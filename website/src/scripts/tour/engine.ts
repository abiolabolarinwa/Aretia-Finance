import type { Rect, TourConfig, TourStatus } from './types';
import { createTourStorage, type TourStorage } from './storage';
import { TourSession, type SessionState } from './session';
import { computePosition, SHEET_MAX_WIDTH } from './placement';
import { injectTourStyles } from './styles';

export interface TourHost {
  /** Opens the page a step names. Resolve once it is on screen. */
  goToView?(view: string): void | Promise<void>;
  /** True while something else (a signing or transaction dialog, a wallet sheet) is on screen. */
  isBlocked?(): boolean;
}

export interface TourListing {
  tour: TourConfig;
  status: 'new' | TourStatus;
  /** Zero-based step the person reached, for in-progress and skipped tours. */
  step: number;
  canResume: boolean;
}

const PAD = 6;
const FIND_TIMEOUT_MS = 800;
const GONE_GRACE_MS = 500;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const reduced = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** True when the element takes up room on screen (not display:none, hidden, or collapsed). */
export function isShown(el: Element | null): el is HTMLElement {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

/** Default test for "another dialog is open": any visible dialog that is not the tour's own. */
export function foreignDialogOpen(): boolean {
  const found = document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]');
  for (const d of Array.from(found)) if (!d.closest('[data-atour]') && isShown(d)) return true;
  return false;
}

function findShown(selector: string): HTMLElement | null {
  let list: Element[];
  try {
    list = Array.from(document.querySelectorAll(selector));
  } catch {
    return null;
  }
  return (list.find((e) => isShown(e)) as HTMLElement | undefined) ?? null;
}

function scrollParent(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

export class TourEngine {
  private readonly tours = new Map<string, TourConfig>();
  private readonly storage: TourStorage;
  private readonly host: TourHost;
  private session: TourSession | null = null;
  private els: Record<number, HTMLElement | null> = {};
  private target: HTMLElement | null = null;
  private ui: {
    root: HTMLElement;
    hole: HTMLElement;
    tip: HTMLElement;
    count: HTMLElement;
    dots: HTMLElement;
    title: HTMLElement;
    body: HTMLElement;
    live: HTMLElement;
    back: HTMLButtonElement;
    skip: HTMLButtonElement;
    next: HTMLButtonElement;
  } | null = null;
  private returnFocus: HTMLElement | null = null;
  private frame = 0;
  private goneTimer: ReturnType<typeof setTimeout> | undefined;
  private mo: MutationObserver | null = null;
  private ro: ResizeObserver | null = null;
  private pill: HTMLElement | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(opts: { storage?: TourStorage; host?: TourHost } = {}) {
    this.storage = opts.storage ?? createTourStorage();
    this.host = opts.host ?? {};
  }

  register(...tours: TourConfig[]): void {
    for (const t of tours) this.tours.set(t.id, t);
  }

  get(id: string): TourConfig | undefined {
    return this.tours.get(id);
  }

  /** The running tour's id, or null. */
  get running(): string | null {
    return this.session?.active ? this.session.tour.id : null;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  isBlocked(): boolean {
    return this.host.isBlocked ? this.host.isBlocked() : foreignDialogOpen();
  }

  list(): TourListing[] {
    return Array.from(this.tours.values()).map((tour) => {
      const rec = this.storage.read(tour);
      const step = rec?.step ?? 0;
      return { tour, status: rec?.status ?? 'new', step, canResume: !!rec && rec.status !== 'completed' && step > 0 && step < tour.steps.length };
    });
  }

  /** True when this version of the tour has never been started, so an automatic start is allowed. */
  isFresh(id: string): boolean {
    const t = this.tours.get(id);
    return !!t && !this.storage.read(t);
  }

  /** Starts (or restarts) a tour. Returns false when it cannot run now. */
  async start(id: string, opts: { auto?: boolean; resume?: boolean } = {}): Promise<boolean> {
    const tour = this.tours.get(id);
    if (!tour || (typeof document === 'undefined')) return false;
    if (this.isBlocked()) return false;
    if (this.session?.active) {
      if (this.session.tour.id === id && !opts.resume) return true;
      this.session.skip();
    }
    this.removePill();
    injectTourStyles();
    this.returnFocus = (document.activeElement as HTMLElement | null) ?? null;
    const session = new TourSession(tour, this.storage, (i) => this.prepare(tour, i), (s) => this.onState(session, s));
    this.session = session;
    const ok = opts.resume ? await session.resume() : await session.start();
    if (!ok && this.session === session) this.teardown();
    return ok;
  }

  resume(id: string): Promise<boolean> {
    return this.start(id, { resume: true });
  }

  /** Leaves the running tour, remembering the step. */
  stop(): void {
    this.session?.skip();
  }

  // ---------------------------------------------------------------- stepping

  private async prepare(tour: TourConfig, i: number): Promise<boolean> {
    const step = tour.steps[i];
    if (!step) return false;
    if (step.view && this.host.goToView) await this.host.goToView(step.view);
    await step.beforeShow?.();
    if (!step.target) {
      this.els[i] = null;
      return true;
    }
    const deadline = Date.now() + FIND_TIMEOUT_MS;
    for (;;) {
      const el = findShown(step.target);
      if (el) {
        this.els[i] = el;
        return true;
      }
      if (Date.now() >= deadline) return false;
      await wait(100);
    }
  }

  private onState(session: TourSession, s: SessionState): void {
    if (session !== this.session) return;
    if (s.status === 'in-progress') {
      this.render(session.tour, s.index);
    } else {
      const wasSkipped = s.status === 'skipped';
      const rec = { tour: session.tour, step: s.index };
      this.teardown();
      if (wasSkipped && rec.step > 0) this.showPill(rec.tour, rec.step);
    }
    this.listeners.forEach((cb) => cb());
  }

  private build(): NonNullable<TourEngine['ui']> {
    const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
      const e = document.createElement(tag);
      e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const root = mk('div', 'atour');
    root.setAttribute('data-atour', '');
    const block = mk('div', 'atour__block');
    const hole = mk('div', 'atour__hole');
    const tip = mk('div', 'atour__tip');
    tip.setAttribute('role', 'dialog');
    tip.setAttribute('aria-modal', 'false');
    tip.tabIndex = -1;
    const meta = mk('div', 'atour__meta');
    const count = mk('span', 'atour__count');
    const dots = mk('span', 'atour__dots');
    dots.setAttribute('aria-hidden', 'true');
    meta.append(count, dots);
    const title = mk('h2', 'atour__title');
    title.id = 'atour-title';
    const body = mk('p', 'atour__body');
    body.id = 'atour-body';
    tip.setAttribute('aria-labelledby', title.id);
    tip.setAttribute('aria-describedby', body.id);
    const foot = mk('div', 'atour__foot');
    const skip = mk('button', 'atour__btn atour__btn--link', 'Skip');
    skip.type = 'button';
    const sp = mk('span', 'atour__sp');
    const back = mk('button', 'atour__btn', 'Back');
    back.type = 'button';
    const next = mk('button', 'atour__btn atour__btn--primary', 'Next');
    next.type = 'button';
    foot.append(skip, sp, back, next);
    const live = mk('div', 'atour__sr');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    tip.append(meta, title, body, foot);
    root.append(block, hole, tip, live);

    skip.addEventListener('click', () => this.session?.skip());
    back.addEventListener('click', () => void this.session?.back());
    next.addEventListener('click', () => void this.session?.next());
    return { root, hole, tip, count, dots, title, body, live, back, skip, next };
  }

  private render(tour: TourConfig, index: number): void {
    const step = tour.steps[index]!;
    const first = !this.ui;
    if (!this.ui) {
      this.ui = this.build();
      document.body.append(this.ui.root);
      document.addEventListener('keydown', this.onKey, true);
      window.addEventListener('resize', this.schedule);
      window.addEventListener('scroll', this.schedule, true);
      this.mo = new MutationObserver((muts) => {
        if (muts.every((m) => this.ui?.root.contains(m.target))) return;
        if (this.isBlocked()) return this.stop(); // never sit on top of a signing or transaction dialog
        this.schedule();
      });
      this.mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'style', 'open'] });
      if (typeof ResizeObserver !== 'undefined') {
        this.ro = new ResizeObserver(this.schedule);
        this.ro.observe(document.documentElement);
        this.ro.observe(this.ui.tip);
      }
    }
    const ui = this.ui;
    const total = tour.steps.length;
    this.target = this.els[index] ?? null;
    this.ro?.disconnect();
    if (typeof ResizeObserver !== 'undefined' && this.ro) {
      this.ro.observe(document.documentElement);
      this.ro.observe(ui.tip);
      if (this.target) this.ro.observe(this.target);
    }
    ui.count.textContent = `${index + 1} of ${total}`;
    ui.dots.textContent = '';
    if (total <= 10) {
      for (let i = 0; i < total; i++) {
        const d = document.createElement('i');
        if (i === index) d.setAttribute('data-on', '');
        ui.dots.append(d);
      }
    }
    ui.title.textContent = step.title;
    ui.body.textContent = step.body;
    ui.live.textContent = `Step ${index + 1} of ${total}. ${step.title}. ${step.body}`;
    const last = index === total - 1;
    ui.next.textContent = last ? 'Done' : 'Next';
    ui.back.hidden = index === 0;
    ui.skip.hidden = last;
    ui.root.toggleAttribute('data-nohole', !this.target);
    if (!first && !reduced()) ui.root.setAttribute('data-animate', '');
    else ui.root.removeAttribute('data-animate');

    if (this.target) this.bringIntoView(this.target);
    this.place();
    // Next may be the first thing on screen the person wants, so it takes focus; the dialog announces itself.
    ui.next.focus({ preventScroll: true });
    step.afterShow?.(this.target);
  }

  private bringIntoView(el: HTMLElement): void {
    const r = el.getBoundingClientRect();
    const sheet = innerWidth <= SHEET_MAX_WIDTH;
    const bottomLimit = sheet ? innerHeight - (this.ui?.tip.offsetHeight ?? 200) - 24 : innerHeight - 24;
    // Already (mostly) on screen, including tall sticky columns: leave the page where it is.
    const shown = Math.min(r.bottom, bottomLimit) - Math.max(r.top, 0);
    if (shown >= Math.min(r.height, 200) * 0.75) return;
    const behavior: ScrollBehavior = reduced() ? 'auto' : 'smooth';
    const parent = scrollParent(el);
    const want = (sheet ? bottomLimit : innerHeight) / 2 - (r.top + r.height / 2);
    const tall = r.height > bottomLimit - 56;
    const delta = tall ? -(r.top - 72) : -want;
    if (parent) parent.scrollBy({ top: delta, behavior });
    else window.scrollBy({ top: delta, behavior });
  }

  private readonly schedule = (): void => {
    if (this.frame || !this.ui) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.place();
    });
  };

  private place(): void {
    const ui = this.ui;
    if (!ui) return;
    let rect: Rect | null = null;
    if (this.target) {
      if (!isShown(this.target)) {
        // The target went away mid-step (the page re-rendered, or the view changed): give it a moment, then move on.
        clearTimeout(this.goneTimer);
        this.goneTimer = setTimeout(() => {
          if (this.target && !isShown(this.target)) void this.session?.next();
        }, GONE_GRACE_MS);
        ui.hole.style.opacity = '0';
      } else {
        clearTimeout(this.goneTimer);
        ui.hole.style.opacity = '1';
        const r = this.target.getBoundingClientRect();
        rect = { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
        Object.assign(ui.hole.style, { top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      }
    }
    const step = this.session ? this.session.tour.steps[this.session.state.index] : undefined;
    const pos = computePosition(rect, { width: ui.tip.offsetWidth, height: ui.tip.offsetHeight }, { width: document.documentElement.clientWidth, height: innerHeight }, step?.placement);
    ui.tip.toggleAttribute('data-sheet', pos.placement === 'sheet');
    ui.tip.dataset.placement = pos.placement;
    if (pos.placement !== 'sheet') {
      ui.tip.style.top = `${pos.top}px`;
      ui.tip.style.left = `${pos.left}px`;
    }
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    const ui = this.ui;
    if (!ui || !this.session?.active) return;
    const t = e.target as HTMLElement | null;
    const inTip = !!t && ui.tip.contains(t);
    const typing = !inTip && !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.stop();
    } else if (typing) {
      return;
    } else if (e.key === 'ArrowRight' || (e.key === 'Enter' && !(t instanceof HTMLButtonElement))) {
      e.preventDefault();
      void this.session.next();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      void this.session.back();
    } else if (e.key === 'Tab') {
      const items = [ui.skip, ui.back, ui.next].filter((b) => !b.hidden);
      const i = t ? items.indexOf(t as HTMLButtonElement) : -1;
      const nextIdx = i === -1 ? 0 : (i + (e.shiftKey ? -1 : 1) + items.length) % items.length;
      e.preventDefault();
      items[nextIdx]?.focus();
    }
  };

  private teardown(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    clearTimeout(this.goneTimer);
    this.mo?.disconnect();
    this.ro?.disconnect();
    this.mo = this.ro = null;
    document.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.schedule);
    window.removeEventListener('scroll', this.schedule, true);
    this.ui?.root.remove();
    this.ui = null;
    this.target = null;
    this.els = {};
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back && document.contains(back)) back.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- resume pill

  private showPill(tour: TourConfig, step: number): void {
    this.removePill();
    injectTourStyles();
    const pill = document.createElement('div');
    pill.className = 'atour-pill';
    pill.setAttribute('data-atour', '');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'atour__btn atour__btn--primary';
    go.textContent = `Resume tour · ${step + 1} of ${tour.steps.length}`;
    go.addEventListener('click', () => void this.resume(tour.id));
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'atour__btn atour__btn--x';
    x.setAttribute('aria-label', 'Dismiss');
    x.textContent = '✕';
    x.addEventListener('click', () => this.removePill());
    pill.append(go, x);
    document.body.append(pill);
    this.pill = pill;
  }

  private removePill(): void {
    this.pill?.remove();
    this.pill = null;
  }
}
