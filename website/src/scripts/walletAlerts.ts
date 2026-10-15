/**
 * "Alerts on your phone": the card on the Favourites page that links Telegram and this browser, so price alerts reach the
 * person while the wallet is closed. Linking needs the wallet signed in (the same sign-in that saves favourites), because the
 * server watches the favourites and price orders saved under that wallet. Nothing here asks for a key or a transaction.
 */
import { PCT_CHOICES } from '../swings/account/priceAlerts.js';
import type { AccountClient, Session } from '../swings/account/client.js';
import { b64uDecode } from '../swings/notify/vapid.js';

const NOTIFY = '/api/swings-notify';
const SW_PATH = '/aretia-alerts-sw.js';

export interface AlertsDeps {
  account: AccountClient;
  session(): Session | null;
  /** Asks the wallet to sign in (and saves favourites to it). Resolves when that has finished, signed in or not. */
  signIn(): Promise<void>;
  canSign(): boolean;
}

interface Config {
  telegram: boolean;
  webpush: boolean;
  vapidPublicKey: string | null;
}
interface Channel {
  id: number;
  kind: 'telegram' | 'webpush';
  label: string;
  secret: string | null;
}
interface Status {
  channels: Channel[];
  prefs: { movePct: number; enabled: boolean };
}

let config: Config | null = null;
let configAsk: Promise<Config> | null = null;
let status: Status | null = null;
let busy = '';
let message = '';
let redraw: () => void = () => undefined;
let watchTimer: ReturnType<typeof setInterval> | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const isIos = (): boolean => /iPad|iPhone|iPod/.test(navigator.userAgent);
const standalone = (): boolean => (navigator as unknown as { standalone?: boolean }).standalone === true || window.matchMedia('(display-mode: standalone)').matches;
const pushSupported = (): boolean => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** The channel number this browser was given for this wallet, kept so the card can tell "this browser" from another. */
const MINE_KEY = 'aretia-push-channel-v1';
const readMine = (): Record<string, number> => {
  try {
    return JSON.parse(localStorage.getItem(MINE_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
};
const setMine = (owner: string, id: number | null): void => {
  try {
    const all = readMine();
    if (id === null) delete all[owner];
    else all[owner] = id;
    localStorage.setItem(MINE_KEY, JSON.stringify(all));
  } catch {
    // not remembered: the card then shows this browser as one of the linked places
  }
};

function loadConfig(): Promise<Config> {
  if (config) return Promise.resolve(config);
  // Several draws in a row ask once.
  configAsk ??= (async () => {
    try {
      const res = await fetch(NOTIFY, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'config' }) });
      const body = (await res.json()) as Partial<Config>;
      config = res.ok ? { telegram: !!body.telegram, webpush: !!body.webpush, vapidPublicKey: body.vapidPublicKey ?? null } : { telegram: false, webpush: false, vapidPublicKey: null };
    } catch {
      config = { telegram: false, webpush: false, vapidPublicKey: null };
    }
    configAsk = null;
    return config;
  })();
  return configAsk;
}

async function loadStatus(deps: AlertsDeps): Promise<void> {
  const session = deps.session();
  if (!session) {
    status = null;
    return;
  }
  try {
    status = await deps.account.call<Status>(session, { op: 'status' }, NOTIFY);
  } catch {
    // the card keeps what it had
  }
}

/** Registers the worker for this wallet's browser channel, so a push can collect its message. */
async function registerWorker(id: number, secret: string): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register(`${SW_PATH}?c=${id}&s=${encodeURIComponent(secret)}`, { scope: '/' });
}

