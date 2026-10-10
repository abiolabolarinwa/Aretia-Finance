/**
 * The wallet page's optional lock: the sidebar's lock button, its settings window, and the lock screen. The rules and the
 * checking live in swings/account/walletLock.ts; this file is the screens.
 *
 * Voluntary: nothing is asked of anyone who does not turn it on. Per wallet: each connected wallet has its own lock (or none),
 * so a wallet that never set one is never asked for anything, whatever another wallet did. Desktop and laptop only: on a phone
 * or tablet the button keeps its old job of disconnecting this page from the wallet.
 *
 * The lock screen is a modal <dialog>, so the page behind it cannot be reached by keyboard or pointer while it is up.
 */
import { browserStorage } from '../swings/history.js';
import {
  AUTO_LOCK_CHOICES,
  afterTry,
  DEFAULT_AUTO_LOCK_MIN,
  deviceUnlockAvailable,
  deviceUnlockName,
  FREE_TRIES,
  hashSecret,
  isDesktopComputer,
  LockStore,
  passwordProblem,
  pinProblem,
  registerDevice,
  secretMatches,
  verifyDevice,
  waitMs,
  type DeviceDeps,
  type LockMethod,
  type LockRecord,
} from '../swings/account/walletLock.js';

export interface LockHost {
  getAddress(): string | null;
  getWalletName(): string | null;
  /** The old job of the button: let the page forget the wallet. */
  disconnect(): void;
  /** Asks the wallet to approve a short message, which is what lets a forgotten lock be reset. */
  proveOwnership(message: string): Promise<'approved' | 'declined' | 'unsupported'>;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const short = (a: string): string => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const waitText = (ms: number): string => {
  const s = Math.ceil(ms / 1000);
  return `Too many wrong tries. Try again in ${s < 90 ? `${s} seconds` : `${Math.ceil(s / 60)} minutes`}.`;
};
const autoLockLabel = (m: number): string => (m === 0 ? 'Never' : `${m} minutes`);

export function initWalletLock(host: LockHost): { onWallet(address: string | null): void } {
  const button = document.querySelector<HTMLButtonElement>('[data-lock]');
  const store = new LockStore(browserStorage());
  const desktop = isDesktopComputer({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints ?? 0, finePointer: window.matchMedia('(pointer: fine)').matches });
  let deviceOk = false;
  if (desktop && window.isSecureContext) void deviceUnlockAvailable().then((v) => (deviceOk = v));
  const deps = (): DeviceDeps => ({ credentials: navigator.credentials, subtle: crypto.subtle, rpId: location.hostname, origin: location.origin });

  let address: string | null = null;
  let screen: HTMLDialogElement | null = null;
  let settings: HTMLDialogElement | null = null;
  let lastActive = Date.now();

  const labelEl = button?.querySelector<HTMLElement>('.wapp__label') ?? null;

  function refreshButton(): void {
    if (!button) return;
    if (!desktop) {
      button.title = 'Disconnect this page from your wallet. Your funds and keys are not affected.';
      if (labelEl) labelEl.textContent = 'Disconnect';
      return;
    }
    const on = !!address && store.has(address);
    button.dataset.lockOn = String(on);
    button.title = on ? 'Lock settings: your lock is on for this wallet' : 'Optional: protect this wallet on this computer with a password, PIN or your computer’s own unlock';
    button.setAttribute('aria-label', on ? 'Lock settings (lock is on for this wallet)' : 'Set up a lock for this wallet (optional)');
  }

  /** Checks what was typed (or asks the computer) against this wallet's lock, keeping count of wrong tries. */
  async function check(addr: string, secret: string): Promise<{ ok: boolean; message: string }> {
    const rec = store.get(addr);
    if (!rec) return { ok: true, message: '' };
    const wait = waitMs(rec, Date.now());
    if (wait > 0) return { ok: false, message: waitText(wait) };
    if (rec.method === 'device' && rec.device) {
      // The computer counts and limits its own tries (fingerprint, face, PIN), so they are not counted again here.
      const ok = await verifyDevice(rec.device, deps());
      return { ok, message: ok ? '' : 'Not confirmed. Try again.' };
    }
    const ok = !!rec.secret && (await secretMatches(secret, rec.secret));
    const next = afterTry(store.get(addr) ?? rec, ok, Date.now());
    store.set(addr, next);
    if (ok) return { ok: true, message: '' };
    const wait2 = waitMs(next, Date.now());
    return { ok: false, message: wait2 > 0 ? waitText(wait2) : `That is not right. ${Math.max(0, FREE_TRIES - next.fails)} ${FREE_TRIES - next.fails === 1 ? 'try' : 'tries'} left before a short wait.` };
  }

  // ---------------------------------------------------------------- the lock screen

  function closeLockScreen(): void {
    const d = screen;
    screen = null;
    d?.close();
    d?.remove();
    lastActive = Date.now();
  }

  function openLockScreen(): void {
    const addr = address;
    const rec = addr ? store.get(addr) : null;
    if (!addr || !rec || screen) return;
    closeSettings();
    const d = h('dialog', 'wapp-lockscreen');
    d.setAttribute('aria-label', 'Aretia is locked');
    // Escape must not close it, and if a browser closes it anyway it comes straight back.
    d.addEventListener('cancel', (e) => e.preventDefault());
    d.addEventListener('close', () => {
      if (screen === d) d.showModal();
    });
    const box = h('div', 'wapp-lockscreen__box');
    const mark = h('img', 'wapp-lockscreen__mark');
    mark.src = '/assets/logo-mark.png';
    mark.alt = '';
    mark.width = 40;
    mark.height = 40;
    box.append(mark, h('h2', '', 'Aretia is locked'), h('p', 'wapp-lockscreen__who', `${host.getWalletName() ?? 'Wallet'} · ${short(addr)}`));
    const say = h('p', 'wapp-lockscreen__say');
    say.setAttribute('role', 'status');
    let busy = false;

    const attempt = async (secret: string, controls: HTMLElement[]): Promise<void> => {
      if (busy) return;
      busy = true;
      controls.forEach((c) => c.setAttribute('disabled', ''));
      say.textContent = rec.method === 'device' ? 'Waiting for your computer…' : 'Checking…';
      const res = await check(addr, secret);
      busy = false;
      if (address !== addr) return;
      if (res.ok) return closeLockScreen();
      controls.forEach((c) => c.removeAttribute('disabled'));
      say.textContent = res.message;
    };

    if (rec.method === 'device') {
      const go = h('button', 'wapp__btn wapp__btn--primary', `Unlock with ${deviceUnlockName(navigator.userAgent).split(' (')[0]}`);
      go.type = 'button';
      go.addEventListener('click', () => void attempt('', [go]));
      box.append(go);
      // Ask straight away so the common case needs no click.
      setTimeout(() => {
        if (screen === d && document.hasFocus()) void attempt('', [go]);
      }, 350);
    } else {
      const form = h('form', 'wapp-lockscreen__form');
      const input = h('input', 'wapp__input');
      input.type = 'password';
      input.autocomplete = 'off';
      input.placeholder = rec.method === 'pin' ? 'Your PIN' : 'Your password';
      input.setAttribute('aria-label', rec.method === 'pin' ? 'PIN' : 'Password');
      if (rec.method === 'pin') input.inputMode = 'numeric';
      const go = h('button', 'wapp__btn wapp__btn--primary', 'Unlock');
      go.type = 'submit';
      form.append(input, go);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const typed = input.value;
        input.value = '';
        void attempt(typed, [input, go]).then(() => input.focus());
      });
      box.append(form);
      setTimeout(() => input.focus(), 50);
    }
    box.append(say);

