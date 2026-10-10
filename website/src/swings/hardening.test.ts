import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { toWire } from './observability/beacon.js';
import { cleanEvent } from '../../api/_swingsEvents';
import { AretiaRouter } from './router/router.js';
import { MockDexProvider } from './providers/mock.js';
import { parseZeroXQuote } from './providers/evm0x.js';
import { parseNewPools } from './tokens/sources/geckoTerminal.js';
import { DEFAULT_FEE_CONFIG, planAretiaFee } from './core/fee.js';
import { EVM_NATIVE_ADDRESS } from './core/types.js';
import { decimalsMismatch, normalizeTokenRef, parseTokenKey, tokenKey } from './core/token.js';
import { CrossChainRouter, classifySwap } from './crosschain/types.js';
import { redact, routerEventSink, summarize, Telemetry } from './observability/telemetry.js';
import { cleanText } from './tokens/registry.js';
import { SwingsError, type AretiaFeeConfig, type ChainId, type Quote, type SwapRequest } from './core/types.js';
import { judgeSwapSimulation, type SwapSimulation } from '../scripts/walletTools.js';
import { fromSmallestUnit, toSmallestUnit } from '../scripts/walletTools.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const request: SwapRequest = { chain: 'solana', from: { chain: 'solana', address: USDC }, to: { chain: 'solana', address: WSOL }, amountIn: 1_000_000n, slippageBps: 100, account: { chain: 'solana', address: USDC } };

const quote = (out: bigint, over: Partial<Quote> = {}): Quote => ({
  id: `q-${out}`, providerId: 'p', request, inAmount: 1_000_000n, expectedOut: out, minOut: (out * 99n) / 100n, priceImpactBps: 1,
  route: { legs: [{ venue: 'v', from: request.from, to: request.to, shareBps: 10_000 }] },
  costs: { network: null, provider: null, aretiaFee: { amount: 0n, asset: null } }, fetchedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER, raw: null, ...over,
});

describe('failure handling: a hostile or broken swap transaction is caught by the simulation judge', () => {
  const base: SwapSimulation = { solPre: 10_000_000_000n, solPost: 9_999_000_000n, inPre: 5_000_000n, inPost: 4_000_000n, outPre: 0n, outPost: 5_000n, others: [], error: null };
  const judge = (sim: Partial<SwapSimulation>, inputIsSol = false, outputIsSol = false) => judgeSwapSimulation({ inputIsSol, outputIsSol, amountIn: 1_000_000n, minOut: 4_950n, sim: { ...base, ...sim } });

  it('passes an honest swap', () => expect(judge({}).problems).toEqual([]));
  it('blocks a swap that takes more than the amount entered', () => expect(judge({ inPost: 3_000_000n }).problems.join(' ')).toMatch(/more than the amount/));
  it('blocks a swap that drains extra SOL (insufficient-gas style overspend)', () => expect(judge({ solPost: 5_000_000_000n }).problems.join(' ')).toMatch(/more SOL/));
  it('blocks SOL input that costs more than entered plus fees', () => expect(judge({ solPost: 8_000_000_000n }, true).problems.join(' ')).toMatch(/more SOL/));
  it('blocks a swap that would pay less than the minimum', () => expect(judge({ outPost: 100n }).problems.join(' ')).toMatch(/less than your minimum/));
  it('blocks a swap that also reduces another token the wallet holds', () => expect(judge({ others: [{ symbol: 'BONK', pre: 10n, post: 0n }] }).problems.join(' ')).toMatch(/BONK/));
  it('blocks when the network itself rejects the simulation', () => expect(judge({ error: 'insufficient funds for fee' }).problems.join(' ')).toMatch(/reject this swap/));
  it('blocks when the token being sold cannot be read', () => expect(judge({ inPre: null, inPost: null }).problems.length).toBeGreaterThan(0));
});

