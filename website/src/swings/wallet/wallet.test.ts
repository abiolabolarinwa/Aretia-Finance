import { describe, expect, it, vi } from 'vitest';
import * as web3 from '@solana/web3.js';
import { SolanaContextWallet, type SolanaSigningContext, type SolanaWalletHost, type SolanaWalletState } from './solanaContextWallet.js';
import { chainForEvmId, EvmBridgeWallet, type EvmEventSource } from './evmBridgeWallet.js';
import { ensureNetwork, sessionProblems, transactionProblems, verifyBeforeExecute } from './safety.js';
import { listWalletProviders } from './providers.js';
import type { SessionChange, WalletSession } from './types.js';
import type { EvmWalletAdapter } from '../chains/evmWallet.js';
import type { SolRpc } from '../solana/raydiumCpmm.js';
import { EVM_NATIVE_ADDRESS, SOLANA_NATIVE_ADDRESS } from '../core/types.js';

const USER = web3.Keypair.generate().publicKey.toBase58();
const OTHER = web3.Keypair.generate().publicKey.toBase58();
const EVM_USER = '0x' + '1'.repeat(40);
const EVM_OTHER = '0x' + '2'.repeat(40);
const ROUTER = '0x' + 'a'.repeat(40);

// ------------------------------------------------------------------ Solana

function fakeHost(opts: { address?: string | null; context?: SolanaSigningContext | null } = {}) {
  let state: SolanaWalletState = { account: opts.address === null ? null : { address: opts.address ?? USER }, connecting: false, walletName: 'Phantom' };
  const listeners = new Set<() => void>();
  const host: SolanaWalletHost & { set(s: Partial<SolanaWalletState>): void; connectRequests: number } = {
    connectRequests: 0,
    state: () => state,
    context: () => (opts.context === undefined ? { signTransaction: async (t) => t, signMessage: async (m) => m } : opts.context),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    disconnect: async () => host.set({ account: null }),
    requestConnect: () => {
      host.connectRequests++;
    },
    set(s) {
      state = { ...state, ...s };
      for (const l of [...listeners]) l();
    },
  };
  return host;
}

const transferTx = (from: string, lamports = 1): web3.VersionedTransaction =>
  new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: new web3.PublicKey(from), recentBlockhash: web3.PublicKey.default.toBase58(), instructions: [web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(from), toPubkey: new web3.PublicKey(OTHER), lamports })] }).compileToV0Message());

