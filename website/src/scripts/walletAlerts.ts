/**
 * "Alerts on your phone": the card on the Favourites page that links Telegram and this browser, so price alerts reach the
 * person while the wallet is closed. Linking needs the wallet signed in (the same sign-in that saves favourites), because the
 * server watches the favourites and price orders saved under that wallet. Nothing here asks for a key or a transaction.
 */
import { PCT_CHOICES } from '../swings/account/priceAlerts.js';
import type { AccountClient, Session } from '../swings/account/client.js';
import { b64uDecode } from '../swings/notify/vapid.js';
import { BIG_BUY_CHOICES, LAUNCH_MIN_LIQ_CHOICES, LIQ_DROP_CHOICES, MARKET_PREFS_OFF, MAX_MARKET_PER_HOUR, MAX_MARKET_PER_RUN, type MarketPrefs } from '../swings/notify/market.js';
import { MI_CHAINS } from '../swings/mi/chains.js';
import { CHAINS } from '../swings/core/types.js';
import { compactUsd } from '../swings/market/types.js';

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
  /** null: this server's database does not hold market alerts yet. */
  market?: MarketPrefs | null;
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

const ICONS = {
  bell: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  telegram: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
  browser: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  shield: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></svg>',
};
const icon = (name: keyof typeof ICONS, cls: string): HTMLElement => {
  const s = el('span', cls);
  s.innerHTML = ICONS[name];
  return s;
};

