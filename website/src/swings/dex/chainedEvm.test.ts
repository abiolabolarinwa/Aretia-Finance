import { describe, expect, it, vi } from 'vitest';
import { EvmChainAdapter, type EvmSwapPayload } from '../chains/evm.js';
import type { EvmWalletAdapter } from '../chains/evmWallet.js';
import { EVM_NATIVE_ADDRESS, SwingsError, type DexProvider, type PreparedSwap, type Quote, type SwapRequest } from '../core/types.js';
import { selector } from '../engine/abi.js';
import { AretiaDexRegistry } from '../engine/registry.js';
import { ChainedEvmProvider } from './chainedEvm.js';
import { AretiaRouter } from '../router/router.js';
import { liveFeeConfig } from '../core/fee.js';
import { EVM_LAUNCHPADS } from './entries.js';

const virtuals = EVM_LAUNCHPADS.find((e) => e.id === 'virtuals-base')!;
const VIRTUAL = virtuals.quoteAsset!;
const TOKEN = '0x243c68d4bc16a7265031cbf07ead79ba1a9d629c';
const USER = '0x' + '1'.repeat(40);
const PAIR = '0x9999999999999999999999999999999999999999';
const word = (v: bigint | string): string => (typeof v === 'bigint' ? v.toString(16) : v.replace(/^0x/, '')).padStart(64, '0');
const join = (...ws: string[]): string => '0x' + ws.join('');

/** A node that behaves like Virtuals' contracts for one agent token still on its curve, and holds a controllable VIRTUAL balance. */
function node(o: { open?: boolean; balance?: () => bigint } = {}) {
  return vi.fn(async (_m: string, params: unknown[]) => {
    const { data } = params[0] as { to: string; data: string };
    const is = (sig: string): boolean => data.startsWith('0x' + selector(sig));
    if (is('balanceOf(address)')) return join(word((o.balance ?? (() => 0n))()));
    if (is('tokenInfo(address)')) {
      const w = Array.from({ length: 20 }, () => word(0n));
      const open = o.open ?? true;
      w[11] = word(open ? 1n : 0n);
      w[16] = word(open ? 1n : 0n);
      return join(...w);
    }
    if (is('getPair(address,address)')) return join(word(PAIR));
    if (is('hasAntiSniperTax(address)')) return join(word(0n));
    if (is('buyTax()') || is('sellTax()')) return join(word(1n));
    if (is('getAmountsOut(address,address,uint256)')) return join(word(1000n));
    throw new Error('revert');
  });
}

const reqOf = (over: Partial<SwapRequest> = {}): SwapRequest => ({ chain: 'base', from: { chain: 'base', address: EVM_NATIVE_ADDRESS }, to: { chain: 'base', address: TOKEN }, amountIn: 1_000_000n, slippageBps: 100, account: { chain: 'base', address: USER }, ...over });

const quoteOf = (r: SwapRequest, over: Partial<Quote> = {}): Quote => ({
  id: `q:${r.from.address.slice(0, 6)}:${r.to.address.slice(0, 6)}`,
  providerId: 'aretia',
  request: r,
  inAmount: r.amountIn,
  expectedOut: r.amountIn * 2n,
  minOut: r.amountIn * 2n - 10n,
  priceImpactBps: 5,
  route: { legs: [{ venue: 'leg', from: r.from, to: r.to, shareBps: 10_000 }] },
  costs: { network: null, provider: null, aretiaFee: { amount: 0n, asset: null } },
  fetchedAt: 1_000,
  expiresAt: 100_000,
  raw: { reasons: ['because'] },
  ...over,
});

