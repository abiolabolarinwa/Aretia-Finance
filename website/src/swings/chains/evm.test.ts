import { describe, expect, it, vi } from 'vitest';
import { EvmChainAdapter, encodeApprove } from './evm.js';
import { Eip1193WalletAdapter, discoverWallets, type Eip1193Provider, type EvmWalletAdapter } from './evmWallet.js';
import { Evm0xProvider, parseZeroXQuote } from '../providers/evm0x.js';
import { MockDexProvider } from '../providers/mock.js';
import { AretiaRouter } from '../router/router.js';
import { EVM_NATIVE_ADDRESS, type PreparedSwap, type SwapRequest } from '../core/types.js';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USER = '0x1111111111111111111111111111111111111111';
const ROUTER = '0x2222222222222222222222222222222222222222';
const SPENDER = '0x3333333333333333333333333333333333333333';
const HASH = '0x' + 'ab'.repeat(32);

const request: SwapRequest = {
  chain: 'ethereum',
  from: { chain: 'ethereum', address: USDC },
  to: { chain: 'ethereum', address: WETH },
  amountIn: 1_000_000n,
  slippageBps: 100,
  account: { chain: 'ethereum', address: USER },
};

const zeroXResponse = (over: Record<string, unknown> = {}) => ({
  buyAmount: '500000000000000',
  minBuyAmount: '495000000000000',
  liquidityAvailable: true,
  totalNetworkFee: '2100000000000000',
  route: { fills: [{ source: 'Uniswap_V3', from: USDC, to: WETH, proportionBps: '10000' }] },
  issues: { allowance: null, balance: null },
  transaction: { to: ROUTER, data: '0xdeadbeef', value: '0', gas: '210000', gasPrice: '1' },
  ...over,
});

const trusted = { ethereum: { swapTargets: [ROUTER], spenders: [SPENDER] } };
const make = (json: unknown, rpc = vi.fn(async () => '0x'), t: typeof trusted | Record<string, never> = trusted) =>
  new Evm0xProvider({ quote: async () => json, rpc, trusted: t, now: () => 1000 });

describe('0x response parsing', () => {
  it('accepts a well-formed answer', () => {
    expect(parseZeroXQuote(zeroXResponse()).tx.to).toBe(ROUTER);
  });
  it('rejects malformed or hostile answers', () => {
    expect(() => parseZeroXQuote(null)).toThrow();
    expect(() => parseZeroXQuote(zeroXResponse({ buyAmount: '-5' }))).toThrow();
    expect(() => parseZeroXQuote(zeroXResponse({ transaction: { to: 'nope', data: '0x', value: '0' } }))).toThrow();
    expect(() => parseZeroXQuote(zeroXResponse({ liquidityAvailable: false }))).toThrow(/liquidity/);
  });
});