/** The card. Redrawn by the page whenever the Favourites list redraws; it keeps its state between draws. */
export function alertsCard(deps: AlertsDeps): HTMLElement {
  const box = el('section', 'wapp-pa');
  box.setAttribute('data-alerts-card', '');
  box.setAttribute('aria-labelledby', 'wapp-pa-title');
  const mine = (): Record<string, number> => readMine();

  const run = (what: string, job: () => Promise<void>): void => {
    if (busy) return;
    busy = what;
    message = '';
    redraw();
    void job()
      .catch(async (e: unknown) => {
        message = e instanceof Error ? (/reject|declin|denied/i.test(e.message) ? 'The sign-in was declined, so nothing was linked.' : e.message) : 'That did not work. Try again.';
        // A setting shown before it was saved goes back to what the server holds.
        if (what === 'prefs' || what === 'market') await loadStatus(deps);
      })
      .finally(() => {
        if (busy !== 'telegram') busy = '';
        redraw();
      });
  };

  /** A row of choices, one pressed: quicker to read and to tap than a drop-down. */
  function choices<T extends number>(label: string, options: readonly T[], current: number, text: (v: T) => string, pick: (v: T) => void): HTMLElement {
    const group = el('div', 'wapp-pa__seg');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    for (const v of options) {
      const b = el('button', 'wapp-pa__opt', text(v));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(v === current));
      b.disabled = busy !== '';
      b.addEventListener('click', () => {
        if (v !== current) pick(v);
      });
      group.append(b);
    }
    return group;
  }

  /** One kind of alert: what it is on the left, its setting on the right (below it on a phone). */
  function rule(title: string, hint: string, on: boolean, ...controls: HTMLElement[]): HTMLElement {
    const row = el('div', `wapp-pa__rule${on ? ' is-on' : ''}`);
    const text = el('div', 'wapp-pa__rule-text');
    text.append(el('strong', '', title), el('span', 'wapp-pa__hint', hint));
    const ctl = el('div', 'wapp-pa__rule-ctl');
    ctl.append(...controls);
    row.append(text, ctl);
    return row;
  }

  function channelTile(kind: 'telegram' | 'browser', name: string, connected: boolean, state: string, action: HTMLButtonElement): HTMLElement {
    const tile = el('div', `wapp-pa__ch${connected ? ' is-on' : ''}`);
    const text = el('div', 'wapp-pa__ch-text');
    text.append(el('strong', '', name), el('span', 'wapp-pa__ch-state', state));
    tile.append(icon(kind, 'wapp-pa__ch-icon'), text, action);
    return tile;
  }

  const button = (text: string, kind: 'primary' | 'ghost', disabled: boolean, onClick: () => void, spinning = false): HTMLButtonElement => {
    const b = el('button', `wapp__btn wapp__btn--${kind} wapp-pa__btn`);
    b.type = 'button';
    if (spinning) {
      b.append(el('span', 'wapp-pa__spin'));
      b.setAttribute('aria-busy', 'true');
    }
    b.append(document.createTextNode(text));
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  };

  function draw(): void {
    box.replaceChildren();
    const session = deps.session();
    const channels = session ? (status?.channels ?? []) : [];
    const head = el('header', 'wapp-pa__head');
    const titles = el('div', 'wapp-pa__titles');
    const h = el('h3', 'wapp-pa__title', 'Alerts on your phone');
    h.id = 'wapp-pa-title';
    titles.append(h, el('p', 'wapp-pa__sub', 'Telegram or browser notifications about your favourites and the market, even when Aretia is closed.'));
    const pill = el('span', `wapp-pa__status${channels.length > 0 ? ' is-on' : ''}`, channels.length > 0 ? `On · ${channels.length === 1 ? '1 place' : `${channels.length} places`}` : 'Off');
    head.append(icon('bell', 'wapp-pa__bell'), titles, pill);
    box.append(head);

    const body = el('div', 'wapp-pa__body');
    box.append(body);

    if (!config) {
      body.append(el('div', 'wapp-pa__skel'), el('div', 'wapp-pa__skel wapp-pa__skel--short'));
    } else if (!config.telegram && !config.webpush) {
      body.append(el('p', 'wapp-pa__empty', 'Alerts to your phone are not switched on yet. They will appear here as soon as Aretia finishes setting them up.'));
    } else if (!session) {
      const cta = el('div', 'wapp-pa__cta');
      const why = el('div', 'wapp-pa__cta-text');
      why.append(el('strong', '', deps.canSign() ? 'Sign once to start' : 'Connect a wallet to start'), el('span', 'wapp-pa__hint', deps.canSign() ? 'Aretia needs to know whose favourites to watch. You sign a free message: it is not a transaction and cannot move funds.' : 'Alerts follow the favourites saved to your wallet.'));
      const waiting = busy === 'signin';
      cta.append(why, button(waiting ? 'Check your wallet…' : 'Turn on alerts', 'primary', !deps.canSign() || busy !== '', () => run('signin', async () => { await deps.signIn(); await loadStatus(deps); }), waiting));
      body.append(cta);
    } else {
      const here = mine()[session.owner];
      const tg = channels.find((c) => c.kind === 'telegram');
      const hereChannel = channels.find((c) => c.kind === 'webpush' && c.id === here);
      const others = channels.filter((c) => c.kind === 'webpush' && c.id !== here).length;

      body.append(el('span', 'wapp__eyebrow', 'Send alerts to'));
      const tiles = el('div', 'wapp-pa__chs');
      if (config.telegram) {
        const action = tg
          ? button('Remove', 'ghost', busy !== '', () => run('unlink-tg', async () => { await deps.account.call(session, { op: 'unlink', id: tg.id }, NOTIFY); await loadStatus(deps); }))
          : button(busy === 'telegram' ? 'Waiting…' : 'Connect', 'primary', busy !== '', () =>
              run('telegram', async () => {
                const { url } = await deps.account.call<{ url: string }>(session, { op: 'telegram-link' }, NOTIFY);
                window.open(url, '_blank', 'noopener');
                message = 'Telegram opened. Press Start there, and this will say Connected.';
                waitForTelegram(deps);
              }), busy === 'telegram');
        tiles.append(channelTile('telegram', 'Telegram', !!tg, tg ? 'Connected' : 'Not connected', action));
      }
      if (config.webpush) {
        const action = hereChannel
          ? button('Turn off', 'ghost', busy !== '', () => run('unlink-web', async () => { await deps.account.call(session, { op: 'unlink', id: hereChannel.id }, NOTIFY); await turnOffBrowser(); setMine(session.owner, null); await loadStatus(deps); }))
          : button(busy === 'web' ? 'Setting up…' : 'Turn on', 'primary', busy !== '', () => run('web', async () => { await turnOnBrowser(deps, session); await loadStatus(deps); message = 'Browser alerts are on. Press "Send a test" to see one.'; }), busy === 'web');
        tiles.append(channelTile('browser', 'This browser', !!hereChannel, hereChannel ? 'On' : others > 0 ? `Off here · on in ${others} other${others === 1 ? '' : 's'}` : 'Off', action));
      }
      body.append(tiles);
      if (config.webpush && isIos() && !standalone()) body.append(el('p', 'wapp-pa__hint', 'On iPhone, browser alerts work once Aretia is on your Home Screen (Share, then Add to Home Screen). Telegram works without that.'));

      body.append(el('span', 'wapp__eyebrow', 'Alert me about'));
      const rules = el('div', 'wapp-pa__rules');
      rules.append(rule('Price moves', 'A favourite moves this much, up or down. Prices you set are always sent.', true, choices('How big a move to report', PCT_CHOICES, status?.prefs.movePct ?? 5, (p) => `${p}%`, (p) => {
        if (status) status.prefs = { ...status.prefs, movePct: p };
        run('prefs', async () => { await deps.account.call(session, { op: 'prefs', movePct: p, enabled: status?.prefs.enabled ?? true }, NOTIFY); });
      })));
      rules.append(...marketRules(session));
      body.append(rules);
      if (channels.length === 0) body.append(el('p', 'wapp-pa__hint', 'Connect Telegram or this browser above to receive these.'));

      const foot = el('div', 'wapp-pa__foot');
      foot.append(el('span', 'wapp-pa__hint', `At most ${MAX_MARKET_PER_RUN} market alerts at a time and ${MAX_MARKET_PER_HOUR} an hour. They can arrive a few minutes after the event.`));
      if (channels.length > 0) foot.append(button(busy === 'test' ? 'Sending…' : 'Send a test', 'ghost', busy !== '', () => run('test', async () => { const r = await deps.account.call<{ sent: number; of: number }>(session, { op: 'test' }, NOTIFY); message = r.sent > 0 ? `Sent to ${r.sent} of ${r.of}. It should arrive in a few seconds.` : 'Nothing could be delivered. Try removing and linking again.'; }), busy === 'test'));
      body.append(foot);
    }
    const note = el('p', 'wapp-pa__msg', message);
    note.setAttribute('role', 'status');
    note.hidden = !message;
    body.append(note);
    const safe = el('p', 'wapp-pa__safe');
    safe.append(icon('shield', 'wapp-pa__safe-icon'), document.createTextNode('Alerts only say what happened and link back here. They never ask you to sign or approve anything.'));
    box.append(safe);
  }

  /** New launches, large buys and liquidity removed: each change shows at once and is saved straight away. */
  function marketRules(session: Session): HTMLElement[] {
    if (status?.market === null) {
      const off = el('div', 'wapp-pa__rule is-unavailable');
      off.setAttribute('data-market-alerts', '');
      const t = el('div', 'wapp-pa__rule-text');
      t.append(el('strong', '', 'Launches, large buys, liquidity removed'), el('span', 'wapp-pa__hint', 'Not switched on on this server yet.'));
      off.append(t);
      return [off];
    }
    const cur: MarketPrefs = status?.market ?? MARKET_PREFS_OFF;
    const save = (next: MarketPrefs): void => {
      if (status) status.market = next;
      run('market', async () => {
        const r = await deps.account.call<{ market: MarketPrefs }>(session, { op: 'market-prefs', ...next }, NOTIFY);
        if (status) status.market = r.market;
      });
    };
    const usd = (n: number, zero: string): string => (n === 0 ? zero : `${compactUsd(n)}+`);

    const chainChips = el('div', 'wapp-pa__seg wapp-pa__seg--wrap');
    chainChips.setAttribute('role', 'group');
    chainChips.setAttribute('aria-label', 'Networks to report new launches on');
    for (const c of MI_CHAINS) {
      const on = cur.launchChains.includes(c);
      const b = el('button', 'wapp-pa__opt', CHAINS[c].name.replace(/ Chain$/, ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(on));
      b.disabled = busy !== '';
      b.addEventListener('click', () => save({ ...cur, launchChains: on ? cur.launchChains.filter((x) => x !== c) : [...cur.launchChains, c] }));
      chainChips.append(b);
    }
    const launchCtl: HTMLElement[] = [chainChips];
    if (cur.launchChains.length > 0) {
      const min = el('div', 'wapp-pa__sub-ctl');
      min.append(el('span', 'wapp-pa__hint', 'Liquidity at least'), choices('Smallest liquidity for a new launch', LAUNCH_MIN_LIQ_CHOICES, cur.launchMinLiqUsd, (n) => usd(n, 'Any'), (n) => save({ ...cur, launchMinLiqUsd: n })));
      launchCtl.push(min);
    }
    const launches = rule('New launches', 'A new pool opens on the networks you pick.', cur.launchChains.length > 0, ...launchCtl);
    launches.setAttribute('data-market-alerts', '');
    const buys = rule('Large buys', 'Someone buys a favourite for at least this much in one go.', cur.bigBuyUsd > 0, choices('Smallest buy of a favourite to report', BIG_BUY_CHOICES, cur.bigBuyUsd, (n) => usd(n, 'Off'), (n) => save({ ...cur, bigBuyUsd: n })));
    const liq = rule('Liquidity removed', "This share of a favourite's pool is taken out, from its high of the last day. Locks are not tracked.", cur.liqDropPct > 0, choices('Share of liquidity taken out to report', LIQ_DROP_CHOICES, cur.liqDropPct, (n) => (n === 0 ? 'Off' : `${n}%`), (n) => save({ ...cur, liqDropPct: n })));
    return [launches, buys, liq];
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
