import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { BALANCER_NATIVE, buildBalancerSwap, EvmBalancerAdapter, inspectBalancerSwap, simulateBalancerSwap } from './evmBalancer.js';
import { DirectEvmProvider } from './directEvm.js';
import { EVM_BALANCER, EVM_DEXES } from './entries.js';
import { AretiaDexRegistry } from '../engine/registry.js';
import { decodeParams, encodeParams } from '../engine/abiGeneric.js';
import { selector } from '../engine/abi.js';
import { EVM_NATIVE_ADDRESS, type SwapRequest } from '../core/types.js';

const entry = EVM_BALANCER.find((e) => e.chain === 'ethereum')!;
const WETH = entry.wrappedNative!;
const BAL = '0xba100000625a3754423978a60c9317c58a424e3d';
const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
const USER = '0x' + '1'.repeat(40);
const [P_BAL_WETH, P_WBTC_WETH] = entry.knownPools!;

const GET_TOKENS = selector('getPoolTokens(bytes32)');
const QUERY = selector('queryBatchSwap(uint8,(bytes32,uint256,uint256,uint256,bytes)[],address[],(address,bool,address,bool))');

/** A fake Vault holding two pools and paying a fixed output per route. */
function vault(out: bigint = 1_000n) {
  return async (_: string, params: unknown[]): Promise<unknown> => {
    const c = params[0] as { to: string; data: string };
    const sel = c.data.slice(2, 10);
    if (sel === GET_TOKENS) {
      const id = '0x' + c.data.slice(10, 74);
      const tokens = id === P_BAL_WETH ? [BAL, WETH] : id === P_WBTC_WETH ? [WBTC, WETH] : null;
      if (!tokens) throw new Error('INVALID_POOL_ID');
      return encodeParams(['address[]', 'uint256[]', 'uint256'], [tokens, [1n, 1n], 1n]);
    }
    if (sel === QUERY) {
      const [, swaps, assets] = decodeParams(['uint8', '(bytes32,uint256,uint256,uint256,bytes)[]', 'address[]', '(address,bool,address,bool)'], '0x' + c.data.slice(10)) as [bigint, unknown[][], string[]];
      const deltas = assets.map(() => 0n);
      deltas[0] = swaps[0]![3] as bigint;
      deltas[Number(swaps[swaps.length - 1]![2])] = -out;
      return encodeParams(['int256[]'], [deltas]);
    }
    return encodeParams(['int256[]'], [[1n, -out]]);
  };
}