describe('failure handling: tokens and metadata', () => {
  it('blocks a token whose reported decimals differ from the chain', () => {
    expect(decimalsMismatch('FAKE', 6, 9)).toMatch(/blocked/);
    expect(decimalsMismatch('OK', 6, 6)).toBeNull();
  });
  it('strips control and direction-override characters from names', () => {
    // eslint-disable-next-line no-control-regex
    expect(cleanText('USDC‮\u0000 (real)', 40)).not.toMatch(/[‮\u0000]/);
  });
  it('treats symbol-lookalike tokens as different identities', () => {
    const a = normalizeTokenRef('solana', USDC)!;
    const b = normalizeTokenRef('solana', WSOL)!;
    expect(tokenKey(a)).not.toBe(tokenKey(b));
  });
});

describe('failure handling: providers and failover', () => {
  it('reports a clear error when every provider is down', async () => {
    const r = new AretiaRouter({ providers: [new MockDexProvider({ id: 'a', failWith: 'down' }), new MockDexProvider({ id: 'b', failWith: 'down' })], adapters: [], isChainEnabled: () => true });
    const err = await r.getQuote(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SwingsError);
    expect((err as SwingsError).code).toBe('no-route');
    expect((err as SwingsError).message).toMatch(/a, b/);
  });

  it('skips a provider after repeated failures, says so, and recovers after the cooldown', async () => {
    let now = 1_000;
    let healthy = false;
    const flaky = new MockDexProvider({ id: 'flaky', now: () => now });
    const real = flaky.getQuote.bind(flaky);
    flaky.getQuote = async (q) => (healthy ? real(q) : Promise.reject(new Error('503')));
    const r = new AretiaRouter({ providers: [flaky, new MockDexProvider({ id: 'ok', now: () => now })], adapters: [], isChainEnabled: () => true, now: () => now, breakerThreshold: 3, breakerCooldownMs: 10_000 });
    for (let i = 0; i < 3; i++) await r.findRoutes(request);
    const skipped = await r.findRoutes(request);
    expect(skipped.failures).toEqual([{ providerId: 'flaky', message: 'Temporarily skipped after repeated failures.' }]);
    healthy = true;
    now += 11_000;
    const back = await r.findRoutes(request);
    expect(back.routes.map((x) => x.providerId).sort()).toEqual(['flaky', 'ok']);
  });

  it('measures how much worse a fallback route is, so the user can accept it explicitly', () => {
    expect(AretiaRouter.degradationBps(quote(1_000n), quote(900n))).toBe(1_000);
    expect(AretiaRouter.degradationBps(quote(1_000n), quote(1_100n))).toBe(0);
  });
});

describe('cross-chain readiness', () => {
  const sol = { chain: 'solana' as const, address: USDC };
  const base = { chain: 'base' as const, address: '0x' + 'a'.repeat(40) };
  it('classifies same-chain and cross-chain requests', () => {
    expect(classifySwap(sol, { chain: 'solana', address: WSOL })).toBe('same-chain');
    expect(classifySwap(sol, base)).toBe('cross-chain');
  });
  it('refuses to quote or execute a cross-chain swap', async () => {
    const r = new CrossChainRouter();
    await expect(r.getQuote({ from: sol, to: base, amountIn: 1n, slippageBps: 50, sender: sol, recipient: base })).rejects.toMatchObject({ code: 'not-enabled' });
    expect(CrossChainRouter.EXECUTION_ENABLED).toBe(false);
  });
});

