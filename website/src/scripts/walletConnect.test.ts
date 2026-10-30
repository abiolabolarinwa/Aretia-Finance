import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Eip1193WalletAdapter } from '../swings/chains/evmWallet';
import { EvmSession } from '../swings/chains/evmSession';

/**
 * The site-wide connect button (public/assets/wallet/wallet.js) is a plain script, so it is run here against a small
 * fake window: wallets that register themselves the way the Wallet Standard describes, with connect calls that hang,
 * reject or answer, and the clock under test control.
 */
const SOURCE = readFileSync(new URL('../../public/assets/wallet/wallet.js', import.meta.url), 'utf8');

interface FakeWallet {
  name: string;
  chains: string[];
  features: Record<string, unknown>;
}
const ACCOUNT = { address: 'So1anaAddress1111111111111111111111111111111' };

function fakeElement(): unknown {
  const target: Record<string, unknown> = { dataset: {}, style: {}, hidden: false, children: [] };
  return new Proxy(target, {
    get: (t, k) => {
      if (k in t) return t[k as string];
      if (k === 'querySelector') return () => fakeElement();
      if (k === 'querySelectorAll') return () => [];
      return () => undefined;
    },
    set: (t, k, v) => ((t[k as string] = v), true),
  });
}

function load(opts: { lastWallet?: string } = {}) {
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  const store = new Map<string, string>(opts.lastWallet ? [['aretia:lastWalletName', opts.lastWallet]] : []);
  win.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  win.matchMedia = () => ({ matches: true });
  const mount = fakeElement();
  const doc = {
    readyState: 'complete',
    querySelector: (sel: string) => (sel === '[data-aretia-wallet-mount]' ? mount : null),
    createElement: () => fakeElement(),
    addEventListener: () => undefined,
    body: fakeElement(),
    activeElement: null,
  };
  win.document = doc;
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, navigator: g.navigator };
  g.window = win;
  g.document = doc;
  Object.defineProperty(globalThis, 'navigator', { value: { maxTouchPoints: 0 }, configurable: true });
  (win as Record<string, unknown>).CustomEvent = CustomEvent;
  new Function(SOURCE).call(undefined);
  const api = (win as unknown as { AretiaWallet: { connect(n: string, o?: { silent?: boolean }): Promise<unknown>; getState(): { account: unknown; connecting: boolean }; disconnect(): Promise<void>; utils: { formatWalletError(e: unknown): string } } }).AretiaWallet;
  const register = (wallet: FakeWallet) => win.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: (arg: { register(w: FakeWallet): void }) => arg.register(wallet) }));
  return {
    api,
    register,
    store,
    restore: () => {
      g.window = saved.window;
      g.document = saved.document;
      if (saved.navigator) Object.defineProperty(globalThis, 'navigator', { value: saved.navigator, configurable: true });
    },
  };
}

const wallet = (name: string, connect: (o?: { silent?: boolean }) => Promise<unknown>, extra: Record<string, unknown> = {}): FakeWallet => ({
  name,
  chains: ['solana:mainnet'],
  features: { 'standard:connect': { connect }, ...extra },
});

let env: ReturnType<typeof load> | null = null;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  env?.restore();
  env = null;
  vi.useRealTimers();
});

