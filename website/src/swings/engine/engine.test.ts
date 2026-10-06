import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { applyConstantProduct, getAmountIn, getAmountOut, priceImpactBps, quoteConstantProduct } from './amm.js';
import { ProviderHealth, worstStatus } from './health.js';
import { AretiaDexRegistry, type DexEntry } from './registry.js';
import { LiquidityStore } from './liquidity.js';
import { PriceEngine, poolSpotPrice } from './price.js';
import { RoutingEngine } from './routing.js';
import type { LiquidityPool } from './types.js';
import { EVM_V2_DEXES } from '../dex/entries.js';
import { EvmV2Adapter } from '../dex/evmV2.js';
import { buildV2Swap, inspectV2Swap, simulateV2Swap } from '../execution/evmV2Builder.js';
import { selector, encodeCall, uint, address, addressArray } from './abi.js';
import type { TokenRef } from '../core/types.js';

const tok = (n: number): TokenRef => ({ chain: 'base', address: '0x' + n.toString(16).padStart(40, '0') });
const A = tok(1);
const B = tok(2);
const C = tok(3);
const E18 = 10n ** 18n;
const clock = 1_000_000;
const now = () => clock;

function pool(dex: string, x: TokenRef, y: TokenRef, rx: bigint, ry: bigint, over: Partial<LiquidityPool> = {}): LiquidityPool {
  const [t0, t1, r0, r1] = BigInt(x.address) < BigInt(y.address) ? [x, y, rx, ry] : [y, x, ry, rx];
  return { ref: { chain: 'base', dex, address: '0x' + (dex + x.address.slice(-2) + y.address.slice(-2)).split('').map((c) => c.charCodeAt(0).toString(16)).join('').slice(0, 40).padEnd(40, '0') }, model: 'constant-product', token0: t0, token1: t1, reserve0: r0, reserve1: r1, feePpm: 3000, updatedAt: clock, block: null, status: 'active', ...over };
}

describe('constant-product maths', () => {
  it('matches Uniswap V2 getAmountOut on a hand-computed case', () => {
    // 1 token into 100/100 with a 0.3% fee: 997e15 * 100e18 / (100e18*1000e15... ) computed independently below.
    const out = getAmountOut(E18, 100n * E18, 100n * E18, 3000);
    expect(out).toBe((E18 * 997n * 100n * E18) / (100n * E18 * 1000n + E18 * 997n));
    expect(out).toBe(987158034397061298n);
  });
  it('rejects empty pools, zero amounts and absurd fees', () => {
    expect(() => getAmountOut(0n, 1n, 1n, 3000)).toThrow();
    expect(() => getAmountOut(1n, 0n, 1n, 3000)).toThrow();
    expect(() => getAmountOut(1n, 1n, 1n, 1_000_000)).toThrow();
    expect(() => getAmountIn(10n, 1n, 10n, 3000)).toThrow();
  });
  it('property: output is below the reserve, the invariant never shrinks, and bigger trades never pay a better rate', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 24n }), fc.bigInt({ min: 10n ** 6n, max: 10n ** 27n }), fc.bigInt({ min: 10n ** 6n, max: 10n ** 27n }), fc.integer({ min: 0, max: 100_000 }), (amountIn, rIn, rOut, fee) => {
        const out = getAmountOut(amountIn, rIn, rOut, fee);
        const kBefore = rIn * rOut;
        const kAfter = (rIn + amountIn) * (rOut - out);
        const out2 = getAmountOut(amountIn * 2n, rIn, rOut, fee);
        // Doubling the trade pays at most twice as much (rate worsens with size).
        return out < rOut && kAfter >= kBefore && out2 <= out * 2n + 1n;
      }),
    );
  });
  it('property: getAmountIn then getAmountOut always delivers at least the wanted output', () => {
    fc.assert(fc.property(fc.bigInt({ min: 10n ** 9n, max: 10n ** 24n }), fc.bigInt({ min: 10n ** 9n, max: 10n ** 24n }), fc.bigInt({ min: 1n, max: 10n ** 6n }), (rIn, rOut, want) => {
      if (want >= rOut) return true;
      const need = getAmountIn(want, rIn, rOut, 3000);
      return getAmountOut(need, rIn, rOut, 3000) >= want;
    }));
  });
  it('applying a swap moves the reserves the right way', () => {
    const p = pool('x', A, B, 100n * E18, 200n * E18);
    const { pool: after, amountOut } = applyConstantProduct(p, A, E18);
    const aIs0 = BigInt(A.address) < BigInt(B.address);
    expect(aIs0 ? after.reserve0 : after.reserve1).toBe(101n * E18);
    expect(aIs0 ? after.reserve1 : after.reserve0).toBe(200n * E18 - amountOut);
    expect(priceImpactBps(E18, amountOut, 100n * E18, 200n * E18)).toBeGreaterThan(0);
  });
});