describe('observability never records secrets', () => {
  it('removes secret-named fields and masks long opaque blobs', () => {
    const out = redact({ seedPhrase: 'abandon abandon', privateKey: 'x', signature: 's', nested: { apiKey: 'k', fine: 'ok' }, blob: 'A'.repeat(120), amount: 5n }) as Record<string, unknown>;
    expect(out.seedPhrase).toBe('[redacted]');
    expect(out.privateKey).toBe('[redacted]');
    expect(out.signature).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).apiKey).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).fine).toBe('ok');
    expect(out.blob).toBe('[redacted blob]');
    expect(out.amount).toBe('5');
  });

  it('property: no field with a secret-like name ever survives redaction', () => {
    fc.assert(
      fc.property(fc.constantFrom('seed', 'mnemonic', 'privateKey', 'password', 'secret', 'apiKey', 'keypair', 'authorization'), fc.string(), (key, value) => {
        const out = redact({ [key]: value, deep: { [key]: value } }) as { [k: string]: unknown; deep: Record<string, unknown> };
        return out[key] === '[redacted]' && out.deep[key] === '[redacted]';
      }),
    );
  });

  it('records route selection, provider failures and swap outcomes as address-free aggregates', () => {
    let now = 0;
    const t = new Telemetry([], () => now);
    const sink = routerEventSink(t, (id) => id.split(':')[0]!, () => now);
    sink({ type: 'quote-failed', providerId: '0x', message: 'timeout' });
    now = 120;
    sink({ type: 'routes-found', chain: 'solana', count: 1, bestProvider: 'jupiter' });
    sink({ type: 'execution', execution: { id: 'e', quoteId: 'jupiter:1', chain: 'solana', status: 'awaiting-signature', startedAt: 1_000, updatedAt: 1_000 } });
    sink({ type: 'execution', execution: { id: 'e', quoteId: 'jupiter:1', chain: 'solana', status: 'confirmed', startedAt: 1_000, updatedAt: 9_000 } });
    const a = summarize(t);
    expect(a.swaps).toMatchObject({ total: 1, confirmed: 1 });
    expect(a.routeSelection).toEqual({ jupiter: 1 });
    expect(a.providers['0x']!.quoteFailures).toBe(1);
    expect(a.medianExecutionSeconds).toBe(8);
    expect(JSON.stringify(a)).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,}/);
    expect(t.latency('swap:jupiter')).toMatchObject({ n: 1 });
  });

  it('a throwing sink cannot break a swap', () => {
    const t = new Telemetry([{ write: () => { throw new Error('disk full'); } }]);
    expect(() => t.record({ name: 'rpc_failed', chain: 'solana', method: 'getBalance' })).not.toThrow();
    expect(t.count('rpc_failed')).toBe(1);
  });

  it('keeps a bounded buffer', () => {
    const t = new Telemetry([], Date.now, 5);
    for (let i = 0; i < 20; i++) t.record({ name: 'rpc_failed', chain: 'base', method: 'm' });
    expect(t.recent(100)).toHaveLength(5);
  });
});