describe('SolanaContextWallet', () => {
  const rpc = (answers: Record<string, unknown>) => (async (m: string) => answers[m]) as unknown as SolRpc;

  it('describes the session from what the wallet host reports, with only the capabilities it really has', () => {
    const w = new SolanaContextWallet(fakeHost(), { rpc: rpc({}), now: () => 5 });
    const s = w.getSession();
    expect(s).toMatchObject({ providerId: 'aretia-solana', providerName: 'Phantom', chainType: 'solana', address: USER, accounts: [USER], chain: 'solana', networkId: null, state: 'connected', connectedAt: 5 });
    expect(s.capabilities).toEqual({ signMessage: true, signWithoutSending: true, switchNetwork: false, multipleAccounts: false, emitsChanges: true });
    const bare = new SolanaContextWallet(fakeHost({ context: {} }), { rpc: rpc({}) }).getSession();
    expect(bare.capabilities).toMatchObject({ signMessage: false, signWithoutSending: false });
    const off = new SolanaContextWallet(fakeHost({ address: null }), { rpc: rpc({}) }).getSession();
    expect(off).toMatchObject({ state: 'disconnected', address: null, accounts: [] });
    expect(off.capabilities.signMessage).toBe(false);
  });

  it('connect: returns at once when already connected, otherwise opens the connect screen and waits for the user to finish', async () => {
    const already = fakeHost();
    await new SolanaContextWallet(already, { rpc: rpc({}) }).connect();
    expect(already.connectRequests).toBe(0);
    const host = fakeHost({ address: null });
    const w = new SolanaContextWallet(host, { rpc: rpc({}) });
    const pending = w.connect();
    expect(host.connectRequests).toBe(1);
    host.set({ account: { address: USER } });
    expect((await pending).address).toBe(USER);
  });

  it('connect gives up, as a declined connection, when nobody connects in time', async () => {
    const w = new SolanaContextWallet(fakeHost({ address: null }), { rpc: rpc({}), connectTimeoutMs: 20 });
    await expect(w.connect()).rejects.toMatchObject({ code: 'rejected' });
  });

  it('reads the SOL balance and a token balance (summed over accounts), and the decimals of a token it holds none of', async () => {
    const w = new SolanaContextWallet(fakeHost(), {
      rpc: (async (m: string, p: unknown[]) => {
        if (m === 'getBalance') return { value: 2_500_000_000 };
        if (m === 'getTokenAccountsByOwner') return (p[1] as { mint: string }).mint === 'Held' ? { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: '7', decimals: 6 } } } } } }, { account: { data: { parsed: { info: { tokenAmount: { amount: '5', decimals: 6 } } } } } }] } : { value: [] };
        if (m === 'getTokenSupply') return { value: { decimals: 9 } };
        throw new Error(m);
      }) as unknown as SolRpc,
      now: () => 9,
    });
    expect(await w.getBalance({ chain: 'solana', address: SOLANA_NATIVE_ADDRESS })).toEqual({ asset: { chain: 'solana', address: SOLANA_NATIVE_ADDRESS }, amount: 2_500_000_000n, decimals: 9, readAt: 9 });
    expect(await w.getBalance({ chain: 'solana', address: 'Held' })).toMatchObject({ amount: 12n, decimals: 6 });
    expect(await w.getBalance({ chain: 'solana', address: 'None' })).toMatchObject({ amount: 0n, decimals: 9 });
    await expect(w.getBalance({ chain: 'base', address: EVM_NATIVE_ADDRESS })).rejects.toThrow(/only holds Solana/);
  });

  it('signs a transaction only if the wallet hands back the same transaction, and refuses a swapped one', async () => {
    const tx = transferTx(USER, 5);
    const honest = new SolanaContextWallet(fakeHost(), { rpc: rpc({}) });
    const signed = await honest.signTransaction({ kind: 'solana', transaction: tx });
    expect(signed.kind).toBe('solana');
    const crook = new SolanaContextWallet(fakeHost({ context: { signTransaction: async () => transferTx(USER, 9_999) } }), { rpc: rpc({}) });
    await expect(crook.signTransaction({ kind: 'solana', transaction: tx })).rejects.toThrow(/different transaction/);
    const declines = new SolanaContextWallet(fakeHost({ context: { signTransaction: async () => { throw new Error('User rejected'); } } }), { rpc: rpc({}) });
    await expect(declines.signTransaction({ kind: 'solana', transaction: tx })).rejects.toMatchObject({ code: 'rejected' });
    await expect(honest.signTransaction({ kind: 'evm', tx: { from: EVM_USER, to: ROUTER }, chainId: 1 })).rejects.toThrow(/only sign Solana/);
    await expect(new SolanaContextWallet(fakeHost({ context: {} }), { rpc: rpc({}) }).signTransaction({ kind: 'solana', transaction: tx })).rejects.toMatchObject({ code: 'not-enabled' });
  });

  it('sends a signed transaction with preflight on, and signs then sends an unsigned one; a disconnected wallet sends nothing', async () => {
    const calls: unknown[][] = [];
    const w = new SolanaContextWallet(fakeHost(), { rpc: (async (m: string, p: unknown[]) => { calls.push([m, ...p]); return 'SIG123'; }) as unknown as SolRpc });
    expect(await w.sendTransaction({ kind: 'solana', transaction: transferTx(USER) })).toBe('SIG123');
    const [method, , options] = calls[0] as [string, string, { skipPreflight: boolean; encoding: string }];
    expect(method).toBe('sendTransaction');
    expect(options).toMatchObject({ skipPreflight: false, encoding: 'base64' });
    const off = new SolanaContextWallet(fakeHost({ address: null }), { rpc: rpc({}) });
    await expect(off.sendTransaction({ kind: 'solana', transaction: transferTx(USER) })).rejects.toMatchObject({ code: 'not-enabled' });
  });

  it('signs messages, and cannot switch networks (there is only one)', async () => {
    const w = new SolanaContextWallet(fakeHost(), { rpc: rpc({}) });
    expect(await w.signMessage(Uint8Array.from([1, 2, 3]))).toEqual(Uint8Array.from([1, 2, 3]));
    await expect(w.switchNetwork()).rejects.toMatchObject({ code: 'not-enabled' });
  });

  it('reports connection and account changes as the host announces them, and bumps the revision', () => {
    const host = fakeHost();
    const w = new SolanaContextWallet(host, { rpc: rpc({}) });
    const seen: [SessionChange, string | null][] = [];
    const off = w.onChange((c, s) => seen.push([c, s.address]));
    const before = w.getSession().revision;
    host.set({ account: { address: OTHER } });
    host.set({ account: null });
    host.set({ account: { address: USER } });
    expect(seen).toEqual([['account-changed', OTHER], ['disconnected', null], ['connected', USER]]);
    expect(w.getSession().revision).toBeGreaterThan(before);
    off();
    host.set({ account: { address: OTHER } });
    expect(seen).toHaveLength(3);
  });
});