describe('Balancer builder and inspector', () => {
  const steps = [{ poolId: P_BAL_WETH!, assetIn: 0, assetOut: 1 }];
  const base = { steps, assets: [WETH, BAL], amountIn: 10n ** 17n, minOut: 500n, recipient: USER, deadline: 2_000_000_000 };

  it('builds native-in with the Vault sentinel and exact limits, and reads back exactly', () => {
    const plan = buildBalancerSwap(entry, { ...base, nativeIn: true }, 1_000);
    expect(plan.to).toBe(entry.router);
    expect(plan.value).toBe(10n ** 17n);
    expect(plan.approval).toBeNull();
    const back = inspectBalancerSwap(plan.data)!;
    expect(back.assets).toEqual([BALANCER_NATIVE, BAL]);
    expect(back.limits).toEqual([10n ** 17n, -500n]);
    expect(back.recipient).toBe(USER);
    expect(back.deadline).toBe(2_000_000_000);
    expect(back.steps).toEqual([{ poolId: P_BAL_WETH, assetIn: 0, assetOut: 1, amount: 10n ** 17n }]);
  });

  it('builds a token swap with an exact approval to the Vault, and a native-out swap', () => {
    const tok = buildBalancerSwap(entry, { ...base, assets: [BAL, WETH], amountIn: 7n, minOut: 3n }, 1_000);
    expect(tok.approval).toEqual({ token: BAL, spender: entry.router, amount: 7n });
    expect(tok.value).toBe(0n);
    const out = buildBalancerSwap(entry, { ...base, assets: [BAL, WETH], amountIn: 7n, minOut: 3n, nativeOut: true }, 1_000);
    expect(inspectBalancerSwap(out.data)!.assets).toEqual([BAL, BALANCER_NATIVE]);
  });

  it('a two-hop route nets intermediate assets to zero and only the first step carries an amount', () => {
    const two = [{ poolId: P_WBTC_WETH!, assetIn: 0, assetOut: 1 }, { poolId: P_BAL_WETH!, assetIn: 1, assetOut: 2 }];
    const back = inspectBalancerSwap(buildBalancerSwap(entry, { steps: two, assets: [WBTC, WETH, BAL], amountIn: 99n, minOut: 5n, recipient: USER, deadline: 2_000_000_000 }, 1_000).data)!;
    expect(back.limits).toEqual([99n, 0n, -5n]);
    expect(back.steps.map((s) => s.amount)).toEqual([99n, 0n]);
  });

  it('refuses unsafe or malformed swaps', () => {
    expect(() => buildBalancerSwap(entry, { ...base, minOut: 0n }, 1_000)).toThrow(/minimum/);
    expect(() => buildBalancerSwap(entry, { ...base, amountIn: 0n }, 1_000)).toThrow();
    expect(() => buildBalancerSwap(entry, { ...base, deadline: 5 }, 1_000)).toThrow(/deadline/);
    expect(() => buildBalancerSwap(entry, { ...base, recipient: 'x' }, 1_000)).toThrow();
    expect(() => buildBalancerSwap(entry, { ...base, steps: [] }, 1_000)).toThrow();
    expect(() => buildBalancerSwap(entry, { ...base, steps: [{ poolId: '0x12', assetIn: 0, assetOut: 1 }] }, 1_000)).toThrow(/pool id/);
    expect(() => buildBalancerSwap(entry, { ...base, steps: [{ poolId: P_BAL_WETH!, assetIn: 0, assetOut: 5 }] }, 1_000)).toThrow(/invalid asset/);
    expect(() => buildBalancerSwap(entry, { ...base, steps: [{ poolId: P_BAL_WETH!, assetIn: 1, assetOut: 0 }] }, 1_000)).toThrow(/first asset/);
    expect(() => buildBalancerSwap(entry, { ...base, assets: [BAL, WETH], nativeIn: true }, 1_000)).toThrow(/wrapped/);
    expect(() => buildBalancerSwap(entry, { ...base, nativeIn: true, nativeOut: true }, 1_000)).toThrow();
    expect(() => buildBalancerSwap(entry, { ...base, steps: [{ ...steps[0]!, assetIn: 0, assetOut: 1 }, { poolId: P_WBTC_WETH!, assetIn: 0, assetOut: 2 }], assets: [WETH, BAL, WBTC] }, 1_000)).toThrow(/connect/);
    expect(inspectBalancerSwap('0x12345678')).toBeNull();
  });

  it('property: any swap round-trips through inspection', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 30n }), fc.bigInt({ min: 1n, max: 10n ** 30n }), (amountIn, minOut) => {
        const back = inspectBalancerSwap(buildBalancerSwap(entry, { ...base, amountIn, minOut }, 1_000).data)!;
        return back.steps[0]!.amount === amountIn && back.limits[0] === amountIn && back.limits[1] === -minOut;
      }),
    );
  });

  it('simulation reads the amount out of the returned deltas, and reports reverts', async () => {
    const plan = buildBalancerSwap(entry, { ...base, nativeIn: true }, 1_000);
    expect(await simulateBalancerSwap(async () => encodeParams(['int256[]'], [[5n, -777n]]), plan, USER, 1)).toEqual({ ok: true, amountOut: 777n, error: null });
    expect(await simulateBalancerSwap(async () => { throw new Error('BAL#507 SWAP_LIMIT'); }, plan, USER, 1)).toEqual({ ok: false, amountOut: null, error: 'BAL#507 SWAP_LIMIT' });
  });
});

