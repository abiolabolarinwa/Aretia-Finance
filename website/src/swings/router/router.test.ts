import { describe, expect, it, vi } from 'vitest';
import { AretiaRouter, explainNoRoute } from './router.js';
import { SolanaJupiterProvider, type JupiterBackend, type JupiterQuote } from '../providers/solanaJupiter.js';
import { SolanaChainAdapter } from '../chains/solana.js';
import { SwingsError, type ChainAdapter, type DexProvider, type PreparedSwap, type Quote, type SwapRequest } from '../core/types.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const USER = '2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2';

const request: SwapRequest = {
  chain: 'solana',
  from: { chain: 'solana', address: USDC },
  to: { chain: 'solana', address: WSOL },
  amountIn: 1_000_000n,
  slippageBps: 100,
  account: { chain: 'solana', address: USER },
};

let clock = 1_000_000;
const now = () => clock;

function quoteFrom(providerId: string, out: bigint, over: Partial<Quote> = {}): Quote {
  return {
    id: `${providerId}-q`,
    providerId,
    request,
    inAmount: request.amountIn,
    expectedOut: out,
    minOut: (out * 99n) / 100n,
    priceImpactBps: 10,
    route: { legs: [{ venue: providerId, from: request.from, to: request.to, shareBps: 10_000 }] },
    costs: { network: null, provider: null, aretiaFee: { amount: 0n, asset: null } },
    fetchedAt: clock,
    expiresAt: clock + 20_000,
    raw: null,
    ...over,
  };
}

function fakeProvider(id: string, make: () => Promise<Quote>, sim = { ok: true, blockers: [] as string[], warnings: [] as string[] }): DexProvider {
  return {
    id,
    name: id,
    supports: (c) => c === 'solana',
    getQuote: make,
    buildTransaction: async (q): Promise<PreparedSwap> => ({ quoteId: q.id, chain: 'solana', payload: { id }, simulation: sim, preparedAt: clock }),
  };
}

function fakeAdapter(overrides: Partial<ChainAdapter> = {}): ChainAdapter & { sent: number } {
  const a = {
    chain: 'solana' as const,
    sent: 0,
    getBalance: async () => 0n,
    signAndSubmit: async () => {
      a.sent++;
      return 'sig1';
    },
    getStatus: async () => 'confirmed' as const,
    ...overrides,
  };
  return a;
}

const router = (providers: DexProvider[], adapter: ChainAdapter = fakeAdapter()) => new AretiaRouter({ providers, adapters: [adapter], now, providerTimeoutMs: 200 });

