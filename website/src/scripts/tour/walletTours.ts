import { TourEngine, foreignDialogOpen, isShown } from './engine';
import { computePosition } from './placement';
import { injectTourStyles } from './styles';
import { VIEW_TOUR, WALLET_CONNECT_ID, WALLET_TOURS, WALLET_WELCOME_ID } from './walletTourConfigs';

/**
 * Hooks the tour engine into the wallet page. It lives apart from walletApp.ts on purpose: it reads the page's own
 * attributes (data-connected, data-page on [data-wapp]) and the URL hash, and adds its own buttons, so the wallet code
 * does not need to know about tours.
 */

const root = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-wapp]');
const currentView = (): string => root()?.dataset.page ?? 'dashboard';
/** A frame, or 100 ms if the tab is in the background and frames are paused. */
const raf = (): Promise<void> => new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 100); });

/** Something else is asking for the person's attention: a dialog, the swap window, or the wallet connect sheet. */
function walletBlocked(): boolean {
  if (foreignDialogOpen()) return true;
  return Array.from(document.querySelectorAll('.wapp-swapdlg, .aw-overlay, .wapp-lock, [data-lock-screen]')).some((e) => isShown(e));
}

async function goToView(view: string): Promise<void> {
  if (currentView() === view) return;
  location.hash = `#/${view}`;
  for (let i = 0; i < 40 && currentView() !== view; i++) await new Promise((r) => setTimeout(r, 50));
  await raf();
  await new Promise((r) => setTimeout(r, 120)); // the page draws its content just after the view changes
}

export function initWalletTours(): TourEngine | null {
  if (typeof document === 'undefined' || !root()) return null;
  injectTourStyles();
  const engine = new TourEngine({ host: { goToView, isBlocked: walletBlocked } });
  engine.register(...WALLET_TOURS);

  // ---- "Take a tour" button in the page header
  const chips = document.querySelector('.wapp__chips');
  const help = document.createElement('button');
  help.type = 'button';
  help.className = 'atour-help';
  help.setAttribute('data-tour-btn', '');
  help.hidden = true;
  chips?.prepend(help);
  help.addEventListener('click', () => {
    const id = VIEW_TOUR[currentView()];
    if (!id) return;
    const listing = engine.list().find((l) => l.tour.id === id);
    void (listing?.canResume ? engine.resume(id) : engine.start(id));
  });
  const syncHelp = (): void => {
    const id = VIEW_TOUR[currentView()];
    help.hidden = !id;
    if (!id) return;
    const listing = engine.list().find((l) => l.tour.id === id);
    const label = listing?.canResume ? 'Resume tour' : 'Take a tour';
    help.textContent = '';
    const q = document.createElement('b');
    q.setAttribute('aria-hidden', 'true');
    q.textContent = '?';
    help.append(q, document.createTextNode(label));
    help.setAttribute('aria-label', `${label}: ${listing?.tour.title ?? ''}`);
  };

  // ---- "Tours" entry in the sidebar and its list
  const foot = document.querySelector('.wapp__side-foot');
  const entry = document.createElement('button');
  entry.type = 'button';
  entry.className = 'wapp__lock';
  entry.setAttribute('data-tour-menu', '');
  entry.title = 'Take a tour of the wallet';
  entry.setAttribute('aria-haspopup', 'dialog');
  entry.setAttribute('aria-expanded', 'false');
  entry.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M9.7 9.5a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1.1.9-1.1 1.8M12 16.6v.01" /></svg><span class="wapp__label">Tours</span>';
  foot?.prepend(entry);

  let menu: HTMLElement | null = null;
  const closeMenu = (): void => {
    menu?.remove();
    menu = null;
    entry.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onMenuKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
  };
  const onMenuKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMenu();
      entry.focus();
    }
  };
  const onOutside = (e: PointerEvent): void => {
    if (menu && !menu.contains(e.target as Node) && !entry.contains(e.target as Node)) closeMenu();
  };
  const openMenu = (): void => {
    if (menu) return closeMenu();
    const el = document.createElement('div');
    el.className = 'atour-menu';
    el.setAttribute('data-atour', '');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Tours');
    const h = document.createElement('h2');
    h.textContent = 'Tours';
    const p = document.createElement('p');
    p.textContent = 'Short walkthroughs. Replay any of them whenever you like.';
    const ul = document.createElement('ul');
    for (const l of engine.list().filter((x) => !x.tour.hidden)) {
      const li = document.createElement('li');
      const text = document.createElement('div');
      text.className = 'atour-menu__text';
      const name = document.createElement('strong');
      name.textContent = l.tour.title;
      const sub = document.createElement('span');
      if (l.status === 'completed') {
        sub.textContent = 'Completed';
        sub.setAttribute('data-done', '');
      } else if (l.canResume) sub.textContent = `In progress · step ${l.step + 1} of ${l.tour.steps.length}`;
      else sub.textContent = l.tour.description ?? 'Not started';
      text.append(name, sub);
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'atour__btn';
      go.textContent = l.status === 'completed' ? 'Restart' : l.canResume ? 'Resume' : 'Start';
      go.addEventListener('click', () => {
        closeMenu();
        void (l.canResume ? engine.resume(l.tour.id) : engine.start(l.tour.id));
      });
      li.append(text, go);
      ul.append(li);
    }
    el.append(h, p, ul);
    document.body.append(el);
    menu = el;
    entry.setAttribute('aria-expanded', 'true');
    const r = entry.getBoundingClientRect();
    const pos = computePosition({ top: r.top, left: r.left, width: r.width, height: r.height }, { width: el.offsetWidth, height: el.offsetHeight }, { width: innerWidth, height: innerHeight }, 'right');
    if (pos.placement === 'sheet') el.setAttribute('data-sheet', '');
    else {
      el.style.top = `${pos.top}px`;
      el.style.left = `${pos.left}px`;
    }
    document.addEventListener('keydown', onMenuKey, true);
    document.addEventListener('pointerdown', onOutside, true);
    el.querySelector<HTMLElement>('button')?.focus();
  };
  entry.addEventListener('click', openMenu);

  // ---- the first-visit tour
  let timer: ReturnType<typeof setTimeout> | undefined;
  const consider = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (engine.running || menu || currentView() !== 'dashboard' || walletBlocked()) return;
      const id = root()?.dataset.connected === 'true' ? WALLET_WELCOME_ID : WALLET_CONNECT_ID;
      if (engine.isFresh(id)) void engine.start(id, { auto: true });
    }, 1800);
  };
  const w = root();
  if (w) new MutationObserver(consider).observe(w, { attributes: true, attributeFilter: ['data-connected', 'data-page'] });
  engine.onChange(syncHelp);
  window.addEventListener('hashchange', () => {
    syncHelp();
    consider();
  });
  syncHelp();
  consider();
  return engine;
}