describe('EvmBalancerAdapter', () => {
  it('asks the Vault which tokens each curated pool holds, ignores ids it does not know, and prices direct and two-hop routes', async () => {
    const e = { ...entry, knownPools: [P_BAL_WETH!, P_WBTC_WETH!, '0x' + 'ab'.repeat(32)] };
    const a = new EvmBalancerAdapter(e, vault(1_234n) as never);
    expect(await a.poolTokens(P_BAL_WETH!)).toEqual([BAL, WETH]);
    expect(await a.poolTokens('0x' + 'ab'.repeat(32))).toBeNull();
    expect(await a.poolTokens('nope')).toBeNull();
    const direct = await a.bestRoute(WETH, BAL, 10n ** 17n);
    expect(direct).toMatchObject({ amountOut: 1_234n });
    expect(direct!.steps).toHaveLength(1);
    const two = await a.bestRoute(WBTC, BAL, 10_000n);
    expect(two!.steps).toHaveLength(2);
    expect(two!.assets).toEqual([WBTC, WETH, BAL]);
    expect(await a.bestRoute(WBTC, '0x' + '9'.repeat(40), 1n)).toBeNull();
  });
  it('rejects bad input and incomplete entries, and returns null when the Vault cannot fill', async () => {
    const a = new EvmBalancerAdapter(entry, vault() as never);
    await expect(a.bestRoute(WETH, WETH, 1n)).rejects.toThrow();
    await expect(a.bestRoute(WETH, '0x12', 1n)).rejects.toThrow();
    await expect(a.bestRoute(WETH, BAL, 0n)).rejects.toThrow();
    expect(() => new EvmBalancerAdapter({ ...entry, router: undefined }, vault() as never)).toThrow();
    const failing = new EvmBalancerAdapter(entry, (async (_: string, p: unknown[]) => { if ((p[0] as { data: string }).data.slice(2, 10) === QUERY) throw new Error('BAL#'); return vault()(_, p); }) as never);
    expect(await failing.bestRoute(WETH, BAL, 1n)).toBeNull();
  });
});

describe('DirectEvmProvider with Balancer', () => {
  it('quotes from the Vault, builds a native-in batchSwap with the venue price re-checked, and blocks when the price moved', async () => {
    let out = 5_000n;
    const read = (async (method: string, params: unknown[]) => {
      if (method === 'eth_blockNumber') return '0x10';
      if (method === 'eth_getBalance') return '0x' + (10n ** 20n).toString(16);
      return vault(out)(method, params);
    }) as never;
    const registry = new AretiaDexRegistry(EVM_DEXES.filter((e) => e.id === 'balancer-v2-ethereum'));
    const p = new DirectEvmProvider({ registry, read: () => read, now: () => 1_000_000 });
    const req: SwapRequest = { chain: 'ethereum', from: { chain: 'ethereum', address: EVM_NATIVE_ADDRESS }, to: { chain: 'ethereum', address: BAL }, amountIn: 10n ** 17n, slippageBps: 100, account: { chain: 'ethereum', address: USER } };
    const q = await p.getQuote(req);
    expect((q.raw as { kind: string }).kind).toBe('balancer');
    expect(q.expectedOut).toBe(5_000n);
    const prepared = await p.buildTransaction(q);
    expect(prepared.simulation.ok).toBe(true);
    const payload = prepared.payload as { swap: { to: string; data: string; value: string } };
    expect(payload.swap.to).toBe(entry.router);
    expect(inspectBalancerSwap(payload.swap.data)!.assets[0]).toBe(BALANCER_NATIVE);
    out = 10n;
    const moved = await p.buildTransaction(q);
    expect(moved.simulation.ok).toBe(false);
    expect(moved.simulation.blockers.join(' ')).toMatch(/price has moved/);
  });
});