describe('route search', () => {
  it('ranks by expected output and keeps alternatives', async () => {
    const r = router([fakeProvider('a', async () => quoteFrom('a', 100n)), fakeProvider('b', async () => quoteFrom('b', 120n))]);
    const { routes } = await r.findRoutes(request);
    expect(routes.map((q) => q.providerId)).toEqual(['b', 'a']);
  });

  it('survives one provider failing and reports it', async () => {
    const r = router([fakeProvider('a', async () => quoteFrom('a', 100n)), fakeProvider('b', async () => Promise.reject(new Error('boom')))]);
    const res = await r.findRoutes(request);
    expect(res.routes.map((q) => q.providerId)).toEqual(['a']);
    expect(res.failures).toEqual([{ providerId: 'b', message: 'boom' }]);
  });

  it('times out a hung provider instead of waiting forever', async () => {
    const r = router([fakeProvider('a', async () => quoteFrom('a', 100n)), fakeProvider('slow', () => new Promise<Quote>(() => {}))]);
    const res = await r.findRoutes(request);
    expect(res.routes).toHaveLength(1);
    expect(res.failures[0]!.providerId).toBe('slow');
  });

  it('throws no-route with a clear message when every provider fails', async () => {
    const r = router([fakeProvider('a', async () => Promise.reject(new Error('down')))]);
    await expect(r.getQuote(request)).rejects.toMatchObject({ code: 'no-route' });
  });

  it('drops quotes that are not executable', async () => {
    const cases: [string, Partial<Quote>][] = [
      ['expired', { expiresAt: clock - 1 }],
      ['zero output', { expectedOut: 0n }],
      ['min above expected', { minOut: 500n }],
      ['wrong amount', { inAmount: 5n }],
      ['wrong tokens', { request: { ...request, to: { chain: 'solana', address: 'So11111111111111111111111111111111111111113' } } }],
      ['huge impact', { priceImpactBps: 5_000 }],
      ['loose slippage', { minOut: 10n }],
    ];
    for (const [name, patch] of cases) {
      const r = router([fakeProvider('a', async () => quoteFrom('a', 100n, patch))]);
      const res = await r.findRoutes(request);
      expect(res.routes, name).toHaveLength(0);
      expect(res.rejected[0]?.reasons.length, name).toBeGreaterThan(0);
    }
  });

  it('refuses chains that are not enabled', async () => {
    const r = new AretiaRouter({ providers: [], adapters: [], now });
    await expect(r.findRoutes({ ...request, chain: 'base' })).rejects.toMatchObject({ code: 'not-enabled' });
  });

  it('rejects absurd slippage', async () => {
    const r = router([fakeProvider('a', async () => quoteFrom('a', 100n))]);
    await expect(r.findRoutes({ ...request, slippageBps: 9_000 })).rejects.toBeInstanceOf(SwingsError);
  });
});