// ------------------------------------------------------------------ EVM

function fakeEvm(opts: { accounts?: string[]; chainId?: number } = {}) {
  const state = { accounts: opts.accounts ?? [EVM_USER], chainId: opts.chainId ?? 1, sent: [] as unknown[], switched: [] as number[], raw: [] as unknown[] };
  const adapter: EvmWalletAdapter = {
    connect: async () => state.accounts,
    disconnect: async () => undefined,
    getAccounts: async () => state.accounts,
    getChainId: async () => state.chainId,
    switchChain: async (id) => {
      state.switched.push(id);
      state.chainId = id;
    },
    signTransaction: async () => '0x',
    sendTransaction: async (tx) => {
      state.sent.push(tx);
      return '0x' + 'ab'.repeat(32);
    },
    signMessage: async (m, a) => `signed:${m}:${a}`,
    request: async (method, params) => {
      state.raw.push([method, params]);
      return '0x' + 'cd'.repeat(32);
    },
  };
  const handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  const events: EvmEventSource = {
    on: (e, fn) => (handlers.get(e) ?? handlers.set(e, new Set()).get(e)!).add(fn),
    removeListener: (e, fn) => void handlers.get(e)?.delete(fn),
  };
  const fire = (e: string, ...a: unknown[]) => [...(handlers.get(e) ?? [])].forEach((h) => h(...a));
  return { state, adapter, events, fire, handlers };
}

const readFor = (answers: Record<string, string>) => () => (async (method: string, params: unknown[]) => {
  if (method === 'eth_getBalance') return answers.native ?? '0x0';
  if (method === 'eth_getCode') return '0x6080';
  if (method === 'eth_call') {
    const data = (params[0] as { data: string }).data;
    if (data === '0x313ce567') return '0x' + (6).toString(16).padStart(64, '0');
    if (data.startsWith('0x70a08231')) return answers.token ?? '0x0';
    return '0x';
  }
  return '0x';
}) as never;