async function turnOnBrowser(deps: AlertsDeps, session: Session): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.webpush || !cfg.vapidPublicKey) throw new Error('Browser alerts are not set up on this server yet.');
  if (!pushSupported()) throw new Error(isIos() ? 'On iPhone, add Aretia to your Home Screen first (Share, then Add to Home Screen), open it from there, and try again.' : 'This browser cannot show alerts when the page is closed.');
  if (isIos() && !standalone()) throw new Error('On iPhone, add Aretia to your Home Screen first (Share, then Add to Home Screen), open it from there, and try again.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in your browser settings, then try again.');
  const first = await navigator.serviceWorker.register(SW_PATH, { scope: '/' });
  await navigator.serviceWorker.ready;
  const sub = (await first.pushManager.getSubscription()) ?? (await first.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uDecode(cfg.vapidPublicKey) }));
  const saved = await deps.account.call<{ id: number; secret: string }>(session, { op: 'push-subscribe', endpoint: sub.endpoint }, NOTIFY);
  await registerWorker(saved.id, saved.secret);
  setMine(session.owner, saved.id);
}

async function turnOffBrowser(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
    await reg?.unregister();
  } catch {
    // the server forgets the channel either way
  }
}

/** Waits for the person to press Start in Telegram: asks the server every few seconds for up to two minutes. */
function waitForTelegram(deps: AlertsDeps): void {
  clearInterval(watchTimer);
  const until = Date.now() + 120_000;
  watchTimer = setInterval(() => {
    void loadStatus(deps).then(() => {
      if (status?.channels.some((c) => c.kind === 'telegram') || Date.now() > until) {
        clearInterval(watchTimer);
        if (status?.channels.some((c) => c.kind === 'telegram')) message = 'Telegram is connected. Press "Send a test" to see it arrive.';
        busy = '';
        redraw();
      }
    });
  }, 3_000);
}

