import { describe, expect, it } from 'vitest';
import { WalletSessionManager, type KeyValueStorage, type ManagerEvent } from './sessionManager.js';
import { NO_CAPABILITIES, type SessionChange, type WalletAdapter, type WalletCapabilities, type WalletSession } from './types.js';
import type { ChainId } from '../core/types.js';
import { CHAINS } from '../core/types.js';

const CAPS: WalletCapabilities = { signMessage: true, signWithoutSending: false, switchNetwork: true, multipleAccounts: true, emitsChanges: true };

/** A wallet whose account and network a test can change at will, announcing each change the way real wallets do. */
class FakeWallet implements WalletAdapter {
  chainType: 'solana' | 'evm';
  private revision = 0;
  private state: WalletSession['state'] = 'disconnected';
  private listeners = new Set<(c: SessionChange, s: WalletSession) => void>();
  authorised = true; // whether restore() finds the wallet still approved for this page

  constructor(
    readonly providerId: string,
    readonly providerName: string,
    private chain: ChainId,
    private address: string,
    private switchable = true,
  ) {
    this.chainType = CHAINS[chain].kind === 'solana' ? 'solana' : 'evm';
  }

  getSession(): WalletSession {
    const on = this.state === 'connected';
    return { providerId: this.providerId, providerName: this.providerName, chainType: this.chainType, address: on ? this.address : null, accounts: on ? [this.address] : [], chain: on ? this.chain : null, networkId: on && this.chainType === 'evm' ? (CHAINS[this.chain].evmChainId ?? null) : null, state: this.state, capabilities: on ? { ...CAPS, switchNetwork: this.switchable && this.chainType === 'evm' } : NO_CAPABILITIES, connectedAt: on ? 1 : null, revision: this.revision };
  }
  private fire(c: SessionChange): void {
    this.revision++;
    for (const l of [...this.listeners]) l(c, this.getSession());
  }
  isConnected = () => this.state === 'connected';
  async connect() {
    this.state = 'connected';
    this.fire('connected');
    return this.getSession();
  }
  async restore() {
    if (!this.authorised) return null;
    this.state = 'connected';
    this.fire('connected');
    return this.getSession();
  }
  async disconnect() {
    this.state = 'disconnected';
    this.fire('disconnected');
  }
  async refresh() {
    return this.getSession();
  }
  async getAddress() {
    return this.address;
  }
  async getBalance(): Promise<never> {
    throw new Error('unused');
  }
  async signTransaction(): Promise<never> {
    throw new Error('unused');
  }
  async signMessage(): Promise<never> {
    throw new Error('unused');
  }
  async sendTransaction(): Promise<never> {
    throw new Error('unused');
  }
  async switchNetwork(c: ChainId) {
    this.chain = c;
    this.fire('network-changed');
  }
  onChange(l: (c: SessionChange, s: WalletSession) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  // test controls
  moveToAccount(a: string) {
    this.address = a;
    this.fire('account-changed');
  }
  moveToChain(c: ChainId) {
    this.chain = c;
    this.fire('network-changed');
  }
}

const memory = (): KeyValueStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};

const SOL = 'SoLAddr1111111111111111111111111111111111111';
const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const C = '0x' + 'c'.repeat(40);

function three() {
  const sol = new FakeWallet('aretia-solana', 'Phantom', 'solana', SOL);
  const eth = new FakeWallet('io.metamask', 'MetaMask', 'ethereum', A);
  const base = new FakeWallet('io.rabby', 'Rabby', 'base', B, false);
  return { sol, eth, base };
}