    // Forgot it: the wallet itself is asked to approve a message, so only whoever controls the wallet can remove the lock.
    const forgot = h('button', 'wapp-lockscreen__link', 'Forgot it?');
    forgot.type = 'button';
    const reset = h('div', 'wapp-lockscreen__reset');
    reset.hidden = true;
    reset.append(h('p', '', 'You can remove the lock with your wallet. It asks you to approve a short message. That does not move any money.'));
    const approve = h('button', 'wapp__btn wapp__btn--ghost', 'Approve in my wallet');
    approve.type = 'button';
    approve.addEventListener('click', () => {
      approve.setAttribute('disabled', '');
      void host.proveOwnership(`Remove the Aretia lock for ${addr}. This is not a transaction and moves no money.`).then((r) => {
        approve.removeAttribute('disabled');
        if (address !== addr) return;
        if (r === 'approved') {
          store.remove(addr);
          refreshButton();
          return closeLockScreen();
        }
        say.textContent = r === 'declined' ? 'Not approved. The lock is still on.' : 'This wallet cannot approve messages, so it cannot be used to remove the lock. Clearing this site’s data in your browser settings removes it.';
      });
    });
    reset.append(approve);
    forgot.addEventListener('click', () => (reset.hidden = !reset.hidden));
    box.append(forgot, reset);
    box.append(h('p', 'wapp-lockscreen__fine', 'This lock keeps people out of Aretia on this computer. Your wallet has its own password, and your keys stay in it.'));
    d.append(box);
    document.body.append(d);
    screen = d;
    d.showModal();
  }

  // ---------------------------------------------------------------- the settings window

  function closeSettings(): void {
    settings?.close();
    settings?.remove();
    settings = null;
  }

  function openSettings(): void {
    const addr = address;
    if (!addr || !desktop || screen) return;
    closeSettings();
    const d = h('dialog', 'wapp-lockdlg');
    d.setAttribute('aria-labelledby', 'wapp-lockdlg-title');
    const body = h('div', 'wapp-lockdlg__body');
    d.append(body);
    d.addEventListener('close', () => {
      if (settings === d) settings = null;
      d.remove();
    });
    d.addEventListener('mousedown', (e) => {
      if (e.target === d) d.close();
    });
    document.body.append(d);
    settings = d;
    if (store.has(addr)) drawStatus(body, addr, '');
    else drawSetup(body, addr, false);
    d.showModal();
  }

  const closeButton = (): HTMLElement => {
    const b = h('button', 'wapp-lockdlg__close');
    b.type = 'button';
    b.setAttribute('aria-label', 'Close');
    b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>';
    b.addEventListener('click', closeSettings);
    return b;
  };

  const head = (title: string, addr: string): HTMLElement => {
    const row = h('div', 'wapp-lockdlg__head');
    const t = h('div');
    const hd = h('h2', '', title);
    hd.id = 'wapp-lockdlg-title';
    t.append(hd, h('p', 'wapp-lockdlg__who', `${host.getWalletName() ?? 'Wallet'} · ${short(addr)}`));
    row.append(t, closeButton());
    return row;
  };

  const FINE = 'This lock keeps people out of Aretia on this computer. It does not replace your wallet’s own password, and it cannot stop someone who can use your browser’s settings or your wallet extension directly. Your keys stay in your wallet and are not affected. The lock belongs to this wallet only: another wallet you connect has none until you set one up.';

  function autoLockSelect(current: number, onChange: (m: number) => void): HTMLElement {
    const label = h('label', 'wapp-lockdlg__field');
    label.append(h('span', '', 'Lock again after no activity for'));
    const sel = h('select', 'wapp__input');
    for (const m of AUTO_LOCK_CHOICES) {
      const o = h('option', '', autoLockLabel(m));
      o.value = String(m);
      o.selected = m === current;
      sel.append(o);
    }
    sel.addEventListener('change', () => onChange(Number(sel.value)));
    label.append(sel);
    return label;
  }

  /** The lock is on: lock now, how soon it locks by itself, change it, or turn it off. */
  function drawStatus(body: HTMLElement, addr: string, note: string): void {
    const rec = store.get(addr);
    if (!rec) return drawSetup(body, addr, false);
    body.replaceChildren(head('Lock is on', addr));
    body.append(h('p', 'wapp-lockdlg__line', `Aretia asks for your ${rec.method === 'device' ? deviceUnlockName(navigator.userAgent) : rec.method === 'pin' ? 'PIN' : 'password'} when this page opens, when you press Lock now, and after the idle time below.`));
    if (note) {
      const n = h('p', 'wapp-lockdlg__ok', note);
      n.setAttribute('role', 'status');
      body.append(n);
    }
    const lockNow = h('button', 'wapp__btn wapp__btn--primary', 'Lock now');
    lockNow.type = 'button';
    lockNow.addEventListener('click', () => openLockScreen());
    body.append(
      lockNow,
      autoLockSelect(rec.autoLockMin, (m) => {
        const cur = store.get(addr);
        if (cur) store.set(addr, { ...cur, autoLockMin: m });
      }),
    );
    const row = h('div', 'wapp-lockdlg__row');
    const change = h('button', 'wapp__btn wapp__btn--ghost', 'Change how it unlocks');
    change.type = 'button';
    change.addEventListener('click', () => drawVerify(body, addr, () => drawSetup(body, addr, true)));
    const off = h('button', 'wapp__btn wapp__btn--ghost', 'Turn off the lock');
    off.type = 'button';
    off.addEventListener('click', () =>
      drawVerify(body, addr, () => {
        store.remove(addr);
        refreshButton();
        drawSetup(body, addr, false, 'The lock is off for this wallet.');
      }),
    );
    row.append(change, off);
    body.append(row, h('p', 'wapp-lockdlg__fine', FINE));
  }

  /** Making sure it is the owner before the lock is changed or removed. */
  function drawVerify(body: HTMLElement, addr: string, then: () => void): void {
    const rec = store.get(addr);
    if (!rec) return then();
    body.replaceChildren(head('Confirm it is you', addr));
    const say = h('p', 'wapp-lockdlg__err');
    say.setAttribute('role', 'status');
    let busy = false;
    const run = async (secret: string, controls: HTMLElement[]): Promise<void> => {
      if (busy) return;
      busy = true;
      controls.forEach((c) => c.setAttribute('disabled', ''));
      say.textContent = '';
      const res = await check(addr, secret);
      busy = false;
      if (res.ok) return then();
      controls.forEach((c) => c.removeAttribute('disabled'));
      say.textContent = res.message;
    };
    if (rec.method === 'device') {
      body.append(h('p', 'wapp-lockdlg__line', `Use ${deviceUnlockName(navigator.userAgent)} to continue.`));
      const go = h('button', 'wapp__btn wapp__btn--primary', 'Confirm');
      go.type = 'button';
      go.addEventListener('click', () => void run('', [go]));
      body.append(go, say);
      go.focus();
    } else {
      const form = h('form', 'wapp-lockdlg__form');
      const input = h('input', 'wapp__input');
      input.type = 'password';
      input.autocomplete = 'off';
      input.placeholder = rec.method === 'pin' ? 'Your PIN' : 'Your password';
      input.setAttribute('aria-label', rec.method === 'pin' ? 'PIN' : 'Password');
      if (rec.method === 'pin') input.inputMode = 'numeric';
      const go = h('button', 'wapp__btn wapp__btn--primary', 'Confirm');
      go.type = 'submit';
      form.append(input, go);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const typed = input.value;
        input.value = '';
        void run(typed, [input, go]).then(() => input.focus());
      });
      body.append(form, say);
      input.focus();
    }
    const back = h('button', 'wapp-lockscreen__link', 'Back');
    back.type = 'button';
    back.addEventListener('click', () => drawStatus(body, addr, ''));
    body.append(back);
  }

  /** Choosing how to unlock, and setting it up. */
  function drawSetup(body: HTMLElement, addr: string, changing: boolean, note = ''): void {
    body.replaceChildren(head(changing ? 'Change how it unlocks' : 'Lock this wallet on this computer', addr));
    if (!changing) body.append(h('p', 'wapp-lockdlg__line', 'Optional. If you turn it on, Aretia asks for it before showing this wallet on this computer. Nothing is sent anywhere, and you can turn it off whenever you like.'));
    if (note) {
      const n = h('p', 'wapp-lockdlg__ok', note);
      n.setAttribute('role', 'status');
      body.append(n);
    }

    let method: LockMethod = deviceOk ? 'device' : 'pin';
    const form = h('form', 'wapp-lockdlg__form');
    const options = h('fieldset', 'wapp-lockdlg__methods');
    options.append(h('legend', '', 'Unlock with'));
    const fields = h('div', 'wapp-lockdlg__fields');
    const say = h('p', 'wapp-lockdlg__err');
    say.setAttribute('role', 'status');
    let autoMin: number = DEFAULT_AUTO_LOCK_MIN;

    const choices: { m: LockMethod; title: string; hint: string }[] = [];
    if (deviceOk) choices.push({ m: 'device', title: deviceUnlockName(navigator.userAgent), hint: 'Uses this computer’s own unlock. Aretia never sees your face, fingerprint or PIN.' });
    choices.push({ m: 'pin', title: 'A PIN', hint: '6 to 10 digits.' }, { m: 'password', title: 'A password', hint: 'At least 8 characters.' });

    const first = h('input', 'wapp__input');
    const second = h('input', 'wapp__input');
    for (const c of choices) {
      const label = h('label', 'wapp-lockdlg__method');
      const radio = h('input');
      radio.type = 'radio';
      radio.name = 'lock-method';
      radio.checked = c.m === method;
      radio.addEventListener('change', () => {
        method = c.m;
        drawFields();
      });
      const text = h('span');
      text.append(h('strong', '', c.title), h('small', '', c.hint));
      label.append(radio, text);
      options.append(label);
    }

    function drawFields(): void {
      fields.replaceChildren();
      say.textContent = '';
      if (method === 'device') {
        fields.append(h('p', 'wapp-lockdlg__line', 'Your computer will ask you to confirm once, to set this up.'));
        return;
      }
      for (const [inp, name] of [[first, method === 'pin' ? 'New PIN' : 'New password'], [second, method === 'pin' ? 'Type the PIN again' : 'Type the password again']] as const) {
        inp.type = 'password';
        inp.value = '';
        inp.autocomplete = 'new-password';
        inp.placeholder = name;
        inp.setAttribute('aria-label', name);
        inp.inputMode = method === 'pin' ? 'numeric' : 'text';
        fields.append(inp);
      }
    }

    const save = h('button', 'wapp__btn wapp__btn--primary', 'Turn on the lock');
    save.type = 'submit';
    const cancel = h('button', 'wapp__btn wapp__btn--ghost', changing ? 'Back' : 'Not now');
    cancel.type = 'button';
    cancel.addEventListener('click', () => (changing ? drawStatus(body, addr, '') : closeSettings()));
    const actions = h('div', 'wapp-lockdlg__row');
    actions.append(save, cancel);

    form.append(options, fields, autoLockSelect(autoMin, (m) => (autoMin = m)), say, actions);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void (async () => {
        say.textContent = '';
        let secret: LockRecord['secret'];
        let device: LockRecord['device'];
        if (method === 'device') {
          // The computer's own prompt appears here.
        } else {
          const problem = method === 'pin' ? pinProblem(first.value) : passwordProblem(first.value);
          if (problem) return void (say.textContent = problem);
          if (first.value !== second.value) return void (say.textContent = method === 'pin' ? 'The two PINs do not match.' : 'The two passwords do not match.');
        }
        save.setAttribute('disabled', '');
        say.textContent = method === 'device' ? 'Waiting for your computer…' : 'Saving…';
        try {
          if (method === 'device') device = await registerDevice(`Aretia wallet ${short(addr)}`, deps());
          else secret = await hashSecret(first.value);
        } catch (err) {
          save.removeAttribute('disabled');
          say.textContent = method === 'device' ? (err instanceof Error && !/NotAllowed|cancel/i.test(err.name + err.message) ? err.message : 'It was not set up. You can try again, or choose a PIN or password.') : 'The lock could not be set up in this browser.';
          return;
        }
        const rec: LockRecord = { v: 1, method, createdAt: Date.now(), autoLockMin: autoMin, ...(secret ? { secret } : {}), ...(device ? { device } : {}), fails: 0, lockedUntil: 0 };
        if (!store.set(addr, rec) || !store.has(addr)) {
          save.removeAttribute('disabled');
          say.textContent = 'This browser would not keep the lock (private browsing or blocked storage), so it was not turned on.';
          return;
        }
        refreshButton();
        // Setting it up is itself proof it is the owner at the keyboard: no lock screen straight away.
        lastActive = Date.now();
        drawStatus(body, addr, 'The lock is on for this wallet.');
      })();
    });
    body.append(form, h('p', 'wapp-lockdlg__fine', FINE));
    drawFields();
  }

  // ---------------------------------------------------------------- wiring

  if (button) {
    button.addEventListener('click', () => (desktop ? openSettings() : host.disconnect()));
    // Pressing anywhere inside the page counts as being there. The timer below locks it again after the idle time chosen.
    for (const ev of ['pointerdown', 'keydown', 'wheel'] as const) window.addEventListener(ev, () => (lastActive = Date.now()), { passive: true });
    const idleCheck = (): void => {
      const rec = address ? store.get(address) : null;
      if (!rec || screen || rec.autoLockMin === 0) return;
      if (Date.now() - lastActive >= rec.autoLockMin * 60_000) openLockScreen();
    };
    setInterval(idleCheck, 10_000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) idleCheck();
    });
  }
  refreshButton();

  return {
    /** The connected wallet changed (or was disconnected). A wallet with a lock is locked at once; one without is left alone. */
    onWallet(next) {
      if (next === address) return;
      address = next;
      closeSettings();
      closeLockScreen();
      refreshButton();
      lastActive = Date.now();
      if (desktop && next && store.has(next)) openLockScreen();
    },
  };
}