describe('EvmBridgeWallet', () => {
  const make = (f = fakeEvm(), answers: Record<string, string> = {}) => ({ f, w: new EvmBridgeWallet('io.metamask', 'MetaMask', f.adapter, { read: readFor(answers), events: f.events, now: () => 7 }) });

  it('maps wallet chain ids to Swings chains, and says "unsupported" for a network Swings does not know', () => {
    expect(chainForEvmId(1)).toBe('ethereum');
    expect(chainForEvmId(8453)).toBe('base');
    expect(chainForEvmId(42161)).toBe('arbitrum');
    expect(chainForEvmId(250)).toBeNull();
    expect(chainForEvmId(null)).toBeNull();
  });

  it('connects, and the session carries the provider, account, chain, network and honest capabilities', async () => {
    const { w } = make(fakeEvm({ chainId: 8453 }));
    expect(w.isConnected()).toBe(false);
    const s = await w.connect();
    expect(s).toMatchObject({ providerId: 'io.metamask', providerName: 'MetaMask', chainType: 'evm', address: EVM_USER, chain: 'base', networkId: 8453, state: 'connected', connectedAt: 7 });
    expect(s.capabilities).toEqual({ signMessage: true, signWithoutSending: false, switchNetwork: true, multipleAccounts: true, emitsChanges: true });
    await expect(w.signTransaction()).rejects.toMatchObject({ code: 'not-enabled' });
  });

  it('a wallet on a network Swings does not support has no chain, and is never treated as being on one', async () => {
    const { w } = make(fakeEvm({ chainId: 250 }));
    const s = await w.connect();
    expect(s).toMatchObject({ chain: null, networkId: 250 });
  });

  it('notices an account change and a network change the moment the wallet announces them', async () => {
    const { f, w } = make();
    await w.connect();
    const seen: [SessionChange, string | null, number | null][] = [];
    w.onChange((c, s) => seen.push([c, s.address, s.networkId]));
    f.fire('accountsChanged', [EVM_OTHER]);
    f.fire('chainChanged', '0x2105');
    f.fire('chainChanged', '0x2105'); // no change: no event
    f.fire('accountsChanged', []);
    expect(seen).toEqual([['account-changed', EVM_OTHER, 1], ['network-changed', EVM_OTHER, 8453], ['disconnected', null, 8453]]);
    expect(w.isConnected()).toBe(false);
  });

  it('refresh() asks the wallet again and catches a change that happened without an event', async () => {
    const { f, w } = make();
    await w.connect();
    f.state.accounts = [EVM_OTHER];
    f.state.chainId = 56;
    const s = await w.refresh();
    expect(s).toMatchObject({ address: EVM_OTHER, chain: 'bnb' });
  });

  it('removes its listeners on disconnect', async () => {
    const { f, w } = make();
    await w.connect();
    expect([...f.handlers.values()].some((s) => s.size > 0)).toBe(true);
    await w.disconnect();
    expect([...f.handlers.values()].every((s) => s.size === 0)).toBe(true);
    expect(w.getSession().state).toBe('disconnected');
    await expect(w.getAddress()).rejects.toThrow(/No EVM wallet/);
  });

  it('reads balances on the asset\'s own chain through a node, not through the wallet', async () => {
    const { w } = make(fakeEvm(), { native: '0x' + (3n * 10n ** 18n).toString(16), token: '0x' + (1_500_000n).toString(16) });
    await w.connect();
    expect(await w.getBalance({ chain: 'ethereum', address: EVM_NATIVE_ADDRESS })).toMatchObject({ amount: 3n * 10n ** 18n, decimals: 18, readAt: 7 });
    expect(await w.getBalance({ chain: 'base', address: '0x' + 'b'.repeat(40) })).toMatchObject({ amount: 1_500_000n, decimals: 6 });
    await expect(w.getBalance({ chain: 'solana', address: SOLANA_NATIVE_ADDRESS })).rejects.toThrow(/only holds EVM/);
  });

  it('sends only if the wallet is still on the account and network the transaction was built for', async () => {
    const { f, w } = make();
    await w.connect();
    const tx = { kind: 'evm' as const, tx: { from: EVM_USER, to: ROUTER, data: '0x' }, chainId: 1 };
    expect(await w.sendTransaction(tx)).toMatch(/^0xab/);
    expect(f.state.sent).toHaveLength(1);
    f.state.accounts = [EVM_OTHER];
    await expect(w.sendTransaction(tx)).rejects.toThrow(/account changed/);
    f.state.accounts = [EVM_USER];
    f.state.chainId = 8453;
    await expect(w.sendTransaction(tx)).rejects.toThrow(/different network/);
    expect(f.state.sent).toHaveLength(1); // nothing went out for either refusal
  });

  it('submits a raw signed transaction and checks the hash it gets back; refuses a Solana transaction', async () => {
    const { f, w } = make();
    await w.connect();
    expect(await w.sendTransaction({ kind: 'evm', raw: '0xf86c' })).toMatch(/^0xcd/);
    expect(f.state.raw[0]).toEqual(['eth_sendRawTransaction', ['0xf86c']]);
    await expect(w.sendTransaction({ kind: 'solana', transaction: transferTx(USER) })).rejects.toThrow(/only send EVM/);
  });

  it('switches network only to a real EVM network, and confirms the wallet really moved', async () => {
    const { f, w } = make();
    await w.connect();
    await w.switchNetwork('base');
    expect(f.state.switched).toEqual([8453]);
    expect(w.getSession().chain).toBe('base');
    await expect(w.switchNetwork('solana')).rejects.toThrow(/not an EVM/);
  });

  it('signs a message as hex through the connected account', async () => {
    const { w } = make();
    await w.connect();
    expect(await w.signMessage(Uint8Array.from([0xde, 0xad]))).toBe(`signed:0xdead:${EVM_USER}`);
  });

  it('a wallet that shares no account fails the connection and leaves the session disconnected', async () => {
    const f = fakeEvm({ accounts: [] });
    const w = new EvmBridgeWallet('x', 'X', f.adapter, { read: readFor({}) });
    await expect(w.connect()).rejects.toThrow(/no account/);
    expect(w.getSession().state).toBe('disconnected');
  });
});