describe('WalletSessionManager', () => {
  it('holds several wallets at once, each with its own session, and never mixes their accounts', async () => {
    const { sol, eth, base } = three();
    const m = new WalletSessionManager();
    [sol, eth, base].forEach((w) => m.add(w));
    await m.connect('aretia-solana');
    await m.connect('io.metamask');
    await m.connect('io.rabby');
    expect(m.connectedSessions().map((s) => [s.providerId, s.address, s.chain])).toEqual([['aretia-solana', SOL, 'solana'], ['io.metamask', A, 'ethereum'], ['io.rabby', B, 'base']]);
    // The last connected wallet is active, but a Solana action still goes to the Solana wallet, never to an EVM one.
    expect(m.active?.providerId).toBe('io.rabby');
    expect(m.walletFor('solana')?.providerId).toBe('aretia-solana');
    expect(m.walletFor('ethereum')?.providerId).toBe('io.metamask');
    expect(m.walletFor('base')?.providerId).toBe('io.rabby');
    // Rabby is pinned to Base here, so it is not offered for Polygon; MetaMask can be switched there, so it is.
    expect(m.walletFor('polygon')?.providerId).toBe('io.metamask');
  });

  it('reads the active account and chain from the active wallet itself, so they cannot go stale', async () => {
    const { eth } = three();
    const m = new WalletSessionManager();
    m.add(eth);
    await m.connect('io.metamask');
    expect(m.activeSession).toMatchObject({ address: A, chain: 'ethereum' });
    eth.moveToAccount(C);
    eth.moveToChain('polygon');
    expect(m.activeSession).toMatchObject({ address: C, chain: 'polygon' });
  });

  it('passes on session changes, and follows the active wallet when it disconnects', async () => {
    const { sol, eth } = three();
    const m = new WalletSessionManager();
    m.add(sol);
    m.add(eth);
    const events: string[] = [];
    m.subscribe((e: ManagerEvent) => events.push(e.type === 'session' ? `${e.providerId}:${e.change}` : e.type === 'active-changed' ? `active:${e.providerId}` : `restored:${e.providerId}`));
    await m.connect('aretia-solana');
    await m.connect('io.metamask');
    eth.moveToAccount(B);
    await m.disconnect('io.metamask');
    expect(events).toEqual(['aretia-solana:connected', 'active:aretia-solana', 'io.metamask:connected', 'active:io.metamask', 'io.metamask:account-changed', 'io.metamask:disconnected', 'active:aretia-solana']);
    expect(m.active?.providerId).toBe('aretia-solana');
    await m.disconnect('aretia-solana');
    expect(m.active).toBeNull();
  });

  it('refuses to connect or activate a wallet it does not know', async () => {
    const m = new WalletSessionManager();
    await expect(m.connect('nope')).rejects.toThrow(/not available/);
    expect(() => m.setActive('nope')).toThrow(/not available/);
    expect(() => m.lease('solana')).toThrow(/No connected wallet/);
  });
});

describe('leases: stale wallet state cannot reach signing', () => {
  async function ready() {
    const { eth, sol } = three();
    const m = new WalletSessionManager();
    m.add(eth);
    m.add(sol);
    await m.connect('io.metamask');
    return { m, eth, sol };
  }

  it('redeems while nothing has changed', async () => {
    const { m, eth } = await ready();
    const lease = m.lease('ethereum');
    expect(lease).toMatchObject({ providerId: 'io.metamask', address: A, chain: 'ethereum' });
    expect(await m.redeem(lease)).toBe(eth);
  });

  it('refuses after the account changed, even if it changed back (the wallet was touched)', async () => {
    const { m, eth } = await ready();
    const lease = m.lease('ethereum');
    eth.moveToAccount(B);
    await expect(m.redeem(lease)).rejects.toThrow(/not the one this quote|changed after/);
    eth.moveToAccount(A);
    await expect(m.redeem(lease)).rejects.toThrow(/changed after this quote/);
  });

  it('refuses after the network changed, and after a disconnect', async () => {
    const { m, eth } = await ready();
    const lease = m.lease('ethereum');
    eth.moveToChain('base');
    await expect(m.redeem(lease)).rejects.toThrow();
    const second = (() => {
      eth.moveToChain('ethereum');
      return m.lease('ethereum');
    })();
    await eth.disconnect();
    await expect(m.redeem(second)).rejects.toThrow(/not connected|changed/);
  });

  it('refuses a lease for a wallet that was removed, and leases only a connected wallet', async () => {
    const { m } = await ready();
    const lease = m.lease('ethereum');
    await m.remove('io.metamask');
    await expect(m.redeem(lease)).rejects.toThrow(/no longer available/);
    expect(() => m.lease('solana', 'aretia-solana')).toThrow(/not connected/);
  });

  it('can pin a lease to the destinations Aretia expects', async () => {
    const { m } = await ready();
    const lease = m.lease('ethereum');
    await expect(m.redeem(lease, { allowedDestinations: ['0x' + '9'.repeat(40)] })).resolves.toBeDefined();
  });
});

