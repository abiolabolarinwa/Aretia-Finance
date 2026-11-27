/**
 * Phones: the "Create a token" form (Solana and the EVM networks) is split into four short steps: 1 name and symbol; 2 the
 * optional picture, description and links; 3 supply, shares and options; 4 the safety checklist and Review. Nothing about the form changes:
 * the same fields, the same checks and the same Review. On wider screens the form is shown whole, as before.
 *
 * The launch scripts rebuild the form when its state changes, so the step is remembered here and applied to each new form.
 */
export const STEP_TITLES = ['Name and symbol', 'Picture and links', 'Supply and shares', 'Check and review'] as const;
const LAST = STEP_TITLES.length;
const PHONE = '(max-width: 720px)';

/** Which step (1 to 4) each child of the form belongs to, or null when the form is not a create form this knows. */
export function assignPages(children: readonly Element[]): number[] | null {
  const nameAt = children.findIndex((c) => c.querySelector('input[id$="-name"]') !== null);
  const supplyAt = children.findIndex((c) => c.querySelector('input[id$="-supply"]') !== null);
  const checkAt = children.findIndex((c) => c.classList.contains('lh-check-host'));
  if (nameAt < 0 || supplyAt <= nameAt) return null;
  return children.map((_, i) => (i <= nameAt ? 1 : i < supplyAt ? 2 : checkAt >= 0 && i >= checkAt ? 4 : 3));
}

let step = 1;

function isCreateForm(f: HTMLFormElement): boolean {
  return f.closest('.lh__step') !== null && f.querySelector('input[id$="-supply"]') !== null && f.querySelector('input[id$="-name"]') !== null;
}

/** The first step holding a field marked wrong, so a mistake found at Review is shown, not left on a hidden step. */
function stepWithProblem(f: HTMLFormElement): number | null {
  for (const el of f.querySelectorAll<HTMLElement>('[aria-invalid="true"]')) {
    const host = el.closest<HTMLElement>('[data-ln-page]');
    if (host?.parentElement === f) return Number(host.dataset.lnPage);
  }
  return null;
}

function button(text: string, primary: boolean): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `wapp__btn ${primary ? 'wapp__btn--primary' : 'wapp__btn--ghost'}`;
  b.textContent = text;
  return b;
}

/** Splits one form into steps (on phones), or puts it back together (wider screens). */
export function applySteps(f: HTMLFormElement, phone: boolean): void {
  f.querySelectorAll(':scope > .lh-steps-head, :scope > .lh-steps-nav').forEach((n) => n.remove());
  const kids = [...f.children];
  const pages = phone ? assignPages(kids) : null;
  if (!pages) {
    f.removeAttribute('data-ln-step');
    kids.forEach((k) => k.removeAttribute('data-ln-page'));
    return;
  }
  kids.forEach((k, i) => k.setAttribute('data-ln-page', String(pages[i])));
  step = stepWithProblem(f) ?? Math.min(Math.max(step, 1), LAST);

  const head = document.createElement('div');
  head.className = 'lh-steps-head';
  head.setAttribute('aria-live', 'polite');
  const nav = document.createElement('div');
  nav.className = 'lh-steps-nav';
  const back = button('Back', false);
  const next = button('Next', true);
  nav.append(back, next);
  f.prepend(head);
  f.append(nav);

  const show = (n: number): void => {
    step = n;
    f.setAttribute('data-ln-step', String(n));
    head.replaceChildren();
    const count = document.createElement('span');
    count.textContent = `Step ${n} of ${LAST}`;
    const title = document.createElement('strong');
    title.textContent = STEP_TITLES[n - 1]!;
    const dots = document.createElement('span');
    dots.className = 'lh-steps-dots';
    dots.setAttribute('aria-hidden', 'true');
    for (let i = 1; i <= LAST; i++) {
      const d = document.createElement('i');
      if (i <= n) d.className = 'is-on';
      dots.append(d);
    }
    head.append(count, title, dots);
    back.hidden = n === 1;
    next.hidden = n === LAST;
  };
  back.addEventListener('click', () => {
    show(Math.max(1, step - 1));
    f.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  });
  next.addEventListener('click', () => {
    show(Math.min(LAST, step + 1));
    f.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  });
  show(step);
}

/** Watches the page for the create form (it is drawn, and redrawn, by the launch scripts) and splits it on phones. */
export function initLaunchSteps(root: ParentNode = document): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  const mq = window.matchMedia(PHONE);
  const scan = (): void => {
    root.querySelectorAll<HTMLFormElement>('form.wapp-ln__form').forEach((f) => {
      if (!isCreateForm(f)) return;
      const want = mq.matches ? 'phone' : 'wide';
      if (f.dataset.lnSteps === want) return;
      f.dataset.lnSteps = want;
      applySteps(f, mq.matches);
    });
  };
  mq.addEventListener('change', () => {
    root.querySelectorAll<HTMLFormElement>('form[data-ln-steps]').forEach((f) => delete f.dataset.lnSteps);
    scan();
  });
  new MutationObserver(scan).observe(root instanceof Document ? root.body : (root as Node), { childList: true, subtree: true });
  scan();
}