// ------------------------------------------------------------------ safety

const session = (over: Partial<WalletSession> = {}): WalletSession => ({ providerId: 'p', providerName: 'P', chainType: 'evm', address: EVM_USER, accounts: [EVM_USER], chain: 'base', networkId: 8453, state: 'connected', capabilities: { signMessage: true, signWithoutSending: false, switchNetwork: true, multipleAccounts: true, emitsChanges: true }, connectedAt: 1, revision: 4, ...over });

describe('sessionProblems', () => {
  const expectBase = { address: EVM_USER, chain: 'base' as const };
  it('accepts a wallet that matches, whatever the address case on EVM', () => {
    expect(sessionProblems(session(), expectBase)).toEqual([]);
    expect(sessionProblems(session({ address: EVM_USER.toUpperCase().replace('0X', '0x') }), expectBase)).toEqual([]);
  });
  it('refuses a disconnected wallet, another account, another network, an unknown network, the wrong kind of wallet, and a stale revision', () => {
    expect(sessionProblems(session({ state: 'disconnected', address: null }), expectBase)).toEqual(['The wallet is not connected.']);
    expect(sessionProblems(session({ address: EVM_OTHER }), expectBase).join(' ')).toMatch(/not the one this quote/);
    expect(sessionProblems(session({ networkId: 1, chain: 'ethereum' }), expectBase).join(' ')).toMatch(/different network/);
    expect(sessionProblems(session({ networkId: null, chain: null }), expectBase).join(' ')).toMatch(/did not report/);
    expect(sessionProblems(session({ chainType: 'solana', chain: 'solana', networkId: null, address: USER }), { address: USER, chain: 'base' }).join(' ')).toMatch(/solana wallet/);
    expect(sessionProblems(session({ revision: 5 }), { ...expectBase, revision: 4 }).join(' ')).toMatch(/changed after this quote/);
    expect(sessionProblems(session({ revision: 4 }), { ...expectBase, revision: 4 })).toEqual([]);
  });
});

describe('transactionProblems', () => {
  const evmTx = (over: Partial<{ from: string; to: string; chainId: number }> = {}) => ({ kind: 'evm' as const, tx: { from: over.from ?? EVM_USER, to: over.to ?? ROUTER }, chainId: over.chainId ?? 8453 });
  const expectBase = { address: EVM_USER, chain: 'base' as const, allowedDestinations: [ROUTER] };
  it('accepts the right transaction, and refuses another network, another sender and an unknown destination', () => {
    expect(transactionProblems(evmTx(), session(), expectBase)).toEqual([]);
    expect(transactionProblems(evmTx({ chainId: 1 }), session(), expectBase).join(' ')).toMatch(/different network/);
    expect(transactionProblems(evmTx({ from: EVM_OTHER }), session(), expectBase).join(' ')).toMatch(/different account/);
    expect(transactionProblems(evmTx({ to: '0x' + '9'.repeat(40) }), session(), expectBase).join(' ')).toMatch(/does not recognise/);
    expect(transactionProblems(evmTx(), session(), { ...expectBase, chain: 'solana' }).join(' ')).toMatch(/not on an EVM/);
  });
  it('checks a Solana transaction\'s fee payer and the programs it calls', () => {
    const s = session({ chainType: 'solana', chain: 'solana', networkId: null, address: USER });
    const tx = { kind: 'solana' as const, transaction: transferTx(USER) };
    expect(transactionProblems(tx, s, { address: USER, chain: 'solana', allowedDestinations: ['11111111111111111111111111111111'] })).toEqual([]);
    expect(transactionProblems(tx, s, { address: USER, chain: 'solana', allowedDestinations: ['SomeOtherProgram'] }).join(' ')).toMatch(/does not recognise/);
    expect(transactionProblems({ kind: 'solana', transaction: transferTx(OTHER) }, s, { address: USER, chain: 'solana' }).join(' ')).toMatch(/different account/);
    expect(transactionProblems(tx, s, { address: USER, chain: 'base' }).join(' ')).toMatch(/not on Solana/);
  });
});