function setup(o: { balance?: () => bigint; open?: boolean; secondMinFloor?: bigint; secondSimulationOk?: boolean } = {}) {
  const feeAsset = { chain: 'base' as const, address: EVM_NATIVE_ADDRESS };
  const first: DexProvider = {
    id: 'aretia',
    name: 'first',
    carriesAretiaFee: true,
    supports: () => true,
    getQuote: async (r) => quoteOf(r, { inAmount: r.amountIn - 29n, expectedOut: 5_000_000n, minOut: (5_000_000n * BigInt(10_000 - r.slippageBps)) / 10_000n, costs: { network: null, provider: null, aretiaFee: { amount: 29n, asset: feeAsset } } }),
    buildTransaction: async (q): Promise<PreparedSwap> => ({ quoteId: q.id, chain: 'base', preparedAt: 1, simulation: { ok: true, blockers: [], warnings: ['first warning'] }, payload: { chainId: 8453, taker: USER, approval: null, swap: { from: USER, to: '0xaaa', data: '0xfirst', value: '0x1' } } satisfies EvmSwapPayload }),
  };
  const secondQuotes: bigint[] = [];
  const second: DexProvider = {
    id: 'aretia',
    name: 'second',
    supports: () => true,
    getQuote: async (r) => {
      secondQuotes.push(r.amountIn);
      const expected = r.amountIn / 2n;
      return quoteOf(r, { inAmount: r.amountIn, expectedOut: expected, minOut: o.secondMinFloor !== undefined ? o.secondMinFloor : (expected * BigInt(10_000 - r.slippageBps)) / 10_000n });
    },
    buildTransaction: async (q): Promise<PreparedSwap> => ({ quoteId: q.id, chain: 'base', preparedAt: 1, simulation: { ok: o.secondSimulationOk ?? true, blockers: o.secondSimulationOk === false ? ['the second step would be refused'] : [], warnings: [] }, payload: { chainId: 8453, taker: USER, approval: null, swap: { from: USER, to: '0xbbb', data: '0xsecond', value: '0x0' } } satisfies EvmSwapPayload }),
  };
  const registry = new AretiaDexRegistry([virtuals]);
  const read = node({ open: o.open, balance: o.balance });
  const p = new ChainedEvmProvider({ first, second, registry, read: () => read as never, now: () => 2_000 });
  return { p, first, second, secondQuotes, read };
}