describe('connect', () => {
  it('a second click while a request is open joins it and does not ask the wallet again', async () => {
    env = load();
    const connect = vi.fn(() => new Promise((r) => setTimeout(() => r({ accounts: [ACCOUNT] }), 1000)));
    env.register(wallet('Phantom', connect));
    const a = env.api.connect('Phantom');
    const b = env.api.connect('Phantom');
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([a, b]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(env.api.getState().account).toEqual(ACCOUNT);
    expect(env.api.getState().connecting).toBe(false);
  });

  it('says the wallet did not answer, with what to do, when it never replies', async () => {
    env = load();
    env.register(wallet('Phantom', () => new Promise(() => undefined)));
    const result = env.api.connect('Phantom').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await result;
    expect(env.api.utils.formatWalletError(err)).toMatch(/didn't answer.*toolbar/);
    expect(env.api.getState().connecting).toBe(false);
  });

  it('reports a rejection plainly and leaves the button usable', async () => {
    env = load();
    env.register(wallet('Phantom', () => Promise.reject(new Error('User rejected the request.'))));
    const err = await env.api.connect('Phantom').catch((e: unknown) => e);
    expect(env.api.utils.formatWalletError(err)).toBe('Wallet connection was cancelled.');
    expect(env.api.getState().connecting).toBe(false);
  });

  it('shows the own reason of the wallet for an error it does not recognise, and says so when a wallet declines an unverified site', async () => {
    env = load();
    env.register(wallet('Phantom', () => Promise.reject(new Error('Unexpected error (-32603)'))));
    const odd = await env.api.connect('Phantom').catch((e: unknown) => e);
    expect(env.api.utils.formatWalletError(odd)).toBe('Something went wrong connecting your wallet (Unexpected error (-32603)). Please try again.');
    const blocked = new Error('This website has been flagged as malicious');
    expect(env.api.utils.formatWalletError(blocked)).toMatch(/declined to connect to this site.*unverified/);
  });

  it('says a wallet that is not installed is not installed', async () => {
    env = load();
    const err = await env.api.connect('Phantom').catch((e: unknown) => e);
    expect(env.api.utils.formatWalletError(err)).toMatch(/isn't installed/);
  });
});

describe('reconnect after a refresh', () => {
  it('connects the remembered wallet as soon as it has registered, with no fixed delay', async () => {
    env = load({ lastWallet: 'Phantom' });
    const connect = vi.fn(async () => ({ accounts: [ACCOUNT] }));
    env.register(wallet('Phantom', connect));
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledWith({ silent: true });
    expect(env.api.getState().account).toEqual(ACCOUNT);
  });

  it('still reconnects when the extension announces itself a second or two late', async () => {
    env = load({ lastWallet: 'Phantom' });
    const connect = vi.fn(async () => ({ accounts: [ACCOUNT] }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(connect).not.toHaveBeenCalled();
    env.register(wallet('Phantom', connect));
    await vi.advanceTimersByTimeAsync(0);
    expect(env.api.getState().account).toEqual(ACCOUNT);
  });

  it('gives up quietly when the wallet never shows up, and does not connect later on its own', async () => {
    env = load({ lastWallet: 'Phantom' });
    const connect = vi.fn(async () => ({ accounts: [ACCOUNT] }));
    await vi.advanceTimersByTimeAsync(5000);
    env.register(wallet('Phantom', connect));
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).not.toHaveBeenCalled();
    expect(env.api.getState().account).toBeNull();
  });

  it('does not wait for ever on a wallet that never answers a silent connect', async () => {
    env = load({ lastWallet: 'Phantom' });
    env.register(wallet('Phantom', () => new Promise(() => undefined)));
    await vi.advanceTimersByTimeAsync(4100);
    // A manual connect is not blocked by the abandoned silent attempt.
    expect(env.api.getState().connecting).toBe(false);
    expect(env.api.getState().account).toBeNull();
  });
});

describe('disconnect', () => {
  it('forgets the wallet within seconds even when the wallet never answers the disconnect', async () => {
    env = load();
    env.register(wallet('Phantom', async () => ({ accounts: [ACCOUNT] }), { 'standard:disconnect': { disconnect: () => new Promise(() => undefined) } }));
    await env.api.connect('Phantom');
    const done = env.api.disconnect();
    await vi.advanceTimersByTimeAsync(3100);
    await done;
    expect(env.api.getState().account).toBeNull();
    expect(env.store.has('aretia:lastWalletName')).toBe(false);
  });
});

describe('Ethereum-style wallets', () => {
  const provider = (request: (a: { method: string }) => Promise<unknown>) => ({ request });

  it('explains a request that is already open in the wallet', async () => {
    const adapter = new Eip1193WalletAdapter(provider(() => Promise.reject(Object.assign(new Error('Request of type eth_requestAccounts already pending'), { code: -32002 }))));
    await expect(adapter.connect()).rejects.toThrow(/already has a request waiting/);
  });

  it('says the wallet did not answer instead of waiting for ever', async () => {
    const adapter = new Eip1193WalletAdapter(provider(() => new Promise(() => undefined)));
    const result = adapter.connect().catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(((await result) as Error).message).toMatch(/didn't answer/);
  });

  it('sends one connection request for two clicks', async () => {
    const request = vi.fn(async () => ['0x' + 'ab'.repeat(20)]);
    const host = { addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => true, ethereum: { request } };
    const session = new EvmSession(host as never);
    const discovering = session.discover();
    await vi.advanceTimersByTimeAsync(300);
    await discovering;
    const uuid = session.wallets[0]!.info.uuid;
    const [a, b] = await Promise.all([session.connect(uuid), session.connect(uuid)]);
    expect(a).toBe(b);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('restores quickly past a wallet that hangs on a quiet account check', async () => {
    const host = { addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => true, ethereum: { request: () => new Promise(() => undefined) } };
    const session = new EvmSession(host as never);
    const resumed = session.resume(null);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(resumed).resolves.toBeNull();
  });
});