/** The card. Redrawn by the page whenever the Favourites list redraws; it keeps its state between draws. */
export function alertsCard(deps: AlertsDeps): HTMLElement {
  const box = el('section', 'wapp-pa');
  box.setAttribute('data-alerts-card', '');
  box.setAttribute('aria-label', 'Alerts on your phone');
  const mine = (): Record<string, number> => readMine();

  const run = (what: string, job: () => Promise<void>): void => {
    if (busy) return;
    busy = what;
    message = '';
    redraw();
    void job()
      .catch((e: unknown) => {
        message = e instanceof Error ? (/reject|declin|denied/i.test(e.message) ? 'The sign-in was declined, so nothing was linked.' : e.message) : 'That did not work. Try again.';
      })
      .finally(() => {
        if (busy !== 'telegram') busy = '';
        redraw();
      });
  };

  function draw(): void {
    box.replaceChildren();
    box.append(el('h3', 'wapp-pa__title', 'Alerts on your phone'));
    box.append(el('p', 'wapp__fine', 'Get a message on Telegram, or a notification from this browser, when a favourite moves or a price you set is reached, even when Aretia is closed. Messages only say what moved and link back here; they never ask you to sign or approve anything.'));
    const session = deps.session();
    if (!config) {
      box.append(el('p', 'wapp__fine', 'Loading…'));
      return;
    }
    if (!config.telegram && !config.webpush) {
      box.append(el('p', 'wapp__fine', 'Alerts to your phone are not switched on yet. They will appear here as soon as Aretia finishes setting them up.'));
      return;
    }
    if (!session) {
      const go = el('button', 'wapp__btn wapp__btn--primary', busy === 'signin' ? 'Waiting for your wallet…' : 'Save to my wallet to turn on');
      go.type = 'button';
      go.disabled = !deps.canSign() || busy !== '';
      go.addEventListener('click', () => run('signin', async () => { await deps.signIn(); await loadStatus(deps); }));
      box.append(go, el('p', 'wapp__fine', deps.canSign() ? 'Aretia needs to know whose favourites to watch. You sign a free message; it is not a transaction and cannot move funds.' : 'Connect a wallet first.'));
      if (message) box.append(el('p', 'wapp__fine', message));
      return;
    }
    const channels = status?.channels ?? [];
    const here = mine()[session.owner];
    const tg = channels.find((c) => c.kind === 'telegram');
    const hereChannel = channels.find((c) => c.kind === 'webpush' && c.id === here);
    const rows = el('div', 'wapp-pa__rows');

    if (config.telegram) {
      const row = el('div', 'wapp-pa__row');
      row.append(el('strong', '', 'Telegram'));
      if (tg) {
        row.append(el('span', 'wapp-pa__on', 'Connected'));
        const off = el('button', 'wapp__btn wapp__btn--ghost', 'Remove');
        off.type = 'button';
        off.addEventListener('click', () => run('unlink-tg', async () => { await deps.account.call(session, { op: 'unlink', id: tg.id }, NOTIFY); await loadStatus(deps); }));
        row.append(off);
      } else {
        const on = el('button', 'wapp__btn wapp__btn--primary', busy === 'telegram' ? 'Waiting for Telegram…' : 'Connect Telegram');
        on.type = 'button';
        on.disabled = busy !== '';
        on.addEventListener('click', () =>
          run('telegram', async () => {
            const { url } = await deps.account.call<{ url: string }>(session, { op: 'telegram-link' }, NOTIFY);
            window.open(url, '_blank', 'noopener');
            message = 'Telegram opened. Press Start there, and this will say Connected.';
            waitForTelegram(deps);
          }),
        );
        row.append(on);
      }
      rows.append(row);
    }

    if (config.webpush) {
      const row = el('div', 'wapp-pa__row');
      row.append(el('strong', '', 'This browser'));
      if (hereChannel) {
        row.append(el('span', 'wapp-pa__on', 'On'));
        const off = el('button', 'wapp__btn wapp__btn--ghost', 'Turn off');
        off.type = 'button';
        off.addEventListener('click', () => run('unlink-web', async () => { await deps.account.call(session, { op: 'unlink', id: hereChannel.id }, NOTIFY); await turnOffBrowser(); setMine(session.owner, null); await loadStatus(deps); }));
        row.append(off);
      } else {
        const on = el('button', 'wapp__btn wapp__btn--primary', busy === 'web' ? 'Setting up…' : 'Turn on browser alerts');
        on.type = 'button';
        on.disabled = busy !== '';
        on.addEventListener('click', () => run('web', async () => { await turnOnBrowser(deps, session); await loadStatus(deps); message = 'Browser alerts are on. Press "Send a test" to see one.'; }));
        row.append(on);
      }
      rows.append(row);
    }
    box.append(rows);

    if (channels.length > 0) {
      const settings = el('div', 'wapp-pa__row');
      settings.append(el('span', 'wapp__fine', 'Tell me when a favourite moves by'));
      const pct = el('select', 'wapp__input');
      pct.setAttribute('aria-label', 'How big a move to report');
      for (const p of PCT_CHOICES) {
        const o = el('option', '', `${p}%`);
        o.value = String(p);
        pct.append(o);
      }
      pct.value = String(status?.prefs.movePct ?? 5);
      pct.addEventListener('change', () => run('prefs', async () => { await deps.account.call(session, { op: 'prefs', movePct: Number(pct.value), enabled: status?.prefs.enabled ?? true }, NOTIFY); await loadStatus(deps); }));
      const test = el('button', 'wapp__btn wapp__btn--ghost', busy === 'test' ? 'Sending…' : 'Send a test');
      test.type = 'button';
      test.disabled = busy !== '';
      test.addEventListener('click', () => run('test', async () => { const r = await deps.account.call<{ sent: number; of: number }>(session, { op: 'test' }, NOTIFY); message = r.sent > 0 ? `Sent to ${r.sent} of ${r.of}. It should arrive in a few seconds.` : 'Nothing could be delivered. Try removing and linking again.'; }));
      settings.append(pct, test);
      box.append(settings);
    }
    if (message) box.append(el('p', 'wapp__fine wapp-pa__msg', message));
    if (config.webpush && isIos() && !standalone()) box.append(el('p', 'wapp__fine', 'On iPhone, browser alerts only work once Aretia is added to your Home Screen (Share, then Add to Home Screen). Telegram works without that.'));
  }

  redraw = draw;
  draw();
  void loadConfig().then(() => loadStatus(deps)).then(draw);
  return box;
}

/** Test seam: forget what the card remembered. */
export function resetAlertsCard(): void {
  config = null;
  configAsk = null;
  status = null;
  busy = '';
  message = '';
  clearInterval(watchTimer);
}
