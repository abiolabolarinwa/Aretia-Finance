import { describe, expect, it, vi } from 'vitest';
import { EvmChainAdapter, encodeApprove } from './evm.js';
import { Eip1193WalletAdapter, discoverWallets, type Eip1193Provider, type EvmWalletAdapter } from './evmWallet.js';
import { Evm0xProvider, parseZeroXQuote } from '../providers/evm0x.js';
import { MockDexProvider } from '../providers/mock.js';
import { AretiaRouter } from '../router/router.js';
import { EVM_NATIVE_ADDRESS, type PreparedSwap, type SwapRequest } from '../core/types.js';
import { TEST_SETTLER, zeroXSwapData } from '../providers/__fixtures__/zeroX.js';

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

/** AllowanceHolder.exec(Settler, token, amount, Settler, Settler.execute(...)) calldata, as 0x builds it, paying the user. */
const execData = (token: string, amount: bigint, over: { recipient?: string; buyToken?: string; minAmountOut?: bigint; operator?: string; target?: string } = {}): string =>
  zeroXSwapData({ token, amount, recipient: over.recipient ?? USER, buyToken: over.buyToken ?? WETH, minAmountOut: over.minAmountOut ?? 495000000000000n, ...(over.operator ? { operator: over.operator } : {}), ...(over.target ? { target: over.target } : {}) });

const zeroXResponse = (over: Record<string, unknown> = {}) => ({
  buyAmount: '500000000000000',
  minBuyAmount: '495000000000000',
  liquidityAvailable: true,
  totalNetworkFee: '2100000000000000',
  route: { fills: [{ source: 'Uniswap_V3', from: USDC, to: WETH, proportionBps: '10000' }] },
  issues: { allowance: null, balance: null },
  transaction: { to: ROUTER, data: execData(USDC, 1_000_000n), value: '0', gas: '210000', gasPrice: '1' },
  ...over,
});

