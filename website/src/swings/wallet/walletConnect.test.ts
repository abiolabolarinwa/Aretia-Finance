import { describe, expect, it } from 'vitest';
import { asEip1193, connectWalletConnect, hasSavedSession, isProjectId, restoreWalletConnect, supportedEvmIds, WALLETCONNECT_UUID, type WcLoader, type WcProvider } from './walletConnect.js';
import { EvmSession } from '../chains/evmSession.js';
import { listWalletProviders } from './providers.js';
import { SwingsError } from '../core/types.js';

const PROJECT = 'a'.repeat(32);
const ACCOUNT = '0x' + 'c'.repeat(40);

class FakeWc implements WcProvider {
  session: unknown = undefined;
  accounts: string[] = [];
  connects = 0;
  disconnected = 0;
  requests: string[] = [];
  rejectConnect = false;
  async connect(): Promise<void> {
    this.connects++;
    if (this.rejectConnect) throw Object.assign(new Error('User rejected'), { code: 4001 });
    this.session = { topic: 't' };
    this.accounts = [ACCOUNT];
  }
  async disconnect(): Promise<void> {
    this.disconnected++;
    this.session = undefined;
    this.accounts = [];
  }
  async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    this.requests.push(args.method);
    if (args.method === 'eth_accounts') return this.accounts;
    if (args.method === 'eth_chainId') return '0x1';
    return null;
  }
}
const loader = (wc: FakeWc): WcLoader => async () => wc;

describe('WalletConnect', () => {
  it('is offered only with a real project id (32 hex characters)', () => {
    expect(isProjectId(PROJECT)).toBe(true);
    for (const bad of ['', 'abc', 'Z'.repeat(32), undefined, 5, 'a'.repeat(33)]) expect(isProjectId(bad), String(bad)).toBe(false);
  });

  it('asks only for Ethereum first and lists every network Swings supports as optional', () => {
    const ids = supportedEvmIds();
    expect(ids).toContain(8453);
    expect(ids).toContain(1);
    expect(ids).not.toContain(0);
  });

  it('shows the QR (connect) when there is no session, then connects as an ordinary EVM wallet with the right account', async () => {
    const wc = new FakeWc();
    const evm = new EvmSession();
    const account = await connectWalletConnect(evm, PROJECT, loader(wc));
    expect(account).toBe(ACCOUNT);
    expect(wc.connects).toBe(1);
    expect(evm.walletName).toBe('WalletConnect');
    expect(evm.account).toBe(ACCOUNT);
    expect(evm.adapter).not.toBeNull();
  });

  it('uses a saved session without any prompt', async () => {
    const wc = new FakeWc();
    wc.session = { topic: 'saved' };
    wc.accounts = [ACCOUNT];
    const evm = new EvmSession();
    expect(await restoreWalletConnect(evm, PROJECT, loader(wc))).toBe(ACCOUNT);
    expect(wc.connects).toBe(0);
  });

  it('restores nothing when there is no saved session, no project id, or the library will not load', async () => {
    expect(await restoreWalletConnect(new EvmSession(), PROJECT, loader(new FakeWc()))).toBeNull();
    expect(await restoreWalletConnect(new EvmSession(), '', loader(new FakeWc()))).toBeNull();
    expect(await restoreWalletConnect(new EvmSession(), PROJECT, async () => { throw new Error('chunk failed'); })).toBeNull();
  });

  it('reports a declined connection as declined, and a missing id or failed load in plain words', async () => {
    const wc = new FakeWc();
    wc.rejectConnect = true;
    await expect(connectWalletConnect(new EvmSession(), PROJECT, loader(wc))).rejects.toMatchObject({ code: 'rejected' });
    await expect(connectWalletConnect(new EvmSession(), 'nope', loader(new FakeWc()))).rejects.toMatchObject({ code: 'config-missing' });
    await expect(connectWalletConnect(new EvmSession(), PROJECT, async () => { throw new Error('x'); })).rejects.toThrow(SwingsError);
  });

  it('closes the WalletConnect session when the page disconnects, and passes other requests straight through', async () => {
    const wc = new FakeWc();
    const evm = new EvmSession();
    await connectWalletConnect(evm, PROJECT, loader(wc));
    expect(await asEip1193(wc).request({ method: 'eth_chainId' })).toBe('0x1');
    await evm.disconnect();
    expect(wc.disconnected).toBe(1);
    expect(evm.account).toBeNull();
  });

  it('does not add a second WalletConnect entry on reconnect', async () => {
    const evm = new EvmSession();
    await connectWalletConnect(evm, PROJECT, loader(new FakeWc()));
    await connectWalletConnect(evm, PROJECT, loader(new FakeWc()));
    expect(evm.wallets.filter((w) => w.info.uuid === WALLETCONNECT_UUID)).toHaveLength(1);
  });

  it('detects a saved session from storage keys without loading the library', () => {
    const store = (keys: string[]) => ({ length: keys.length, key: (i: number) => keys[i] ?? null });
    expect(hasSavedSession(store(['theme', 'wc@2:client:0.3//session']))).toBe(true);
    expect(hasSavedSession(store(['theme']))).toBe(false);
  });

  it('is listed honestly as available or not', () => {
    const on = listWalletProviders({ aretiaSolanaHost: false, evmWallets: [], walletConnectConfigured: true }).find((p) => p.id === 'walletconnect')!;
    const off = listWalletProviders({ aretiaSolanaHost: false, evmWallets: [] }).find((p) => p.id === 'walletconnect')!;
    expect(on.available).toBe(true);
    expect(off.available).toBe(false);
    expect(off.note).toMatch(/no WalletConnect project id/);
  });
});
