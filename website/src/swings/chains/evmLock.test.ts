import { describe, expect, it } from 'vitest';
import { EvmSession } from './evmSession.js';
import type { DiscoveredWallet } from './evmWallet.js';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);

/** A wallet that shares `accounts` and can emit EIP-1193 events, like MetaMask does when it locks. */
function fakeWallet(accounts: string[]) {
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  const log: string[] = [];
  const state = { accounts };
  const provider = {
    request: async ({ method }: { method: string }) => {
      log.push(method);
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return state.accounts;
      throw new Error('unexpected ' + method);
    },
    on: (e: string, fn: (...a: unknown[]) => void) => {
      if (!listeners.has(e)) listeners.set(e, new Set());
      listeners.get(e)!.add(fn);
    },
    removeListener: (e: string, fn: (...a: unknown[]) => void) => void listeners.get(e)?.delete(fn),
  };
  const emit = (e: string, ...a: unknown[]) => listeners.get(e)?.forEach((fn) => fn(...a));
  const wallet = { info: { uuid: 'mm', name: 'MetaMask', icon: '', rdns: 'mm' }, provider } as unknown as DiscoveredWallet;
  return { wallet, emit, log, state, count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0) };
}

async function connected(w: ReturnType<typeof fakeWallet>) {
  const s = new EvmSession();
  s.wallets = [w.wallet];
  await s.resume('MetaMask');
  return s;
}

describe('a wallet that locks itself while the page is open', () => {
  it('is shown as locked, not as still connected, and keeps the wallet so it can be unlocked', async () => {
    const w = fakeWallet([A]);
    const s = await connected(w);
    const seen: { account: string | null; accountChanged: boolean }[] = [];
    s.onChange = (c) => seen.push(c);
    expect(s.account).toBe(A);

    w.emit('accountsChanged', []);

    expect(s.account).toBeNull();
    expect(s.locked).toBe(true);
    expect(s.adapter).not.toBeNull();
    expect(s.walletName).toBe('MetaMask');
    expect(seen).toEqual([{ account: null, accountChanged: true }]);
  });

  it('unlocks through the wallet and gets the account back', async () => {
    const w = fakeWallet([A]);
    const s = await connected(w);
    w.emit('accountsChanged', []);
    expect(await s.unlock()).toBe(A);
    expect(s.account).toBe(A);
    expect(s.locked).toBe(false);
    expect(w.log).toContain('eth_requestAccounts');
  });

  it('notices an account switch, and a network change without a new account', async () => {
    const w = fakeWallet([A]);
    const s = await connected(w);
    const seen: boolean[] = [];
    s.onChange = (c) => seen.push(c.accountChanged);
    w.emit('accountsChanged', [B]);
    expect(s.account).toBe(B);
    expect(s.locked).toBe(false);
    w.emit('accountsChanged', [B.toUpperCase().replace('0X', '0x')]);
    w.emit('chainChanged', '0x38');
    expect(seen).toEqual([true, false, false]);
  });

  it('ignores a malformed account list and stops listening once disconnected', async () => {
    const w = fakeWallet([A]);
    const s = await connected(w);
    w.emit('accountsChanged', ['not-an-address']);
    expect(s.account).toBeNull();
    expect(s.locked).toBe(true);
    expect(w.count()).toBe(2);
    await s.disconnect();
    expect(w.count()).toBe(0);
    expect(s.locked).toBe(false);
  });

  it('reads a locked wallet as locked when it is asked before signing', async () => {
    const w = fakeWallet([A]);
    const s = await connected(w);
    w.state.accounts = [];
    expect(await s.refreshAccount()).toBeNull();
    expect(s.locked).toBe(true);
  });

  it('refuses to unlock when no wallet was ever connected', async () => {
    await expect(new EvmSession().unlock()).rejects.toThrow(/no wallet/i);
  });
});