describe('verifyBeforeExecute and ensureNetwork', () => {
  it('asks the wallet afresh before trusting it, so a switch made inside the wallet is caught', async () => {
    const f = fakeEvm({ chainId: 8453 });
    const w = new EvmBridgeWallet('p', 'P', f.adapter, { read: readFor({}) });
    await w.connect();
    expect(await verifyBeforeExecute(w, { address: EVM_USER, chain: 'base' })).toEqual([]);
    f.state.accounts = [EVM_OTHER]; // the user switched account in the wallet, no event delivered
    expect((await verifyBeforeExecute(w, { address: EVM_USER, chain: 'base' })).join(' ')).toMatch(/not the one this quote/);
  });

  it('never switches network without a yes, and does not even ask when the wallet is already there', async () => {
    const f = fakeEvm({ chainId: 1 });
    const w = new EvmBridgeWallet('p', 'P', f.adapter, { read: readFor({}) });
    await w.connect();
    const confirm = vi.fn(async () => false);
    await expect(ensureNetwork(w, 'base', confirm)).rejects.toMatchObject({ code: 'rejected' });
    expect(confirm).toHaveBeenCalledWith({ from: 'ethereum', to: 'base' });
    expect(f.state.switched).toEqual([]);
    const yes = vi.fn(async () => true);
    expect((await ensureNetwork(w, 'base', yes)).chain).toBe('base');
    expect(f.state.switched).toEqual([8453]);
    yes.mockClear();
    await ensureNetwork(w, 'base', yes);
    expect(yes).not.toHaveBeenCalled();
  });

  it('refuses to switch a Solana wallet to an EVM network, and a wallet that cannot switch, and verifies a switch that did not happen', async () => {
    const sol = new SolanaContextWallet(fakeHost(), { rpc: (async () => undefined) as unknown as SolRpc });
    await expect(ensureNetwork(sol, 'base', async () => true)).rejects.toThrow(/solana wallet/);
    const f = fakeEvm({ chainId: 1 });
    const stuck = new EvmBridgeWallet('p', 'P', { ...f.adapter, switchChain: async () => undefined }, { read: readFor({}) });
    await stuck.connect();
    await expect(ensureNetwork(stuck, 'base', async () => true)).rejects.toThrow(/did not switch/);
    await expect(ensureNetwork(new EvmBridgeWallet('p', 'P', f.adapter, { read: readFor({}) }), 'base', async () => true)).rejects.toThrow(/Connect a wallet/);
  });
});

// ------------------------------------------------------------------ providers

describe('listWalletProviders', () => {
  const wallet = (uuid: string, name: string, rdns: string) => ({ info: { uuid, name, rdns, icon: null }, provider: { request: async () => null } });
  it('lists what is really there, marks the rest unavailable with a reason, and never pretends WalletConnect works', () => {
    const list = listWalletProviders({ aretiaSolanaHost: true, evmWallets: [wallet('1', 'MetaMask', 'io.metamask'), wallet('2', 'Rabby', 'io.rabby')] });
    expect(list.map((p) => [p.id, p.available])).toEqual([['aretia-solana', true], ['io.metamask', true], ['io.rabby', true], ['walletconnect', false]]);
    expect(list.find((p) => p.id === 'walletconnect')!.note).toMatch(/not switched on.*no WalletConnect project id/);
    expect(list[0]!.note).toMatch(/Phantom, Solflare, Backpack/);
  });
  it('says so when there is no Solana host or no EVM wallet, and labels an unidentified injected wallet', () => {
    const none = listWalletProviders({ aretiaSolanaHost: false, evmWallets: [] });
    expect(none.find((p) => p.id === 'aretia-solana')).toMatchObject({ available: false });
    expect(none.find((p) => p.id === 'evm-none')).toMatchObject({ available: false });
    const injected = listWalletProviders({ aretiaSolanaHost: true, evmWallets: [wallet('legacy-injected', 'Browser wallet', 'injected')] });
    expect(injected.find((p) => p.kind === 'injected')!.note).toMatch(/Check which wallet/);
  });
});