const trusted = { ethereum: { swapTargets: [ROUTER], spenders: [SPENDER], settlers: [TEST_SETTLER] } };
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
    const p = make(zeroXResponse({ transaction: { to: '0x9999999999999999999999999999999999999999', data: execData(USDC, 1_000_000n), value: '0' } }));
    await expect(p.buildTransaction(await p.getQuote(request))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('blocks attached native value when not selling the native coin', async () => {
    const p = make(zeroXResponse({ transaction: { to: ROUTER, data: execData(USDC, 1_000_000n), value: '1' } }));
    await expect(p.buildTransaction(await p.getQuote(request))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('blocks a swap whose exec call would pull another token, or more than entered, from the wallet', async () => {
    // A standing allowance the wallet once gave AllowanceHolder for another token must never be spendable by a quote.
    const other = make(zeroXResponse({ transaction: { to: ROUTER, data: execData(WETH, 1_000_000n), value: '0' } }));
    await expect(other.getQuote(request)).rejects.toThrow(/different token/);
    const more = make(zeroXResponse({ transaction: { to: ROUTER, data: execData(USDC, 1_000_001n), value: '0' } }));
    await expect(more.getQuote(request)).rejects.toThrow(/more from your wallet/);
    const notExec = make(zeroXResponse({ transaction: { to: ROUTER, data: '0xdeadbeef', value: '0' } }));
    await expect(notExec.getQuote(request)).rejects.toThrow(/kind of call/);
  });

  describe('H-1: the AllowanceHolder exec and the Settler call inside it', () => {
    const ATTACKER = '0xbadbadbadbadbadbadbadbadbadbadbadbadbad0';
    const w = (h: string) => h.replace(/^0x/, '').padStart(64, '0');
    // The audit's proof of concept: exec(operator = attacker, USDC, amount, target = attacker, <empty>).
    const pocExec = (token: string, amount: bigint) => '0x2213bc0b' + w(ATTACKER) + w(token) + w(amount.toString(16)) + w(ATTACKER) + w('a0') + w('0');

    it('refuses the proof-of-concept exec that hands the allowance to an attacker contract', async () => {
      const p = make(zeroXResponse({ issues: { allowance: { actual: '0', spender: SPENDER }, balance: null }, transaction: { to: ROUTER, data: pocExec(USDC, 1_000_000n), value: '0' } }));
      await expect(p.getQuote(request)).rejects.toMatchObject({ code: 'invalid' });
    });

    it('refuses a native sale whose value would go to an attacker target', async () => {
      const native: SwapRequest = { ...request, from: { chain: 'ethereum', address: EVM_NATIVE_ADDRESS }, to: { chain: 'ethereum', address: USDC } };
      const p = make(zeroXResponse({ transaction: { to: ROUTER, data: pocExec(EVM_NATIVE_ADDRESS, 0n), value: '1000000' } }));
      await expect(p.getQuote(native)).rejects.toMatchObject({ code: 'invalid' });
    });

    it('refuses an operator that differs from the target, a different recipient, or a different buy token', async () => {
      const split = make(zeroXResponse({ transaction: { to: ROUTER, data: execData(USDC, 1_000_000n, { operator: ATTACKER }), value: '0' } }));
      await expect(split.getQuote(request)).rejects.toThrow(/different contract spend/);
      const payee = make(zeroXResponse({ transaction: { to: ROUTER, data: execData(USDC, 1_000_000n, { recipient: ATTACKER }), value: '0' } }));
      await expect(payee.getQuote(request)).rejects.toThrow(/different wallet/);
      const token = make(zeroXResponse({ transaction: { to: ROUTER, data: execData(USDC, 1_000_000n, { buyToken: ATTACKER }), value: '0' } }));
      await expect(token.getQuote(request)).rejects.toThrow(/different token than the one you are buying/);
    });

    it('blocks a well-formed exec whose operator and target are not a genuine Settler', async () => {
      const p = make(zeroXResponse({ transaction: { to: ROUTER, data: execData(USDC, 1_000_000n, { operator: ATTACKER, target: ATTACKER }), value: '0' } }));
      const prepared = await p.buildTransaction(await p.getQuote(request));
      expect(prepared.simulation.ok).toBe(false);
      expect(prepared.simulation.blockers.join(' ')).toMatch(/not a genuine 0x Settler/);
    });

    it('judges slippage on the minimum in the calldata, not the JSON field', async () => {
      // The JSON claims a fair minimum, the calldata accepts 1 wei: the answer is inconsistent and dropped.
      const lying = make(zeroXResponse({ transaction: { to: ROUTER, data: execData(USDC, 1_000_000n, { minAmountOut: 1n }), value: '0' } }));
      await expect(lying.getQuote(request)).rejects.toMatchObject({ code: 'provider-failed' });
      // Both say 1 wei: the router sees the calldata minimum and refuses the slippage.
      const loose = make(zeroXResponse({ minBuyAmount: '1', transaction: { to: ROUTER, data: execData(USDC, 1_000_000n, { minAmountOut: 1n }), value: '0' } }));
      const q = await loose.getQuote(request);
      expect(q.minOut).toBe(1n);
      const router = new AretiaRouter({ providers: [loose], adapters: [], isChainEnabled: () => true, now: () => 1000 });
      expect(router.executabilityProblems(q, request)).toContain('The quote accepts more slippage than you chose.');
      await expect(loose.buildTransaction(q)).rejects.toThrow(/less than the minimum/);
    });

    it('rejects malformed Settler calldata rather than guessing', async () => {
      const truncated = execData(USDC, 1_000_000n).slice(0, -64);
      const p = make(zeroXResponse({ transaction: { to: ROUTER, data: truncated, value: '0' } }));
      await expect(p.getQuote(request)).rejects.toMatchObject({ code: 'invalid' });
    });

    it('asks the 0x registry for the current (or previous) Settler, and blocks anything else or a paused feature', async () => {
      const reg = (answer: (data: string) => unknown) =>
        vi.fn(async (_c: unknown, method: string, params: unknown[]) => {
          const call = (params as { to?: string; data?: string }[])[0]!;
          if (method === 'eth_call' && call.to === '0x00000000000004533Fe15556B1E086BB1A72cEae') return answer(call.data!);
          return '0x';
        });
      const word = '0x' + w(TEST_SETTLER);
      const build = async (rpc: ReturnType<typeof reg>) => {
        const p = new Evm0xProvider({ quote: async () => zeroXResponse(), rpc: rpc as never, trusted: { ethereum: { ...trusted.ethereum, settlers: 'registry' } }, now: () => 1000 });
        return (await p.buildTransaction(await p.getQuote(request))).simulation;
      };
      expect((await build(reg((d) => (d.startsWith('0x6352211e') ? word : '0x' + w(ATTACKER))))).ok).toBe(true);
      expect((await build(reg((d) => (d.startsWith('0xe2603dc2') ? word : '0x' + w(ATTACKER))))).ok).toBe(true);
      expect((await build(reg(() => '0x' + w(ATTACKER)))).blockers.join(' ')).toMatch(/not a genuine 0x Settler/);
      expect((await build(reg(() => Promise.reject(new Error('execution reverted'))))).blockers.join(' ')).toMatch(/could not be confirmed/);
    });

    it('simulates the swap and blocks it when the wallet receives less than the minimum', async () => {
      const sim = (received: bigint) =>
        vi.fn(async (_c: unknown, method: string) =>
          method === 'eth_simulateV1' ? [{ calls: [{ status: '0x1', returnData: '0x' + w('64') }, { status: '0x1', returnData: '0x' }, { status: '0x1', returnData: '0x' + w((100n + received).toString(16)) }] }] : '0x',
        );
      const short = make(zeroXResponse(), sim(495000000000000n - 1n) as never);
      const blocked = (await short.buildTransaction(await short.getQuote(request))).simulation;
      expect(blocked.ok).toBe(false);
      expect(blocked.blockers.join(' ')).toMatch(/less than your minimum/);
      const fine = make(zeroXResponse(), sim(495000000000000n) as never);
      expect((await fine.buildTransaction(await fine.getQuote(request))).simulation.ok).toBe(true);
    });
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

  describe('a wallet that does not have the network yet', () => {
    /** A wallet that knows only Ethereum until it is asked to add a network. */
    function walletWithout(chainId: number, opts: { declineAdd?: boolean } = {}) {
      const calls: { method: string; params?: unknown[] }[] = [];
      let current = 1;
      const adapter = new Eip1193WalletAdapter({
        request: async ({ method, params }) => {
          calls.push({ method, params });
          if (method === 'wallet_switchEthereumChain') {
            if ((params as { chainId: string }[])[0]!.chainId === '0x' + chainId.toString(16) && !calls.some((c) => c.method === 'wallet_addEthereumChain')) throw { code: 4902 };
            current = chainId;
            return null;
          }
          if (method === 'wallet_addEthereumChain') {
            if (opts.declineAdd) throw { code: 4001 };
            current = chainId;
            return null;
          }
          if (method === 'eth_chainId') return '0x' + current.toString(16);
          return null;
        },
      });
      return { adapter, calls };
    }

    it('offers to add Polygon and BNB Chain from its own stored parameters, then confirms the switch', async () => {
      for (const id of [56, 137]) {
        const { adapter, calls } = walletWithout(id);
        await adapter.switchChain(id);
        const add = calls.find((c) => c.method === 'wallet_addEthereumChain');
        expect(add, String(id)).toBeDefined();
        expect((add!.params as { chainId: string; rpcUrls: string[]; blockExplorerUrls: string[] }[])[0]).toMatchObject({ chainId: '0x' + id.toString(16) });
        expect((add!.params as { rpcUrls: string[] }[])[0]!.rpcUrls.every((u) => u.startsWith('https://'))).toBe(true);
      }
    });

    it('does not add a network Aretia holds no parameters for, and respects a declined add', async () => {
      const { adapter, calls } = walletWithout(999);
      await expect(adapter.switchChain(999)).rejects.toMatchObject({ code: 'invalid' });
      expect(calls.some((c) => c.method === 'wallet_addEthereumChain')).toBe(false);
      const declined = walletWithout(56, { declineAdd: true });
      await expect(declined.adapter.switchChain(56)).rejects.toMatchObject({ code: 'rejected' });
    });
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
    let chain = 56;
    const w = wallet({ getChainId: async () => chain, switchChain: vi.fn(async (id: number) => void (chain = id)) });
    await new EvmChainAdapter('ethereum', w).signAndSubmit(prepared(false));
    expect(w.switchChain).toHaveBeenCalledWith(1);
  });

  it('L-1: binds every transaction to the chain, and stops when the wallet switches network or account mid-swap', async () => {
    const w = wallet();
    await new EvmChainAdapter('ethereum', w, { pollMs: 1 }).signAndSubmit(prepared(true));
    expect(w.sends).toHaveLength(2);
    for (const tx of w.sends) expect((tx as { chainId?: string }).chainId).toBe('0x1');

    // The approval is mined, then the wallet moves to BNB Chain: the swap is not sent there.
    let chain = 1;
    const moved = wallet({
      getChainId: async () => chain,
      sendTransaction: async (tx: unknown) => {
        moved.sends.push(tx);
        chain = 56;
        return HASH;
      },
    });
    await expect(new EvmChainAdapter('ethereum', moved, { pollMs: 1 }).signAndSubmit(prepared(true))).rejects.toThrow(/switched away/);
    expect(moved.sends).toHaveLength(1);

    let who = USER;
    const swapped = wallet({
      getAccounts: async () => [who],
      sendTransaction: async (tx: unknown) => {
        swapped.sends.push(tx);
        who = '0x4444444444444444444444444444444444444444';
        return HASH;
      },
    });
    await expect(new EvmChainAdapter('ethereum', swapped, { pollMs: 1 }).signAndSubmit(prepared(true))).rejects.toThrow(/account changed/);
    expect(swapped.sends).toHaveLength(1);
  });

  it('L-1: the EIP-1193 adapter refuses to send a transaction for a chain the wallet is not on', async () => {
    const sent: string[] = [];
    const w = new Eip1193WalletAdapter({ request: async ({ method }) => (method === 'eth_chainId' ? '0x38' : (sent.push(method), HASH)) });
    await expect(w.sendTransaction({ from: USER, to: ROUTER, chainId: '0x1' })).rejects.toThrow(/different network/);
    expect(sent).toEqual([]);
    await expect(w.sendTransaction({ from: USER, to: ROUTER, chainId: '0x38' })).resolves.toBe(HASH);
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

  it('never reads a node that cannot answer as a failed transaction', async () => {
    const refused = async () => { throw new Error('The BNB Chain network node answered 403.'); };
    // The public node refuses (as publicnode does for a receipt it has not seen yet): the wallet's own node is asked next.
    expect(await new EvmChainAdapter('ethereum', wallet({ request: async () => ({ status: '0x1' }) }), { read: refused }).getStatus(HASH)).toBe('confirmed');
    expect(await new EvmChainAdapter('ethereum', wallet({ request: async () => null }), { read: refused }).getStatus(HASH)).toBe('submitted');
    // Neither answers: not confirmed yet, never "failed", and no error to blow up the swap.
    expect(await new EvmChainAdapter('ethereum', wallet({ request: refused }), { read: refused }).getStatus(HASH)).toBe('submitted');
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