describe('property and fuzz tests', () => {
  const cfg = (rateBps: number): AretiaFeeConfig => ({ policy: { ...DEFAULT_FEE_CONFIG.policy, enabled: true, rateBps }, chains: { ...DEFAULT_FEE_CONFIG.chains, base: { chainId: 'base', treasuryAddress: 't', enabled: true } } });

  it('fee: never more than the rate, never more than the amount, never negative, monotonic, and it plus the rest is exactly what was entered', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 30n }), fc.bigInt({ min: 0n, max: 10n ** 20n }), fc.integer({ min: 0, max: 100 }), (amount, extra, rate) => {
        const a = planAretiaFee(amount, 'base', cfg(rate), EVM_NATIVE_ADDRESS);
        const b = planAretiaFee(amount + extra, 'base', cfg(rate), EVM_NATIVE_ADDRESS);
        if (a.state !== 'ready' || b.state !== 'ready') return false;
        return a.fee >= 0n && a.fee <= amount && a.fee * 10_000n <= amount * BigInt(rate) && b.fee >= a.fee && a.fee + a.net === amount;
      }),
    );
  });

  it('fee: is zero whenever the policy is disabled, for any amount and chain, and then everything is swapped', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n }), fc.constantFrom<ChainId>('solana', 'ethereum', 'bnb', 'polygon', 'base'), (amount, chain) => {
      const p = planAretiaFee(amount, chain, DEFAULT_FEE_CONFIG, chain === 'solana' ? 'So11111111111111111111111111111111111111112' : EVM_NATIVE_ADDRESS);
      return p.fee === 0n && p.net === amount;
    }));
  });

  it('token identity: normalising is idempotent and survives a key round trip for any EVM address', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9a-fA-F]{40}$/), fc.constantFrom<ChainId>('ethereum', 'bnb', 'polygon', 'base'), (hex, chain) => {
        const once = normalizeTokenRef(chain, '0x' + hex.toLowerCase())!;
        return normalizeTokenRef(chain, once.address)!.address === once.address && parseTokenKey(tokenKey(once))!.address === once.address;
      }),
    );
  });

  it('token identity: arbitrary strings never normalise into a different chain or throw', () => {
    fc.assert(fc.property(fc.string(), fc.string(), (chain, address) => {
      const r = normalizeTokenRef(chain, address);
      return r === null || r.chain === chain;
    }));
  });

  it('amount conversion: raw -> text -> raw is exact for any decimals', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n }), fc.integer({ min: 0, max: 18 }), (raw, decimals) => toSmallestUnit(fromSmallestUnit(raw, decimals), decimals) === raw.toString()));
  });

  it('amount conversion: more decimal places than the token has is refused', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 12 }), (d) => toSmallestUnit('1.' + '1'.repeat(d + 1), d) === null));
  });

  it('ranking: result is sorted by expected output and independent of input order', () => {
    const r = new AretiaRouter({ providers: [], adapters: [] });
    fc.assert(
      fc.property(fc.uniqueArray(fc.bigInt({ min: 1n, max: 10n ** 12n }), { minLength: 1, maxLength: 8 }), (outs) => {
        const ranked = r.compareRoutes(outs.map((o) => quote(o))).map((q) => q.expectedOut);
        const reversed = r.compareRoutes([...outs].reverse().map((o) => quote(o))).map((q) => q.expectedOut);
        return ranked.every((v, i) => i === 0 || ranked[i - 1]! >= v) && ranked.join() === reversed.join();
      }),
    );
  });

  it('router: a quote with output below the slippage floor is never executable', () => {
    const r = new AretiaRouter({ providers: [], adapters: [], now: () => 0 });
    fc.assert(
      fc.property(fc.bigInt({ min: 10_000n, max: 10n ** 15n }), fc.integer({ min: 0, max: 5_000 }), fc.integer({ min: 1, max: 99 }), (out, slip, cutPct) => {
        const looseMin = (out * BigInt(100 - cutPct) * BigInt(10_000 - slip)) / 1_000_000n - 1n;
        const floor = (out * BigInt(10_000 - slip)) / 10_000n;
        const problems = r.executabilityProblems(quote(out, { minOut: looseMin > 0n ? looseMin : 1n }), { ...request, slippageBps: slip });
        return looseMin >= floor || problems.some((p) => /slippage/.test(p));
      }),
    );
  });

  it('fuzz: parsing hostile 0x responses only ever succeeds validly or throws a SwingsError', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        try {
          const parsed = parseZeroXQuote(input);
          return /^\d+$/.test(parsed.buyAmount) && /^0x[0-9a-fA-F]{40}$/.test(parsed.tx.to);
        } catch (e) {
          return e instanceof SwingsError;
        }
      }),
      { numRuns: 500 },
    );
  });

  it('fuzz: parsing hostile discovery payloads never throws', () => {
    fc.assert(fc.property(fc.anything(), fc.constantFrom<ChainId>('solana', 'base'), (input, chain) => {
      parseNewPools(chain, input);
      return true;
    }));
  });

  it('fuzz: cleaned text has no control or direction-override characters and respects the cap', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary' }), fc.integer({ min: 1, max: 64 }), (s, max) => {
      const out = cleanText(s, max);
      // eslint-disable-next-line no-control-regex
      return out.length <= max && !/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(out);
    }));
  }, 30_000);
});