describe('health and registry', () => {
  it('moves ACTIVE -> DEGRADED -> DISABLED and recovers after a cooldown and a run of successes', () => {
    let t = 0;
    const h = new ProviderHealth({ now: () => t, cooldownMs: 1_000, minSamples: 5 });
    for (let i = 0; i < 5; i++) h.record('dex', true, 50);
    expect(h.status('dex')).toBe('ACTIVE');
    for (let i = 0; i < 4; i++) h.record('dex', false, 50);
    expect(h.status('dex')).toBe('DEGRADED');
    for (let i = 0; i < 12; i++) h.record('dex', false, 50);
    expect(h.status('dex')).toBe('DISABLED');
    expect(h.usable('dex')).toBe(false);
    t += 2_000;
    expect(h.status('dex')).toBe('DEGRADED');
    for (let i = 0; i < 5; i++) h.record('dex', true, 40);
    expect(h.status('dex')).toBe('ACTIVE');
    expect(h.report('dex').p95LatencyMs).not.toBeNull();
  });
  it('does not judge on too few observations, and flags a silent component as stale', () => {
    let t = 0;
    const h = new ProviderHealth({ now: () => t, staleAfterMs: 1_000 });
    h.record('x', false, 1);
    expect(h.status('x')).toBe('ACTIVE');
    for (let i = 0; i < 5; i++) h.record('y', true, 1);
    t += 5_000;
    expect(h.status('y')).toBe('DEGRADED');
  });
  it('tracks async work and rethrows', async () => {
    const h = new ProviderHealth();
    await expect(h.track('a', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(h.report('a').samples).toBe(1);
  });
  it('combines registry flag and health, and a venue can be removed without touching anything else', () => {
    const health = new ProviderHealth({ minSamples: 1, disableAt: 0.5 });
    const reg = new AretiaDexRegistry(EVM_V2_DEXES, health);
    expect(reg.routable('base').map((e) => e.id)).toEqual(['uniswap-v2-base']);
    reg.setStatus('uniswap-v2-base', 'MAINTENANCE');
    expect(reg.routable('base')).toEqual([]);
    reg.setStatus('uniswap-v2-base', 'ACTIVE');
    health.record('uniswap-v2-base', false, 1);
    expect(reg.effectiveStatus('uniswap-v2-base')).toBe('DISABLED');
    expect(reg.remove('uniswap-v2-base')).toBe(true);
    expect(reg.forChain('base')).toEqual([]);
    expect(reg.effectiveStatus('uniswap-v2-base')).toBe('DISABLED');
    expect(worstStatus('ACTIVE', 'DEGRADED')).toBe('DEGRADED');
  });
  it('rejects duplicate venues and unknown status changes', () => {
    const reg = new AretiaDexRegistry(EVM_V2_DEXES);
    expect(() => reg.register(EVM_V2_DEXES[0] as DexEntry)).toThrow();
    expect(() => reg.setStatus('nope', 'ACTIVE')).toThrow();
  });
});

describe('liquidity store and price engine', () => {
  it('never lets an older read overwrite a newer one', () => {
    const store = new LiquidityStore(now);
    const newer = pool('x', A, B, 100n, 100n, { updatedAt: clock, block: 10n });
    const older = pool('x', A, B, 1n, 1n, { updatedAt: clock - 10, block: 9n });
    expect(store.put(newer)).toBe(true);
    expect(store.put(older)).toBe(false);
    expect(store.forPair(A, B)[0]!.reserve0 === 100n || store.forPair(A, B)[0]!.reserve1 === 100n).toBe(true);
  });
  it('prices from pool reserves with both decimals, and weights deeper pools more', () => {
    const store = new LiquidityStore(now);
    // 1000 A (18 dec) vs 2,000,000 B (6 dec) => 1 A = 2000 B
    store.put(pool('deep', A, B, 1_000n * E18, 2_000_000n * 10n ** 6n));
    store.put(pool('thin', A, B, 10n * E18, 22_000n * 10n ** 6n));
    const decimals = (t: TokenRef) => (t.address === A.address ? 18 : 6);
    const price = new PriceEngine(store, decimals, now);
    expect(poolSpotPrice(store.forPair(A, B)[0]!, A, decimals) > 0n).toBe(true);
    expect(price.spot({ tokenIn: A, tokenOut: B })).toBe(2000n * E18);
    const lw = price.liquidityWeighted({ tokenIn: A, tokenOut: B })!;
    expect(lw > 2000n * E18 && lw < 2200n * E18).toBe(true);
    expect(price.mid({ tokenIn: A, tokenOut: B })).toBe((2000n * E18 + 2200n * E18) / 2n);
  });
  it('ignores stale pools and computes a TWAP only from recorded observations', () => {
    let t = 0;
    const store = new LiquidityStore(() => t);
    store.put(pool('p', A, B, 1_000n * E18, 1_000n * E18, { updatedAt: 0 }));
    const price = new PriceEngine(store, () => 18, () => t);
    expect(price.twap({ tokenIn: A, tokenOut: B }, 10_000)).toBeNull();
    price.observe({ tokenIn: A, tokenOut: B });
    t = 5_000;
    price.observe({ tokenIn: A, tokenOut: B });
    t = 6_000;
    expect(price.twap({ tokenIn: A, tokenOut: B }, 10_000)).toBe(E18);
    t = 500_000;
    expect(price.spot({ tokenIn: A, tokenOut: B })).toBeNull();
  });
});

describe('routing engine', () => {
  const engine = (store: LiquidityStore, extra: Partial<ConstructorParameters<typeof RoutingEngine>[0]> = {}) => new RoutingEngine({ store, now, ...extra });
  const req = (amountIn: bigint) => ({ tokenIn: A, tokenOut: C, amountIn });

  it('finds direct and multi-hop routes, ranks by score and records the reasoning', () => {
    const store = new LiquidityStore(now);
    store.put(pool('direct', A, C, 100n * E18, 100n * E18));
    store.put(pool('hopAB', A, B, 1_000n * E18, 1_000n * E18));
    store.put(pool('hopBC', B, C, 1_000n * E18, 1_000n * E18));
    const res = engine(store).find(req(10n * E18), false);
    expect(res.best.hops.map((h) => h.pool.ref.dex)).toEqual(['hopAB', 'hopBC']);
    expect(res.alternatives[0]!.hops).toHaveLength(1);
    expect(res.best.reasons.some((r) => /2 hops/.test(r))).toBe(true);
    expect(res.best.reasons.some((r) => /not priced/.test(r))).toBe(true);
    expect(res.reasoning.length).toBeGreaterThan(1);
  });
  it('is deterministic', () => {
    const store = new LiquidityStore(now);
    store.put(pool('a', A, C, 100n * E18, 100n * E18));
    store.put(pool('b', A, C, 100n * E18, 100n * E18));
    const one = engine(store).find(req(E18));
    const two = engine(store).find(req(E18));
    expect(JSON.stringify(one, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(JSON.stringify(two, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  });
  it('subtracts a priced network fee, and can prefer a route with fewer hops because of it', () => {
    const store = new LiquidityStore(now);
    store.put(pool('direct', A, C, 100n * E18, 100n * E18));
    store.put(pool('hopAB', A, B, 100_000n * E18, 100_000n * E18));
    store.put(pool('hopBC', B, C, 100_000n * E18, 100_000n * E18));
    // With deep two-hop pools, two hops pays more for a big trade...
    expect(engine(store).routes(req(20n * E18))[0]!.hops).toHaveLength(2);
    // ...but a large per-hop fee flips it.
    const priced = engine(store, { gasCostInOut: (hops) => BigInt(hops) * 5n * E18 });
    expect(priced.routes(req(20n * E18))[0]!.hops).toHaveLength(1);
  });
  it('never routes through blocked tokens or disabled venues, and ignores stale pools', () => {
    const store = new LiquidityStore(now);
    store.put(pool('hopAB', A, B, 1_000n * E18, 1_000n * E18));
    store.put(pool('hopBC', B, C, 1_000n * E18, 1_000n * E18));
    expect(() => engine(store, { isBlocked: (t) => t.address === B.address }).routes(req(E18))).toThrow(/No route/);
    expect(() => engine(store, { isBlocked: (t) => t.address === C.address }).routes(req(E18))).toThrow(/No route/);
    const reg = new AretiaDexRegistry([{ id: 'hopAB', name: 'AB', chain: 'base', protocol: 'uniswap-v2', model: 'constant-product', mechanism: 'evm-v2-router', status: 'DISABLED' }, { id: 'hopBC', name: 'BC', chain: 'base', protocol: 'uniswap-v2', model: 'constant-product', mechanism: 'evm-v2-router', status: 'ACTIVE' }]);
    expect(() => engine(store, { registry: reg }).routes(req(E18))).toThrow(/No route/);
    const old = new LiquidityStore(now);
    old.put(pool('x', A, C, 1_000n * E18, 1_000n * E18, { updatedAt: clock - 10 * 60_000 }));
    expect(() => engine(old).routes(req(E18))).toThrow(/No route/);
  });
  it('penalises degraded venues and stale-but-usable pools', () => {
    const store = new LiquidityStore(now);
    store.put(pool('fresh', A, C, 100n * E18, 100n * E18));
    store.put(pool('slowish', A, C, 100n * E18, 100n * E18, { updatedAt: clock - 60_000 }));
    const res = engine(store).routes(req(E18));
    expect(res[0]!.hops[0]!.pool.ref.dex).toBe('fresh');
    expect(res[1]!.reasons.join(' ')).toMatch(/old: -5 bps/);
  });
  it('rejects bad requests', () => {
    const store = new LiquidityStore(now);
    expect(() => engine(store).routes({ tokenIn: A, tokenOut: A, amountIn: 1n })).toThrow();
    expect(() => engine(store).routes({ tokenIn: A, tokenOut: C, amountIn: 0n })).toThrow();
  });

  describe('split routing', () => {
    it('splits a large order across equal pools and the replayed total beats the single route', () => {
      const store = new LiquidityStore(now);
      store.put(pool('one', A, C, 1_000n * E18, 1_000n * E18));
      store.put(pool('two', A, C, 1_000n * E18, 1_000n * E18));
      store.put(pool('three', A, C, 1_000n * E18, 1_000n * E18));
      const res = engine(store).find(req(300n * E18));
      expect(res.split).not.toBeNull();
      const split = res.split!;
      expect(split.legs.length).toBeGreaterThanOrEqual(2);
      expect(split.legs.reduce((s, l) => s + l.shareBps, 0)).toBe(10_000);
      expect(split.legs.reduce((s, l) => s + l.share.amountIn, 0n)).toBe(300n * E18);
      expect(split.amountOut).toBeGreaterThan(res.best.amountOut);
      expect(split.improvementBps).toBeGreaterThanOrEqual(10);
    });
    it('does not split a small order, where it only adds complexity', () => {
      const store = new LiquidityStore(now);
      store.put(pool('one', A, C, 1_000n * E18, 1_000n * E18));
      store.put(pool('two', A, C, 1_000n * E18, 1_000n * E18));
      const res = engine(store).find(req(E18 / 100n));
      expect(res.split).toBeNull();
      expect(res.reasoning.join(' ')).toMatch(/Not split/);
    });
    it('does not split when one route is simply much better', () => {
      const store = new LiquidityStore(now);
      store.put(pool('deep', A, C, 1_000_000n * E18, 1_000_000n * E18));
      store.put(pool('tiny', A, C, 10n * E18, 10n * E18));
      expect(engine(store).find(req(50n * E18)).split).toBeNull();
    });
    it('property: any split pays at least the best single route and conserves the input', () => {
      fc.assert(
        fc.property(fc.bigInt({ min: 1n, max: 900n }), fc.bigInt({ min: 500n, max: 5_000n }), fc.bigInt({ min: 500n, max: 5_000n }), (amount, r1, r2) => {
          const store = new LiquidityStore(now);
          store.put(pool('p1', A, C, r1 * E18, r1 * E18));
          store.put(pool('p2', A, C, r2 * E18, r2 * E18));
          const res = engine(store).find(req(amount * E18));
          if (!res.split) return true;
          return res.split.amountOut > res.best.amountOut && res.split.legs.reduce((s, l) => s + l.share.amountIn, 0n) === amount * E18;
        }),
        { numRuns: 60 },
      );
    });
    it('shares pool state between legs that touch the same pool', () => {
      const store = new LiquidityStore(now);
      store.put(pool('ab1', A, B, 1_000n * E18, 1_000n * E18));
      store.put(pool('ab2', A, B, 1_000n * E18, 1_000n * E18));
      store.put(pool('bc', B, C, 100_000n * E18, 100_000n * E18));
      const res = engine(store).find(req(400n * E18));
      expect(res.split).not.toBeNull();
      // Both legs end in the same bc pool: the second leg must be priced after the first moved it.
      const [l1, l2] = res.split!.legs;
      const solo2 = quoteConstantProduct(store.forPair(B, C)[0]!, B, l2!.share.hops[0]!.amountOut);
      expect(l2!.share.hops[1]!.amountOut).toBeLessThan(solo2);
      expect(l1).toBeDefined();
    });
  });
});

describe('ABI, V2 adapter and transaction builder', () => {
  it('derives the well-known selectors from signatures', () => {
    expect(selector('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)')).toBe('38ed1739');
    expect(selector('swapExactETHForTokens(uint256,address[],address,uint256)')).toBe('7ff36ab5');
    expect(selector('swapExactTokensForETH(uint256,uint256,address[],address,uint256)')).toBe('18cbafe5');
    expect(selector('getPair(address,address)')).toBe('e6a43905');
    expect(selector('getReserves()')).toBe('0902f1ac');
    expect(selector('token0()')).toBe('0dfe1681');
    expect(selector('approve(address,uint256)')).toBe('095ea7b3');
    expect(selector('transfer(address,uint256)')).toBe('a9059cbb');
  });
  it('encodes dynamic arrays with the right offsets', () => {
    const data = encodeCall('f(uint256,address[],address)', [uint(5n), addressArray([tok(7).address, tok(8).address]), address(tok(9).address)]);
    const body = data.slice(10);
    expect(body.slice(64, 128)).toBe((96).toString(16).padStart(64, '0')); // offset of the array: after 3 head words
    expect(body.length / 64).toBe(3 + 1 + 2);
  });

  const entry = EVM_V2_DEXES.find((e) => e.id === 'uniswap-v2-base')!;
  const wrapped = entry.wrappedNative!;
  const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const user = '0x' + '1'.repeat(40);

  it('builds token swaps, native swaps and inspects them back to what was asked', () => {
    const plan = buildV2Swap(entry, { path: [usdc, wrapped], amountIn: 5_000_000n, minOut: 123n, recipient: user, deadline: 2_000_000_000 }, 1_000);
    expect(plan.to).toBe(entry.router);
    expect(plan.value).toBe(0n);
    expect(plan.approval).toEqual({ token: usdc, spender: entry.router, amount: 5_000_000n });
    expect(inspectV2Swap(plan.data)).toEqual({ function: 'swapExactTokensForTokens', amountIn: 5_000_000n, minOut: 123n, path: [usdc, wrapped], recipient: user, deadline: 2_000_000_000 });

    const eth = buildV2Swap(entry, { path: [wrapped, usdc], amountIn: 10n ** 16n, minOut: 7n, recipient: user, deadline: 2_000_000_000, nativeIn: true }, 1_000);
    expect(eth.value).toBe(10n ** 16n);
    expect(eth.approval).toBeNull();
    expect(inspectV2Swap(eth.data)).toMatchObject({ function: 'swapExactETHForTokens', amountIn: null, minOut: 7n, path: [wrapped, usdc], recipient: user });

    const out = buildV2Swap(entry, { path: [usdc, wrapped], amountIn: 5n, minOut: 1n, recipient: user, deadline: 2_000_000_000, nativeOut: true }, 1_000);
    expect(inspectV2Swap(out.data)?.function).toBe('swapExactTokensForETH');
    expect(inspectV2Swap('0x12345678')).toBeNull();
  });
  it('refuses unsafe or malformed swaps', () => {
    const ok = { path: [usdc, wrapped], amountIn: 5n, minOut: 1n, recipient: user, deadline: 2_000_000_000 };
    expect(() => buildV2Swap(entry, { ...ok, minOut: 0n }, 1_000)).toThrow(/minimum/);
    expect(() => buildV2Swap(entry, { ...ok, amountIn: 0n }, 1_000)).toThrow();
    expect(() => buildV2Swap(entry, { ...ok, deadline: 500 }, 1_000)).toThrow(/deadline/);
    expect(() => buildV2Swap(entry, { ...ok, recipient: 'nope' }, 1_000)).toThrow();
    expect(() => buildV2Swap(entry, { ...ok, path: [usdc] }, 1_000)).toThrow();
    expect(() => buildV2Swap(entry, { ...ok, path: [usdc, usdc] }, 1_000)).toThrow();
    expect(() => buildV2Swap(entry, { ...ok, nativeIn: true }, 1_000)).toThrow(/wrapped/);
    expect(() => buildV2Swap(entry, { ...ok, nativeIn: true, nativeOut: true }, 1_000)).toThrow();
  });
  it('property: calldata always round-trips through inspection', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 30n }), fc.bigInt({ min: 1n, max: 10n ** 30n }), fc.integer({ min: 2_000_000, max: 4_000_000_000 }), (amountIn, minOut, deadline) => {
        const plan = buildV2Swap(entry, { path: [usdc, wrapped], amountIn, minOut, recipient: user, deadline }, 1_000);
        const back = inspectV2Swap(plan.data)!;
        return back.amountIn === amountIn && back.minOut === minOut && back.deadline === deadline && back.recipient === user;
      }),
    );
  });
  it('simulation reports router failures instead of hiding them', async () => {
    const plan = buildV2Swap(entry, { path: [usdc, wrapped], amountIn: 5n, minOut: 1n, recipient: user, deadline: 2_000_000_000 }, 1_000);
    expect(await simulateV2Swap(async () => { throw new Error('execution reverted: INSUFFICIENT_OUTPUT_AMOUNT'); }, plan, user)).toEqual({ ok: false, amounts: null, error: 'execution reverted: INSUFFICIENT_OUTPUT_AMOUNT' });
    const word = (n: bigint) => n.toString(16).padStart(64, '0');
    const good = '0x' + word(32n) + word(2n) + word(5n) + word(9n);
    expect(await simulateV2Swap(async () => good, plan, user)).toEqual({ ok: true, amounts: [5n, 9n], error: null });
  });
  it('the V2 adapter reads a pair through the factory and orients tokens by the pair', async () => {
    const pair = '0x' + 'ab'.repeat(20);
    const w = (h: string) => h.replace('0x', '').padStart(64, '0');
    const [lo, hi] = BigInt(usdc) < BigInt(wrapped) ? [usdc, wrapped] : [wrapped, usdc];
    const read = async (_: string, params: unknown[]) => {
      const call = params[0] as { to: string; data: string };
      if (call.to === entry.factory) return '0x' + w(pair);
      if (call.data.startsWith('0x0dfe1681')) return '0x' + w(lo);
      return '0x' + w('0x64') + w('0xc8') + w('0x1');
    };
    const adapter = new EvmV2Adapter(entry, read, () => 5);
    const p = (await adapter.getPool({ chain: 'base', address: usdc }, { chain: 'base', address: wrapped }))!;
    expect(p.token0.address).toBe(lo);
    expect(p.token1.address).toBe(hi);
    expect([p.reserve0, p.reserve1]).toEqual([100n, 200n]);
    expect(p.feePpm).toBe(3000);
    expect(p.status).toBe('active');
    const none = new EvmV2Adapter(entry, async () => '0x' + '0'.repeat(64));
    expect(await none.getPool({ chain: 'base', address: usdc }, { chain: 'base', address: wrapped })).toBeNull();
    await expect(adapter.getPool({ chain: 'base', address: usdc }, { chain: 'base', address: usdc })).rejects.toThrow();
  });
});