describe('execution', () => {
  const prepare = async (r: AretiaRouter) => {
    const q = await r.getQuote(request);
    return { q, p: await r.buildTransaction(q) };
  };

  it('needs a confirmation naming this quote', async () => {
    const adapter = fakeAdapter();
    const r = router([fakeProvider('a', async () => quoteFrom('a', 100n))], adapter);
    const { q, p } = await prepare(r);
    await expect(r.executeRoute(p, q, { quoteId: 'other', confirmed: true })).rejects.toMatchObject({ code: 'rejected' });
    expect(adapter.sent).toBe(0);
  });

  it('executes once and refuses a second send of the same quote', async () => {
    const adapter = fakeAdapter();
    const r = router([fakeProvider('a', async () => quoteFrom('a', 100n))], adapter);
    const { q, p } = await prepare(r);
    const ex = await r.executeRoute(p, q, { quoteId: q.id, confirmed: true });
    expect(ex).toMatchObject({ status: 'submitted', txId: 'sig1' });
    await expect(r.executeRoute(p, q, { quoteId: q.id, confirmed: true })).rejects.toMatchObject({ code: 'invalid' });
    expect(adapter.sent).toBe(1);
  });

  it('does not send a swap whose simulation failed', async () => {
    const adapter = fakeAdapter();
    const bad = { ok: false, blockers: ['The network would reject this swap.'], warnings: [] };
    const r = router([fakeProvider('a', async () => quoteFrom('a', 100n), bad)], adapter);
    const { q, p } = await prepare(r);
    await expect(r.executeRoute(p, q, { quoteId: q.id, confirmed: true })).rejects.toMatchObject({ code: 'simulation-failed' });
    expect(adapter.sent).toBe(0);
  });

  it('refuses an expired quote at signing time', async () => {
    const adapter = fakeAdapter();
    const r = router([fakeProvider('a', async () => quoteFrom('a', 100n))], adapter);
    const { q, p } = await prepare(r);
    clock += 60_000;
    await expect(r.executeRoute(p, q, { quoteId: q.id, confirmed: true })).rejects.toMatchObject({ code: 'expired' });
    clock -= 60_000;
  });

  it('allows a retry after a rejected signature but not after an ambiguous failure', async () => {
    let mode: 'reject' | 'network' = 'reject';
    const adapter = fakeAdapter({
      signAndSubmit: async () => {
        throw new Error(mode === 'reject' ? 'User rejected the request' : 'socket hang up');
      },
    });
    const r = router([fakeProvider('a', async () => quoteFrom('a', 100n))], adapter);
    const { q, p } = await prepare(r);
    expect((await r.executeRoute(p, q, { quoteId: q.id, confirmed: true })).status).toBe('rejected');
    mode = 'network';
    expect((await r.executeRoute(p, q, { quoteId: q.id, confirmed: true })).status).toBe('failed');
    await expect(r.executeRoute(p, q, { quoteId: q.id, confirmed: true })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('marks a wallet that never sent as not sent, and lets the same quote be tried again', async () => {
    let n = 0;
    const adapter = fakeAdapter({
      signAndSubmit: async () => {
        if (n++ === 0) throw new SwingsError('not-sent', 'Your wallet did not send this.');
        return '0xabc';
      },
    });
    const r = router([fakeProvider('a', async () => quoteFrom('a', 100n))], adapter);
    const { q, p } = await prepare(r);
    const first = await r.executeRoute(p, q, { quoteId: q.id, confirmed: true });
    expect(first).toMatchObject({ status: 'failed', notSent: true });
    expect((await r.executeRoute(p, q, { quoteId: q.id, confirmed: true })).status).toBe('submitted');
  });

  it('tracks a transaction to confirmation', async () => {
    const statuses = ['submitted', 'submitted', 'confirmed'] as const;
    let i = 0;
    const adapter = fakeAdapter({ getStatus: async () => statuses[Math.min(i++, 2)]! });
    const r = router([fakeProvider('a', async () => quoteFrom('a', 100n))], adapter);
    const { q, p } = await prepare(r);
    const ex = await r.executeRoute(p, q, { quoteId: q.id, confirmed: true });
    expect((await r.trackExecution(ex, { intervalMs: 1 })).status).toBe('confirmed');
  });
});

describe('keeping a Solana swap moving', () => {
  const prepare = async (r: AretiaRouter) => {
    const q = await r.getQuote(request);
    return { q, p: await r.buildTransaction(q) };
  };

  it('keeps tracking when a status look fails, instead of reporting the swap as lost', async () => {
    let i = 0;
    const adapter = fakeAdapter({
      getStatus: async () => {
        if (i++ < 2) throw new Error('The Solana RPC answered 429');
        return 'confirmed';
      },
    });
    const r = router([fakeProvider('a', async () => quoteFrom('a', 100n))], adapter);
    const { q, p } = await prepare(r);
    const ex = await r.executeRoute(p, q, { quoteId: q.id, confirmed: true });
    expect((await r.trackExecution(ex, { intervalMs: 1 })).status).toBe('confirmed');
  });

  it('sends a swap the network has not seen again, and stops once it is confirmed', async () => {
    const resend = vi.fn(async () => true);
    const settled = vi.fn();
    const answers: ({ err: unknown; confirmationStatus?: string } | null)[] = [null, null, { err: null, confirmationStatus: 'confirmed' }];
    let n = 0;
    const adapter = new SolanaChainAdapter({ rpc: (async () => ({ value: [answers[Math.min(n++, 2)]] })) as never, signAndSubmit: async () => 'sig', resend, settled });
    expect(await adapter.getStatus('sig')).toBe('submitted');
    expect(await adapter.getStatus('sig')).toBe('submitted');
    expect(resend).toHaveBeenCalledTimes(2);
    expect(await adapter.getStatus('sig')).toBe('confirmed');
    expect(resend).toHaveBeenCalledTimes(2);
    expect(settled).toHaveBeenCalledWith('sig');
  });
});

describe('Jupiter provider and Solana adapter', () => {
  const jq: JupiterQuote = { inAmount: 1_000_000n, outAmount: 5_000n, minOut: 4_950n, slippageBps: 100, routes: ['Raydium', 'Orca'] };
  const token = (mint: string, symbol: string) => ({ mint, symbol, name: symbol, decimals: 6, icon: null, verified: true });
  const backend = (blockers: string[] = []): JupiterBackend => ({
    fetchQuote: vi.fn(async () => jq),
    planSwap: vi.fn(async () => ({ blockers, priorityFeeLamports: 0, opensOutputAccount: false })),
    resolveToken: async (m) => token(m, m === USDC ? 'USDC' : 'SOL'),
  });

  it('turns a Jupiter quote into a provider-neutral one', async () => {
    const p = new SolanaJupiterProvider(backend(), now);
    const q = await p.getQuote(request);
    expect(q).toMatchObject({ providerId: 'jupiter', expectedOut: 5_000n, minOut: 4_950n, priceImpactBps: null });
    expect(q.route.legs.map((l) => l.venue)).toEqual(['Raydium', 'Orca']);
    expect(q.expiresAt - q.fetchedAt).toBe(20_000);
  });

  it('refuses same-token, zero-amount and non-Solana requests', async () => {
    const p = new SolanaJupiterProvider(backend(), now);
    await expect(p.getQuote({ ...request, to: request.from })).rejects.toMatchObject({ code: 'invalid' });
    await expect(p.getQuote({ ...request, amountIn: 0n })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('carries transaction blockers into the simulation report and passes zero fee', async () => {
    const b = backend(['The simulation shows this swap taking more than the amount you entered. It was blocked.']);
    const p = new SolanaJupiterProvider(b, now);
    const prepared = await p.buildTransaction(await p.getQuote(request));
    expect(prepared.simulation.ok).toBe(false);
    expect(prepared.simulation.blockers).toHaveLength(1);
  });

  it('the adapter reads balances and never sends the same quote twice', async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'getBalance') return { value: 42 };
      return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: '7' } } } } } }, { account: { data: { parsed: { info: { tokenAmount: { amount: '5' } } } } } }] };
    }) as never;
    const submit = vi.fn(async () => 'sig');
    const a = new SolanaChainAdapter({ rpc, signAndSubmit: submit });
    expect(await a.getBalance(request.account, { chain: 'solana', address: WSOL })).toBe(42n);
    expect(await a.getBalance(request.account, request.from)).toBe(12n);
    const prepared: PreparedSwap = { quoteId: 'q', chain: 'solana', payload: {}, simulation: { ok: true, blockers: [], warnings: [] }, preparedAt: 0 };
    await a.signAndSubmit(prepared);
    await expect(a.signAndSubmit(prepared)).rejects.toMatchObject({ code: 'invalid' });
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe('slow providers and what the person is told', () => {
  it('gives a provider that asks for a longer window that window, and still times out an ordinary one at the router limit', async () => {
    vi.useFakeTimers();
    try {
      const slowButWorthIt = { ...fakeProvider('long', () => new Promise<Quote>((res) => setTimeout(() => res(quoteFrom('long', 100n)), 12_000))), quoteTimeoutMs: 25_000 };
      const ordinary = fakeProvider('short', () => new Promise<Quote>((res) => setTimeout(() => res(quoteFrom('short', 100n)), 12_000)));
      const r = new AretiaRouter({ providers: [slowButWorthIt, ordinary], adapters: [], isChainEnabled: () => true, now, providerTimeoutMs: 8_000 });
      const pending = r.findRoutes(request);
      await vi.advanceTimersByTimeAsync(13_000);
      const res = await pending;
      expect(res.routes.map((q) => q.providerId)).toEqual(['long']);
      expect(res.failures).toEqual([{ providerId: 'short', message: 'The provider did not answer in time.' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says what really happened when there is no route', () => {
    const label = (id: string) => (id === 'aretia-sol' ? 'The Aretia Router' : id);
    expect(explainNoRoute([], label)).toBe('No route was found for this swap. Try a different amount or token.');
    expect(explainNoRoute([{ providerId: 'aretia-sol', message: 'No pool Aretia reads directly can fill this trade.', answered: true }], label)).toBe('No route was found for this swap. No pool Aretia reads directly can fill this trade.');
    // A timeout is not a missing route, and "try a different token" would be wrong advice for it.
    const slow = explainNoRoute([{ providerId: 'aretia-sol', message: 'The provider did not answer in time.' }], label);
    expect(slow).toMatch(/The Aretia Router took too long to answer, so this is not a missing route/);
    expect(slow).not.toMatch(/different amount or token/);
    expect(explainNoRoute([{ providerId: 'aretia-sol', message: '503' }], label)).toBe('The Aretia Router could not be reached. Try again in a moment.');
    // One provider answered and another did not: both facts are told.
    expect(explainNoRoute([{ providerId: 'aretia-sol', message: 'No pool.', answered: true }, { providerId: 'jupiter', message: 'x' }], label)).toBe('No route was found for this swap. No pool. jupiter did not answer.');
    // A provider that was only skipped is not described as not answering.
    expect(explainNoRoute([{ providerId: 'aretia-sol', message: 'Temporarily skipped after repeated failures.' }], label)).toBe('No route was found for this swap. Try a different amount or token.');
  });
});

describe('time budget', () => {
  it('does not hold a good route back for a slow provider beyond the grace window', async () => {
    vi.useFakeTimers();
    try {
      const fast = fakeProvider('fast', () => new Promise<Quote>((res) => setTimeout(() => res(quoteFrom('fast', 100n)), 1_000)));
      const slow = { ...fakeProvider('slow', () => new Promise<Quote>((res) => setTimeout(() => res(quoteFrom('slow', 500n)), 20_000))), quoteTimeoutMs: 25_000 };
      const r = new AretiaRouter({ providers: [fast, slow], adapters: [], isChainEnabled: () => true, now, providerTimeoutMs: 8_000 });
      let finished = false;
      const pending = r.findRoutes(request).then((x) => ((finished = true), x));
      await vi.advanceTimersByTimeAsync(1_000 + 4_000 + 50);
      expect(finished).toBe(true);
      const res = await pending;
      expect(res.routes.map((q) => q.providerId)).toEqual(['fast']);
      expect(res.failures[0]).toMatchObject({ providerId: 'slow', answered: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a preparation that hangs with a clear error', async () => {
    vi.useFakeTimers();
    try {
      const hang: DexProvider = { ...fakeProvider('hang', async () => quoteFrom('hang', 100n)), buildTransaction: () => new Promise<PreparedSwap>(() => undefined) };
      const r = new AretiaRouter({ providers: [hang], adapters: [], isChainEnabled: () => true, now, buildTimeoutMs: 12_000 });
      const out = expect(r.buildTransaction(quoteFrom('hang', 100n))).rejects.toMatchObject({ message: /took too long/ });
      await vi.advanceTimersByTimeAsync(12_100);
      await out;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('M-12: a quote refreshed inside Swap is signed only when it matches the one on screen', () => {
  const shown = quoteFrom('aretia-sol', 1_000_000n);
  it('lets a same-route refresh within the tolerance, or a better one, go straight to the wallet', () => {
    expect(AretiaRouter.refreshDrift(shown, quoteFrom('aretia-sol', 999_000n))).toBeNull();
    expect(AretiaRouter.refreshDrift(shown, quoteFrom('aretia-sol', 1_200_000n))).toBeNull();
  });
  it('stops on a new provider, a lower output, or a lower minimum', () => {
    expect(AretiaRouter.refreshDrift(shown, quoteFrom('jupiter', 1_100_000n))).toMatch(/route changed/);
    expect(AretiaRouter.refreshDrift(shown, quoteFrom('aretia-sol', 990_000n))).toMatch(/price fell/);
    expect(AretiaRouter.refreshDrift(shown, quoteFrom('aretia-sol', 1_000_000n, { minOut: 900_000n }))).toMatch(/minimum/);
  });
});
