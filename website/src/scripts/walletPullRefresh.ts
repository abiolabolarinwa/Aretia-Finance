/**
 * Phones and the app: pull the page down from the very top and let go to load it again, as in phone apps. A round indicator follows
 * the finger and turns once it has gone far enough; nothing is written. It only starts when the page, and any list the finger is on,
 * is already scrolled to the top, and never for a sideways move (token cards swipe sideways).
 */
export const PULL_AT = 80;
const RETURN_KEY = 'aretia.pull-return';

/** After a pull-to-refresh reload: back to the page (and token) that was open, if the reload landed anywhere else. */
export function restorePullReturn(): void {
  try {
    const want = sessionStorage.getItem(RETURN_KEY);
    if (!want) return;
    sessionStorage.removeItem(RETURN_KEY);
    if (want.startsWith('/wallet') && `${location.pathname}${location.hash}` !== want) history.replaceState(null, '', want);
  } catch {
    // Storage blocked: the page opens as it would.
  }
}

function reloadHere(): void {
  try {
    sessionStorage.setItem(RETURN_KEY, `${location.pathname}${location.hash}`);
  } catch {
    // Storage blocked: reload anyway.
  }
  window.location.reload();
}

/** How far the indicator moves for a pull of `dy` pixels: it follows the finger, then slows down, like a rubber band. */
export function pullDistance(dy: number): number {
  if (dy <= 0) return 0;
  return dy < PULL_AT ? dy : PULL_AT + (dy - PULL_AT) * 0.35;
}

function scrolledTop(start: EventTarget | null): boolean {
  if (window.scrollY > 0) return false;
  for (let n = start instanceof Element ? start : null; n && n !== document.body; n = n.parentElement) {
    if (n.scrollTop > 0) return false;
  }
  return true;
}

export function initPullRefresh(reload: () => void = reloadHere): void {
  if (!window.matchMedia('(max-width: 720px)').matches || document.querySelector('.wapp-pull')) return;
  const dot = document.createElement('div');
  dot.className = 'wapp-pull';
  dot.setAttribute('aria-hidden', 'true');
  document.body.append(dot);
  let startY = 0;
  let startX = 0;
  let dy = 0;
  let active = false;
  document.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    // Not while a dialog, sheet or the search box is open.
    if (!t || e.touches.length > 1 || document.querySelector('dialog[open], .wapp[data-more-open]') || document.documentElement.classList.contains('is-searching') || !scrolledTop(e.target)) return;
    startY = t.clientY;
    startX = t.clientX;
    dy = 0;
    active = true;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (!active || !t) return;
    const my = t.clientY - startY;
    if (my <= 0 || Math.abs(t.clientX - startX) > my) {
      if (dy === 0) active = false;
      return;
    }
    dy = my;
    const d = pullDistance(dy);
    dot.style.transform = `translate(-50%, ${d - 48}px) rotate(${d * 3}deg)`;
    dot.style.opacity = String(Math.min(1, d / PULL_AT));
    dot.classList.toggle('is-ready', dy >= PULL_AT);
  }, { passive: true });
  const end = (): void => {
    if (!active) return;
    active = false;
    if (dy >= PULL_AT) {
      dot.classList.add('is-loading');
      dot.style.transform = `translate(-50%, ${PULL_AT - 40}px)`;
      reload();
      return;
    }
    dot.style.transform = '';
    dot.style.opacity = '';
    dot.classList.remove('is-ready');
  };
  document.addEventListener('touchend', end);
  document.addEventListener('touchcancel', end);
}