describe('reconnection', () => {
  it('saves only public information: providers and addresses, never anything secret', async () => {
    const { eth, sol } = three();
    const store = memory();
    const m = new WalletSessionManager(store);
    m.add(eth);
    m.add(sol);
    await m.connect('io.metamask');
    await m.connect('aretia-solana');
    const raw = store.data.get('aretia-swings-wallets')!;
    expect(JSON.parse(raw)).toEqual({ version: 1, active: 'aretia-solana', wallets: [{ providerId: 'io.metamask', address: A }, { providerId: 'aretia-solana', address: SOL }] });
    expect(raw).not.toMatch(/seed|mnemonic|private|secret|key|signature/i);
    await m.disconnectAll();
    expect(store.data.size).toBe(0);
  });

  it('after a reload, reattaches without a prompt to wallets that are still authorised on the same account', async () => {
    const store = memory();
    const first = three();
    const m1 = new WalletSessionManager(store);
    [first.eth, first.sol].forEach((w) => m1.add(w));
    await m1.connect('io.metamask');
    await m1.connect('aretia-solana');
    // A new page load: new adapter objects, nothing connected yet.
    const again = three();
    const m2 = new WalletSessionManager(store);
    [again.eth, again.sol].forEach((w) => m2.add(w));
    const events: string[] = [];
    m2.subscribe((e) => e.type === 'restored' && events.push(e.providerId));
    expect(await m2.restore()).toEqual(['io.metamask', 'aretia-solana']);
    expect(events).toEqual(['io.metamask', 'aretia-solana']);
    expect(m2.active?.providerId).toBe('aretia-solana');
  });

  it('does not restore a wallet that is no longer authorised, or that is now on a different account', async () => {
    const store = memory();
    const first = three();
    const m1 = new WalletSessionManager(store);
    [first.eth, first.sol].forEach((w) => m1.add(w));
    await m1.connect('io.metamask');
    await m1.connect('aretia-solana');
    const again = three();
    again.sol.authorised = false;
    again.eth.moveToAccount(C); // the user changed account in the wallet while the page was closed
    const m2 = new WalletSessionManager(store);
    [again.eth, again.sol].forEach((w) => m2.add(w));
    expect(await m2.restore()).toEqual([]);
    expect(again.eth.isConnected()).toBe(false); // it was reattached, found to be someone else, and let go
    expect(m2.active).toBeNull();
  });

  it('ignores damaged saved data and a storage that throws, and does nothing without storage', async () => {
    const bad = memory();
    bad.data.set('aretia-swings-wallets', '{not json');
    const m = new WalletSessionManager(bad);
    m.add(three().eth);
    expect(await m.restore()).toEqual([]);
    bad.data.set('aretia-swings-wallets', JSON.stringify({ version: 9, wallets: [] }));
    expect(await m.restore()).toEqual([]);
    const throwing: KeyValueStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    const m2 = new WalletSessionManager(throwing);
    const w = three().eth;
    m2.add(w);
    await expect(m2.connect('io.metamask')).resolves.toBeDefined(); // saving failed quietly; the connection is unaffected
    expect(await new WalletSessionManager().restore()).toEqual([]);
  });
});