describe('Evm0xProvider', () => {
  it('maps a quote to the neutral shape with network cost in the native coin', async () => {
    const q = await make(zeroXResponse()).getQuote(request);
    expect(q).toMatchObject({ providerId: '0x', expectedOut: 500000000000000n, minOut: 495000000000000n, priceImpactBps: null });
    expect(q.costs.network).toEqual({ amount: 2100000000000000n, asset: { chain: 'ethereum', address: EVM_NATIVE_ADDRESS } });
    expect(q.route.legs[0]!.venue).toBe('Uniswap_V3');
  });

  it('refuses to build until trusted contract addresses are configured', async () => {
    const p = make(zeroXResponse(), undefined, {});
    await expect(p.buildTransaction(await p.getQuote(request))).rejects.toMatchObject({ code: 'config-missing' });
  });

  it('blocks a transaction aimed at an unrecognised contract', async () => {
    const p = make(zeroXResponse({ transaction: { to: '0x9999999999999999999999999999999999999999', data: '0x00', value: '0' } }));
    await expect(p.buildTransaction(await p.getQuote(request))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('blocks attached native value when not selling the native coin', async () => {
    const p = make(zeroXResponse({ transaction: { to: ROUTER, data: '0x00', value: '1' } }));
    await expect(p.buildTransaction(await p.getQuote(request))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('builds an exact-amount approval and rejects unknown spenders', async () => {
    const ok = make(zeroXResponse({ issues: { allowance: { actual: '0', spender: SPENDER }, balance: null } }));
    const prepared = await ok.buildTransaction(await ok.getQuote(request));
    const payload = prepared.payload as { approval: { tx: { data: string }; amount: bigint } };
    expect(payload.approval.amount).toBe(1_000_000n);
    expect(payload.approval.tx.data).toBe(encodeApprove(SPENDER, 1_000_000n));
    expect(prepared.simulation.warnings.join(' ')).toMatch(/approval/i);

    const bad = make(zeroXResponse({ issues: { allowance: { actual: '0', spender: '0x9999999999999999999999999999999999999999' }, balance: null } }));
    await expect(bad.buildTransaction(await bad.getQuote(request))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('turns a failing eth_call into a blocker, and a balance issue into a blocker', async () => {
    const failing = make(zeroXResponse(), vi.fn(async () => Promise.reject(new Error('execution reverted'))));
    const sim = (await failing.buildTransaction(await failing.getQuote(request))).simulation;
    expect(sim.ok).toBe(false);
    expect(sim.blockers[0]).toMatch(/reject/);

    const poor = make(zeroXResponse({ issues: { allowance: null, balance: { token: USDC, actual: '0', expected: '1000000' } } }));
    expect((await poor.buildTransaction(await poor.getQuote(request))).simulation.ok).toBe(false);
  });

  it('refuses Solana addresses and same-token requests', async () => {
    const p = make(zeroXResponse());
    await expect(p.getQuote({ ...request, to: request.from })).rejects.toMatchObject({ code: 'invalid' });
    await expect(p.getQuote({ ...request, from: { chain: 'ethereum', address: 'So11111111111111111111111111111111111111112' } })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('encodes approve calldata correctly and refuses unlimited-sized amounts', () => {
    expect(encodeApprove(SPENDER, 255n)).toBe('0x095ea7b3' + '0'.repeat(24) + '3'.repeat(40) + '0'.repeat(62) + 'ff');
    expect(() => encodeApprove(SPENDER, 1n << 256n)).toThrow();
    expect(() => encodeApprove('0x12', 1n)).toThrow();
  });
});

describe('EVM wallet discovery and adapter', () => {
  const fakeProvider = (handler: (m: string, p?: unknown[]) => unknown): Eip1193Provider => ({ request: async ({ method, params }) => handler(method, params) });

  it('collects EIP-6963 wallets, ignores malformed announcements and non-data icons', async () => {
    const listeners: Record<string, ((e: Event) => void)[]> = {};
    const a = fakeProvider(() => null);
    const host = {
      addEventListener: (t: string, f: (e: Event) => void) => void (listeners[t] ??= []).push(f),
      removeEventListener: () => {},
      dispatchEvent: () => {
        const send = (detail: unknown) => listeners['eip6963:announceProvider']?.forEach((f) => f({ detail } as unknown as Event));
        send({ info: { uuid: '1', name: 'Aretia', rdns: 'org.aretia', icon: 'https://evil.example/x.png' }, provider: a });
        send({ info: { uuid: '2', name: 'Broken' }, provider: a });
        send({ info: { uuid: '3', name: 'NoProvider', rdns: 'x' }, provider: {} });
        return true;
      },
    };
    const wallets = await discoverWallets(host as never, 1);
    expect(wallets).toHaveLength(1);
    expect(wallets[0]!.info).toMatchObject({ name: 'Aretia', icon: null });
  });

  it('does not assume window.ethereum is the only wallet, but offers it when nothing announced', async () => {
    const host = { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true, ethereum: fakeProvider(() => null) };
    const wallets = await discoverWallets(host as never, 1);
    expect(wallets.map((w) => w.info.uuid)).toEqual(['legacy-injected']);
  });

  it('maps user rejection and verifies a chain switch really happened', async () => {
    const rejecting = new Eip1193WalletAdapter(fakeProvider(() => Promise.reject({ code: 4001 })));
    await expect(rejecting.connect()).rejects.toMatchObject({ code: 'rejected' });
    await expect(rejecting.sendTransaction({ from: USER, to: ROUTER })).rejects.toMatchObject({ code: 'rejected' });

    const liar = new Eip1193WalletAdapter(fakeProvider((m) => (m === 'eth_chainId' ? '0x1' : null)));
    await expect(liar.switchChain(8453)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('rejects a bad transaction hash from the wallet', async () => {
    const w = new Eip1193WalletAdapter(fakeProvider(() => 'not-a-hash'));
    await expect(w.sendTransaction({ from: USER, to: ROUTER })).rejects.toBeInstanceOf(Error);
  });
});

describe('EvmChainAdapter', () => {
  const sim = { ok: true, blockers: [], warnings: [] };
  const payload = (approval: boolean) => ({
    chainId: 1,
    taker: USER,
    approval: approval ? { tx: { from: USER, to: USDC, data: '0xapprove' }, token: USDC, spender: SPENDER, amount: 1n } : null,
    swap: { from: USER, to: ROUTER, data: '0xswap', value: '0x0' },
  });
  const prepared = (approval: boolean, quoteId = 'q'): PreparedSwap => ({ quoteId, chain: 'ethereum', payload: payload(approval), simulation: sim, preparedAt: 0 });

  const wallet = (over: Partial<EvmWalletAdapter> = {}): EvmWalletAdapter & { sends: unknown[] } => {
    const w = {
      sends: [] as unknown[],
      connect: async () => [USER],
      disconnect: async () => {},
      getAccounts: async () => [USER],
      getChainId: async () => 1,
      switchChain: vi.fn(async () => {}),
      signTransaction: async () => '0x',
      sendTransaction: async (tx: unknown) => {
        w.sends.push(tx);
        return HASH;
      },
      signMessage: async () => '0x',
      request: async (m: string) => (m === 'eth_getTransactionReceipt' ? { status: '0x1' } : '0x'),
      ...over,
    };
    return w;
  };

  it('sends the swap once, and approval first when needed', async () => {
    const w = wallet();
    const a = new EvmChainAdapter('ethereum', w, { pollMs: 1 });
    await a.signAndSubmit(prepared(true));
    expect(w.sends).toHaveLength(2);
    expect((w.sends[0] as { data: string }).data).toBe('0xapprove');
    await expect(a.signAndSubmit(prepared(true))).rejects.toMatchObject({ code: 'invalid' });
    expect(w.sends).toHaveLength(2);
  });

  it('does not send the swap if the approval fails or is still pending', async () => {
    const failed = wallet({ request: async () => ({ status: '0x0' }) });
    await expect(new EvmChainAdapter('ethereum', failed, { pollMs: 1 }).signAndSubmit(prepared(true))).rejects.toMatchObject({ code: 'failed' });
    expect(failed.sends).toHaveLength(1);

    const pending = wallet({ request: async () => null });
    await expect(new EvmChainAdapter('ethereum', pending, { pollMs: 1, approvalTimeoutMs: 5 }).signAndSubmit(prepared(true))).rejects.toMatchObject({ code: 'failed' });
    expect(pending.sends).toHaveLength(1);
  });

  it('refuses when the connected account changed or the chain does not match', async () => {
    const other = wallet({ getAccounts: async () => ['0x4444444444444444444444444444444444444444'] });
    await expect(new EvmChainAdapter('ethereum', other).signAndSubmit(prepared(false))).rejects.toMatchObject({ code: 'invalid' });
    expect(other.sends).toHaveLength(0);
    await expect(new EvmChainAdapter('base', wallet()).signAndSubmit(prepared(false))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('asks the wallet to switch network when it is on another chain', async () => {
    const w = wallet({ getChainId: async () => 56 });
    await new EvmChainAdapter('ethereum', w).signAndSubmit(prepared(false));
    expect(w.switchChain).toHaveBeenCalledWith(1);
  });

  it('allows retry after a declined swap signature but not after other failures', async () => {
    let n = 0;
    const w = wallet({
      sendTransaction: async () => {
        n++;
        if (n === 1) throw Object.assign(new Error('x'), { code: 4001 });
        return HASH;
      },
    });
    const adapterWithRejectingMapped = new EvmChainAdapter('ethereum', new Eip1193WalletAdapter({ request: async ({ method }) => { if (method === 'eth_sendTransaction') { n++; if (n === 1) throw { code: 4001 }; return HASH; } if (method === 'eth_chainId') return '0x1'; if (method === 'eth_accounts') return [USER]; return null; } }));
    await expect(adapterWithRejectingMapped.signAndSubmit(prepared(false))).rejects.toMatchObject({ code: 'rejected' });
    await expect(adapterWithRejectingMapped.signAndSubmit(prepared(false))).resolves.toBe(HASH);
    void w;
  });

  it('reads balances for native and ERC-20 and rejects garbage', async () => {
    const calls: string[] = [];
    const w = wallet({ request: async (m: string) => { calls.push(m); return m === 'eth_getBalance' ? '0x10' : '0x0000000000000000000000000000000000000000000000000000000000000020'; } });
    const a = new EvmChainAdapter('ethereum', w);
    expect(await a.getBalance(request.account, { chain: 'ethereum', address: EVM_NATIVE_ADDRESS })).toBe(16n);
    expect(await a.getBalance(request.account, request.from)).toBe(32n);
    const bad = new EvmChainAdapter('ethereum', wallet({ request: async () => 'zzz' }));
    await expect(bad.getBalance(request.account, request.from)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('reports receipt status', async () => {
    expect(await new EvmChainAdapter('ethereum', wallet({ request: async () => null })).getStatus(HASH)).toBe('submitted');
    expect(await new EvmChainAdapter('ethereum', wallet({ request: async () => ({ status: '0x0' }) })).getStatus(HASH)).toBe('failed');
  });

  it('rejects non-EVM chains', () => {
    expect(() => new EvmChainAdapter('solana', wallet())).toThrow();
  });
});

describe('router with EVM providers', () => {
  it('keeps EVM disabled and lets the mock provider compete when enabled for tests', async () => {
    const off = new AretiaRouter({ providers: [new MockDexProvider()], adapters: [] });
    await expect(off.findRoutes(request)).rejects.toMatchObject({ code: 'not-enabled' });

    const on = new AretiaRouter({ providers: [new MockDexProvider({ id: 'a', rateBps: 9_000 }), new MockDexProvider({ id: 'b', rateBps: 9_900 }), new MockDexProvider({ id: 'c', failWith: 'down' })], adapters: [], isChainEnabled: () => true });
    const res = await on.findRoutes(request);
    expect(res.routes.map((q) => q.providerId)).toEqual(['b', 'a']);
    expect(res.failures.map((f) => f.providerId)).toEqual(['c']);
  });
});