describe('the two-step router', () => {
  it('quotes a launchpad token against the native coin as one quote made of two steps, with the fee taken once on the first', async () => {
    const { p } = setup();
    const q = await p.getQuote(reqOf());
    expect(q.providerId).toBe('aretia-chain');
    expect(q.request.amountIn).toBe(1_000_000n);
    expect(q.inAmount).toBe(1_000_000n - 29n);
    expect(q.expectedOut).toBe(2_500_000n); // the second step priced on what the first is expected to deliver
    // and on the least it will deliver, each step with half of the 1% the user chose
    const firstMin = (5_000_000n * 9_950n) / 10_000n;
    expect(q.minOut).toBe(((firstMin / 2n) * 9_950n) / 10_000n);
    expect(q.minOut).toBeGreaterThanOrEqual((q.expectedOut * 9_900n) / 10_000n);
    expect(q.costs.aretiaFee.amount).toBe(29n);
    expect(q.route.legs).toHaveLength(2);
    expect(q.expiresAt).toBeLessThanOrEqual(q.fetchedAt + 12_000);
    expect((q.raw as { reasons: string[] }).reasons.join(' ')).toMatch(/Two steps/);
    expect(p.carriesAretiaFee).toBe(true);
  });

  it('is offered only when a launchpad has the token on its curve, and only for tokens that are not the middle token itself', async () => {
    await expect(setup({ open: false }).p.getQuote(reqOf())).rejects.toMatchObject({ code: 'no-route' });
    await expect(setup().p.getQuote(reqOf({ to: { chain: 'base', address: VIRTUAL } }))).rejects.toMatchObject({ code: 'no-route' });
    await expect(setup().p.getQuote(reqOf({ from: { chain: 'base', address: VIRTUAL } }))).rejects.toMatchObject({ code: 'no-route' });
    await expect(setup().p.getQuote(reqOf({ amountIn: 0n }))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('reports why when a step cannot be priced', async () => {
    const { p, first } = setup();
    first.getQuote = async () => {
      throw new SwingsError('no-route', 'No pool pays VIRTUAL for this coin.');
    };
    await expect(p.getQuote(reqOf())).rejects.toThrow(/No pool pays VIRTUAL/);
  });

  it('supports only chains that have a launchpad priced in a token', () => {
    const { p } = setup();
    expect(p.supports('base')).toBe(true);
    expect(p.supports('solana')).toBe(false);
    expect(p.supports('ethereum')).toBe(false);
  });

  describe('building', () => {
    it('builds the first step now, explains the two steps, and attaches the second', async () => {
      const { p } = setup();
      const q = await p.getQuote(reqOf());
      const prepared = await p.buildTransaction(q);
      expect(prepared.simulation.ok).toBe(true);
      expect(prepared.simulation.warnings.join(' ')).toMatch(/two steps/);
      expect(prepared.simulation.warnings.join(' ')).toMatch(/keep the middle token/);
      expect(prepared.simulation.warnings).toContain('first warning');
      const payload = prepared.payload as EvmSwapPayload;
      expect(payload.swap.data).toBe('0xfirst');
      expect(typeof payload.nextStep).toBe('function');
      // The payload is a plain object that is never "awaited into" anything by accident.
      expect(Object.prototype.hasOwnProperty.call(payload, 'then')).toBe(false);
    });

    it('builds the second step from what the first actually delivered, with no second fee', async () => {
      let held = 7n;
      const { p, secondQuotes } = setup({ balance: () => held });
      const q = await p.getQuote(reqOf());
      const payload = (await p.buildTransaction(q)).payload as EvmSwapPayload;
      held = 7n + 5_000_000n; // the first step delivered 5,000,000 on top of the 7 already held
      secondQuotes.length = 0;
      const next = await payload.nextStep!();
      expect(secondQuotes).toEqual([5_000_000n]);
      expect(next.swap.data).toBe('0xsecond');
      expect(next.fee ?? null).toBeNull();
    });

    it('never uses more than a little above what the first step was expected to deliver, even if the balance jumped', async () => {
      let held = 0n;
      const { p, secondQuotes } = setup({ balance: () => held });
      const q = await p.getQuote(reqOf());
      const payload = (await p.buildTransaction(q)).payload as EvmSwapPayload;
      held = 10n ** 12n;
      secondQuotes.length = 0;
      await payload.nextStep!();
      expect(secondQuotes).toEqual([(5_000_000n * 105n) / 100n]);
    });

    it('refuses the second step when nothing arrived, when the price moved past the minimum shown, or when its checks fail', async () => {
      let held = 0n;
      const none = setup({ balance: () => held });
      const payload = (await none.p.buildTransaction(await none.p.getQuote(reqOf()))).payload as EvmSwapPayload;
      await expect(payload.nextStep!()).rejects.toThrow(/Nothing arrived/);

      held = 0n;
      const moved = setup({ balance: () => held, secondMinFloor: 1n });
      const q = await moved.p.getQuote(reqOf());
      const movedPayload = (await moved.p.buildTransaction({ ...q, minOut: 10_000_000n })).payload as EvmSwapPayload;
      held = 5_000_000n;
      await expect(movedPayload.nextStep!()).rejects.toThrow(/price moved against you/);

      held = 0n;
      const bad = setup({ balance: () => held, secondSimulationOk: false });
      const badPayload = (await bad.p.buildTransaction(await bad.p.getQuote(reqOf()))).payload as EvmSwapPayload;
      held = 5_000_000n;
      await expect(badPayload.nextStep!()).rejects.toThrow(/second step would be refused/);
    });

    it('refuses an expired quote and a quote from another provider', async () => {
      const { p } = setup();
      const q = await p.getQuote(reqOf());
      await expect(p.buildTransaction({ ...q, expiresAt: 1 })).rejects.toMatchObject({ code: 'expired' });
      await expect(p.buildTransaction({ ...q, providerId: 'aretia' })).rejects.toMatchObject({ code: 'invalid' });
    });
  });
});

describe('running the two steps', () => {
  const HASH1 = '0x' + '11'.repeat(32);
  const HASH2 = '0x' + '22'.repeat(32);
  const wallet = (receipts: Record<string, '0x1' | '0x0' | null>) => {
    const sent: string[] = [];
    const hashes = [HASH1, HASH2];
    const w = {
      sends: sent,
      connect: async () => [USER],
      disconnect: async () => {},
      getAccounts: async () => [USER],
      getChainId: async () => 8453,
      switchChain: vi.fn(async () => {}),
      signTransaction: async () => '0x',
      sendTransaction: async (tx: { data?: string }) => {
        sent.push(tx.data ?? 'value');
        return hashes[sent.length - 1] ?? HASH2;
      },
      signMessage: async () => '0x',
      request: async (m: string, params: unknown[]) => (m === 'eth_getTransactionReceipt' ? (receipts[String(params[0])] === null ? null : { status: receipts[String(params[0])] ?? '0x1' }) : '0x'),
    };
    return w as unknown as EvmWalletAdapter & { sends: string[] };
  };
  const payload = (next?: () => Promise<EvmSwapPayload>): PreparedSwap => ({
    quoteId: 'q',
    chain: 'base',
    simulation: { ok: true, blockers: [], warnings: [] },
    preparedAt: 0,
    payload: { chainId: 8453, taker: USER, approval: null, swap: { from: USER, to: '0xaaa', data: '0xfirst', value: '0x0' }, ...(next ? { nextStep: next } : {}) } satisfies EvmSwapPayload,
  });
  const second: EvmSwapPayload = { chainId: 8453, taker: USER, approval: null, swap: { from: USER, to: '0xbbb', data: '0xsecond', value: '0x0' } };

  it('sends the first step, waits for it to be confirmed, builds and sends the second, and returns the second\'s hash', async () => {
    const w = wallet({});
    const next = vi.fn(async () => second);
    const hash = await new EvmChainAdapter('base', w, { pollMs: 1 }).signAndSubmit(payload(next));
    expect(w.sends).toEqual(['0xfirst', '0xsecond']);
    expect(next).toHaveBeenCalledTimes(1);
    expect(hash).toBe(HASH2);
  });

  it('does not ask for the second step when the first fails or stays pending', async () => {
    for (const receipts of [{ [HASH1]: '0x0' as const }, { [HASH1]: null }]) {
      const w = wallet(receipts);
      const next = vi.fn(async () => second);
      await expect(new EvmChainAdapter('base', w, { pollMs: 1, approvalTimeoutMs: 5 }).signAndSubmit(payload(next))).rejects.toMatchObject({ code: 'failed' });
      expect(next).not.toHaveBeenCalled();
      expect(w.sends).toEqual(['0xfirst']);
    }
  });

  it('tells the user they hold the middle token when the second step cannot be prepared', async () => {
    const w = wallet({});
    const err = new EvmChainAdapter('base', w, { pollMs: 1 }).signAndSubmit(payload(async () => {
      throw new SwingsError('failed', 'The price moved against you.');
    }));
    await expect(err).rejects.toThrow(/Step 1 of the route went through.*You now hold the middle token/);
    expect(w.sends).toEqual(['0xfirst']);
  });

  it('refuses a second step built for another account or network', async () => {
    const w = wallet({});
    await expect(new EvmChainAdapter('base', w, { pollMs: 1 }).signAndSubmit(payload(async () => ({ ...second, taker: '0x' + '4'.repeat(40) })))).rejects.toMatchObject({ code: 'invalid' });
    expect(w.sends).toEqual(['0xfirst']);
  });

  it('a single swap with no next step behaves as before', async () => {
    const w = wallet({});
    await new EvmChainAdapter('base', w, { pollMs: 1 }).signAndSubmit(payload());
    expect(w.sends).toEqual(['0xfirst']);
  });
});

describe('inside the router', () => {
  it('is offered as a route, kept while the fee is on because it collects the fee, and ranked by what it pays', async () => {
    const { p } = setup();
    const router = new AretiaRouter({ providers: [p], adapters: [], feeConfig: liveFeeConfig('0x' + '9'.repeat(40)), now: () => 2_000, isChainEnabled: () => true });
    const found = await router.findRoutes(reqOf());
    expect(found.rejected).toEqual([]);
    expect(found.routes.map((r) => r.providerId)).toEqual(['aretia-chain']);
    const summary = router.summarize(found.routes[0]!);
    expect(summary.aretiaFee.state).toBe('ready');
    expect(summary.canProceed).toBe(true);
  });
});
