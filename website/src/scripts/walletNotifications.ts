/**
 * The notification bell in the wallet's sidebar: a count of what has not been read, a list of what has arrived, and the
 * switch for the ringing sound. Other scripts call `notify()` when something happens (a price alert); the bell keeps it
 * and, if the sound is on, rings. Notifications live in this browser only and arrive only while the page is open.
 */
import { browserStorage } from '../swings/history.js';
import { NotificationStore, type NewNotification } from '../swings/account/notifications.js';
import { createRinger } from './walletSound.js';

let store: NotificationStore | null = null;
let ringer: ReturnType<typeof createRinger> | null = null;
let refresh: () => void = () => undefined;

const getStore = (): NotificationStore => (store ??= new NotificationStore(browserStorage()));
const getRinger = (): ReturnType<typeof createRinger> => (ringer ??= createRinger());

/**
 * Records a notification and, unless `quiet`, rings once. Several arriving together should be passed as separate calls with
 * `quiet` on all but the first, so a burst makes one ring and not a chorus.
 */
export function notify(n: NewNotification, o: { quiet?: boolean } = {}): void {
  getStore().add(n);
  refresh();
  if (!o.quiet && getStore().soundOn()) void getRinger().play(n.tone ?? 'info');
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** Wires the bell button already in the sidebar to a pop-over list. Safe to call once the page has loaded. */
export function initNotifications(): void {
  const bell = document.querySelector<HTMLButtonElement>('[data-bell]');
  if (!bell) return;
  const badge = bell.querySelector<HTMLElement>('[data-bell-count]');
  const s = getStore();
  const r = getRinger();
  // The first touch anywhere on the page is what lets the browser allow a ring later on.
  window.addEventListener('pointerdown', () => r.unlock(), { once: true });
  window.addEventListener('keydown', () => r.unlock(), { once: true });

  const pop = el('section', 'wapp-bell-pop');
  pop.id = 'wapp-bell-pop';
  pop.hidden = true;
  pop.setAttribute('aria-label', 'Notifications');
  pop.setAttribute('data-lenis-prevent', '');
  document.body.append(pop);
  bell.setAttribute('aria-haspopup', 'true');
  bell.setAttribute('aria-controls', pop.id);
  bell.setAttribute('aria-expanded', 'false');

  let open = false;
  /** What was unread when the list was opened: still marked as new in the list, though the count has cleared. */
  const fresh = new Set<string>();
  const takeUnread = (): void => {
    for (const n of s.list()) if (!n.read) fresh.add(n.id);
    s.markAllRead();
  };

  function drawBadge(): void {
    const n = s.unread();
    if (badge) {
      badge.textContent = n > 9 ? '9+' : String(n);
      badge.hidden = n === 0;
    }
    bell!.title = n === 0 ? 'Notifications' : `Notifications: ${n} unread`;
    bell!.setAttribute('aria-label', n === 0 ? 'Notifications' : `Notifications, ${n} unread`);
  }

  function row(n: ReturnType<NotificationStore['list']>[number]): HTMLElement {
    const li = el('li', `wapp-bell__item wapp-bell__item--${n.tone}${fresh.has(n.id) ? ' is-unread' : ''}`);
    if (n.icon) {
      const img = el('img', 'wapp-bell__img');
      img.alt = '';
      img.width = 32;
      img.height = 32;
      img.referrerPolicy = 'no-referrer';
      img.src = n.icon;
      img.addEventListener('error', () => img.remove(), { once: true });
      li.append(img);
    } else li.append(el('span', 'wapp-bell__img wapp-bell__img--none'));
    const text = el('div', 'wapp-bell__text');
    text.append(el('strong', '', n.title));
    if (n.detail) text.append(el('span', '', n.detail));
    const when = el('time', 'wapp-bell__when', timeAgo(n.at));
    when.dateTime = new Date(n.at).toISOString();
    when.title = new Date(n.at).toLocaleString();
    text.append(when);
    li.append(text);
    return li;
  }

  function drawPanel(): void {
    const items = s.list();
    const head = el('div', 'wapp-bell__head');
    head.append(el('h2', 'wapp-bell__title', 'Notifications'));
    const actions = el('div', 'wapp-bell__actions');
    const mark = el('button', 'wapp-bell__link', 'Mark all read');
    mark.type = 'button';
    mark.disabled = fresh.size === 0;
    mark.addEventListener('click', () => {
      fresh.clear();
      drawPanel();
    });
    const clear = el('button', 'wapp-bell__link', 'Clear');
    clear.type = 'button';
    clear.disabled = items.length === 0;
    clear.addEventListener('click', () => {
      fresh.clear();
      s.clear();
      drawBadge();
      drawPanel();
    });
    actions.append(mark, clear);
    head.append(actions);

    const body = el('div', 'wapp-bell__body');
    if (items.length === 0) {
      body.append(el('p', 'wapp-bell__empty', 'Nothing yet. Star a token on Markets and you will be told here when its price moves.'));
    } else {
      const list = el('ul', 'wapp-bell__list');
      for (const n of items) list.append(row(n));
      body.append(list);
    }

    const foot = el('div', 'wapp-bell__foot');
    const label = el('label', 'wapp-bell__sound');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = s.soundOn();
    box.addEventListener('change', () => {
      s.setSound(box.checked);
      if (box.checked) void r.play('info');
    });
    label.append(box, el('span', '', 'Ring when a notification arrives'));
    const test = el('button', 'wapp-bell__link', 'Play sound');
    test.type = 'button';
    test.addEventListener('click', () => {
      void r.play('info').then((ok) => {
        test.textContent = ok ? 'Play sound' : 'Your browser is blocking sound';
      });
    });
    foot.append(label, test);
    foot.append(el('p', 'wapp-bell__note', 'Notifications are kept in this browser and arrive only while Aretia is open.'));
    pop.replaceChildren(head, body, foot);
  }

  function setOpen(next: boolean): void {
    open = next;
    pop.hidden = !next;
    bell!.setAttribute('aria-expanded', String(next));
    // Keep the sidebar open beside the list while it is showing.
    if (next) document.documentElement.dataset.wappHold = '';
    else delete document.documentElement.dataset.wappHold;
    window.dispatchEvent(new Event('aretia:sidebar-hold'));
    if (next) {
      // Seen is read: the count clears once the list has been opened.
      takeUnread();
      drawBadge();
    } else fresh.clear();
    drawPanel();
  }

  bell.addEventListener('click', () => setOpen(!open));
  document.addEventListener('pointerdown', (e) => {
    if (!open) return;
    const t = e.target as Node;
    if (!pop.contains(t) && !bell.contains(t)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape') {
      setOpen(false);
      bell.focus();
    }
  });

  refresh = () => {
    drawBadge();
    if (open) {
      takeUnread();
      drawPanel();
    }
  };
  // Times in the list go stale while it is open.
  setInterval(() => open && drawPanel(), 60_000);
  drawBadge();
}