describe('executed quotes cannot be replayed even by concurrent calls', () => {
  it('only one of two simultaneous executions reaches the wallet', async () => {
    const signAndSubmit = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); return 'sig'; });
    const adapter = { chain: 'solana' as const, getBalance: async () => 0n, signAndSubmit, getStatus: async () => 'confirmed' as const };
    const prov = new MockDexProvider({ id: 'm' });
    prov.buildTransaction = async (q) => ({ quoteId: q.id, chain: 'solana', payload: {}, simulation: { ok: true, blockers: [], warnings: [] }, preparedAt: 0 });
    const r = new AretiaRouter({ providers: [prov], adapters: [adapter] });
    const q = await r.getQuote(request);
    const p = await r.buildTransaction(q);
    const results = await Promise.allSettled([r.executeRoute(p, q, { quoteId: q.id, confirmed: true }), r.executeRoute(p, q, { quoteId: q.id, confirmed: true })]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(signAndSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('shadow comparison', () => {
  const quote = (providerId: string, out: bigint) => ({ id: providerId + ':1', providerId, request: { chain: 'solana', from: { chain: 'solana', address: 'a' }, to: { chain: 'solana', address: 'b' }, amountIn: 1n, slippageBps: 50, account: { chain: 'solana', address: 'c' } }, inAmount: 1n, expectedOut: out, minOut: out - 1n, priceImpactBps: 0, route: { legs: [] }, costs: { network: null, provider: null, aretiaFee: { amount: 0n, asset: null } }, fetchedAt: 1000, expiresAt: 100_000, raw: {} });
  const provider = (id: string, out: bigint) => ({ id, name: id, supports: () => true, getQuote: async () => quote(id, out), buildTransaction: async () => { throw new Error('unused'); } });
  const run = async (aretia: bigint, rival: bigint) => {
    const events: unknown[] = [];
    const router = new AretiaRouter({ providers: [provider('aretia-sol', aretia), provider('jupiter', rival)] as never, adapters: [], now: () => 1000, isChainEnabled: () => true, onEvent: (e) => events.push(e) });
    const found = await router.findRoutes({ chain: 'solana', from: { chain: 'solana', address: 'a' }, to: { chain: 'solana', address: 'b' }, amountIn: 1n, slippageBps: 50, account: { chain: 'solana', address: 'c' } } as never);
    return { events: events.filter((e) => (e as { type: string }).type === 'shadow') as { winner: string; rival: string; diffBps: number }[], found };
  };

  it('records who won and by how many basis points, and still executes the better route', async () => {
    const behind = await run(9_990_000n, 10_000_000n);
    expect(behind.events).toEqual([{ type: 'shadow', chain: 'solana', winner: 'jupiter', rival: 'jupiter', diffBps: -10 }]);
    expect(behind.found.routes[0]!.providerId).toBe('jupiter');
    const ahead = await run(10_050_000n, 10_000_000n);
    expect(ahead.events[0]).toMatchObject({ winner: 'aretia-sol', diffBps: 50 });
    expect(ahead.found.routes[0]!.providerId).toBe('aretia-sol');
  });

  it('records nothing when only one side quoted, and carries no address, amount or token to the wire', async () => {
    const events: unknown[] = [];
    const router = new AretiaRouter({ providers: [provider('aretia-sol', 5n)] as never, adapters: [], now: () => 1000, isChainEnabled: () => true, onEvent: (e) => events.push(e) });
    await router.findRoutes({ chain: 'solana', from: { chain: 'solana', address: 'a' }, to: { chain: 'solana', address: 'b' }, amountIn: 1n, slippageBps: 50, account: { chain: 'solana', address: 'c' } } as never);
    expect(events.some((e) => (e as { type: string }).type === 'shadow')).toBe(false);
    const wire = toWire({ at: 1, event: { name: 'shadow', chain: 'solana', provider: 'jupiter', rival: 'aretia-sol', diff: -12, account: '0xabc', amount: '5' } } as never);
    expect(wire).toEqual({ name: 'shadow', chain: 'solana', provider: 'jupiter', rival: 'aretia-sol', diff: -12 });
    expect(cleanEvent({ name: 'shadow', chain: 'solana', provider: 'jupiter', rival: 'aretia-sol', diff: -12 }, 9)).toMatchObject({ rival: 'aretia-sol', diff_bps: -12 });
    expect(cleanEvent({ name: 'shadow', diff: 99_999, rival: 'bad rival!' }, 9)).toMatchObject({ rival: null, diff_bps: null });
    expect(cleanEvent({ name: 'swap', rival: 'x', diff: 5 }, 9)).toMatchObject({ rival: null, diff_bps: null });
  });
});
