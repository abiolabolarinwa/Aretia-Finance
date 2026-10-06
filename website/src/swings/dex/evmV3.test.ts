import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { buildV3Swap, encodeV3Path, EvmV3Adapter, inspectV3Swap, simulateV3Swap, V3_FEE_TIERS } from './evmV3.js';
import { DirectEvmProvider } from './directEvm.js';
import { EVM_DEXES, EVM_V3_DEXES } from './entries.js';
import { AretiaDexRegistry } from '../engine/registry.js';
import { selector } from '../engine/abi.js';
import { EVM_NATIVE_ADDRESS, type SwapRequest } from '../core/types.js';
import { getAmountOut } from '../engine/amm.js';

const v3 = EVM_V3_DEXES.find((e) => e.id === 'uniswap-v3-base')!;
const v2 = EVM_DEXES.find((e) => e.id === 'uniswap-v2-base')!;
const WETH = v3.wrappedNative!;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
const USER = '0x' + '1'.repeat(40);
const w = (h: string | bigint) => (typeof h === 'bigint' ? h.toString(16) : h.replace('0x', '')).padStart(64, '0');
const POOL = '0x' + 'ee'.repeat(20);

/** A fake node with V3 factory/quoter behaviour for chosen fee tiers. */
function v3Node(opts: { pools?: Record<string, bigint>; revertFees?: number[] } = {}) {
  const pools = opts.pools ?? { '500': 3_000n * 10n ** 6n, '3000': 2_900n * 10n ** 6n };
  const calls: string[] = [];
  const read = vi.fn(async (method: string, params: unknown[]) => {
    const c = (params?.[0] ?? {}) as { to?: string; data?: string };
    if (method === 'eth_blockNumber') return '0x10';
    if (method !== 'eth_call') return '0x';
    const sel = c.data!.slice(2, 10);
    calls.push(sel);
    if (c.to === v3.factory) {
      const fee = Number.parseInt(c.data!.slice(10 + 128, 10 + 192), 16);
      return '0x' + w(String(fee) in pools ? POOL : '0x' + '0'.repeat(40));
    }
    if (c.to === v3.quoter && sel === selector('quoteExactInputSingle((address,address,uint256,uint24,uint160))')) {
      const fee = Number.parseInt(c.data!.slice(10 + 192, 10 + 256), 16);
      if (opts.revertFees?.includes(fee)) throw new Error('execution reverted');
      return '0x' + w(pools[String(fee)] ?? 0n) + w(1n) + w(0n) + w(80_000n);
    }
    return '0x' + w(0n);
  });
  return { read: read as unknown as (m: string, p: unknown[]) => Promise<unknown>, calls };
}

describe('V3 path and calldata', () => {
  it('encodes the V3 path as token, fee, token', () => {
    expect(encodeV3Path([WETH, USDC], [500])).toBe(WETH.slice(2) + '0001f4' + USDC.slice(2));
    expect(() => encodeV3Path([WETH, USDC], [])).toThrow();
    expect(() => encodeV3Path([WETH, USDC], [0])).toThrow();
  });

  it('builds a single-hop native swap that inspects back to the request', () => {
    const plan = buildV3Swap(v3, { tokens: [WETH, USDC], fees: [500], amountIn: 10n ** 17n, minOut: 123_456n, recipient: USER, deadline: 2_000_000_000, nativeIn: true }, 1_000);
    expect(plan.to).toBe(v3.router);
    expect(plan.value).toBe(10n ** 17n);
    expect(plan.approval).toBeNull();
    expect(inspectV3Swap(plan.data)).toEqual({ function: 'exactInputSingle', deadline: 2_000_000_000, tokens: [WETH, USDC], fees: [500], amountIn: 10n ** 17n, minOut: 123_456n, recipient: USER });
  });

  it('builds a two-hop token swap with an exact approval, and inspects it back', () => {
    const plan = buildV3Swap(v3, { tokens: [USDC, WETH, DAI], fees: [500, 3000], amountIn: 5_000_000n, minOut: 7n, recipient: USER, deadline: 2_000_000_000 }, 1_000);
    expect(plan.approval).toEqual({ token: USDC, spender: v3.router, amount: 5_000_000n });
    expect(plan.value).toBe(0n);
    expect(inspectV3Swap(plan.data)).toEqual({ function: 'exactInput', deadline: 2_000_000_000, tokens: [USDC, WETH, DAI], fees: [500, 3000], amountIn: 5_000_000n, minOut: 7n, recipient: USER });
  });

  it('refuses unsafe or malformed swaps', () => {
    const ok = { tokens: [WETH, USDC], fees: [500], amountIn: 5n, minOut: 1n, recipient: USER, deadline: 2_000_000_000 };
    expect(() => buildV3Swap(v3, { ...ok, minOut: 0n }, 1_000)).toThrow(/minimum/);
    expect(() => buildV3Swap(v3, { ...ok, amountIn: 0n }, 1_000)).toThrow();
    expect(() => buildV3Swap(v3, { ...ok, deadline: 5 }, 1_000)).toThrow(/deadline/);
    expect(() => buildV3Swap(v3, { ...ok, recipient: 'x' }, 1_000)).toThrow();
    expect(() => buildV3Swap(v3, { ...ok, fees: [] }, 1_000)).toThrow();
    expect(() => buildV3Swap(v3, { ...ok, tokens: [WETH, WETH] }, 1_000)).toThrow();
    expect(() => buildV3Swap(v3, { ...ok, tokens: [USDC, WETH], nativeIn: true }, 1_000)).toThrow(/wrapped/);
    expect(() => buildV3Swap(v3, { ...ok, tokens: [WETH, USDC, DAI, WETH], fees: [1, 2, 3] }, 1_000)).toThrow();
    expect(inspectV3Swap('0x12345678')).toBeNull();
    expect(inspectV3Swap('0x' + selector('multicall(uint256,bytes[])') + 'zz')).toBeNull();
  });

  it('property: any swap round-trips through inspection', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 30n }), fc.bigInt({ min: 1n, max: 10n ** 30n }), fc.constantFrom(...V3_FEE_TIERS), fc.constantFrom(...V3_FEE_TIERS), fc.boolean(), (amountIn, minOut, f1, f2, twoHop) => {
        const tokens = twoHop ? [USDC, WETH, DAI] : [USDC, DAI];
        const fees = twoHop ? [f1, f2] : [f1];
        const back = inspectV3Swap(buildV3Swap(v3, { tokens, fees, amountIn, minOut, recipient: USER, deadline: 2_000_000_000 }, 1_000).data)!;
        return back.amountIn === amountIn && back.minOut === minOut && back.fees.join() === fees.join() && back.tokens.join() === tokens.join() && back.recipient === USER;
      }),
    );
  });

  it('simulation reads the router return value, and reports reverts', async () => {
    const plan = buildV3Swap(v3, { tokens: [WETH, USDC], fees: [500], amountIn: 5n, minOut: 1n, recipient: USER, deadline: 2_000_000_000, nativeIn: true }, 1_000);
    const ret = '0x' + w(32n) + w(1n) + w(32n) + w(32n) + w(777n);
    expect(await simulateV3Swap(async () => ret, plan, USER)).toEqual({ ok: true, amountOut: 777n, error: null });
    expect(await simulateV3Swap(async () => { throw new Error('execution reverted: Too little received'); }, plan, USER)).toEqual({ ok: false, amountOut: null, error: 'execution reverted: Too little received' });
  });
});

describe('EvmV3Adapter', () => {
  it('asks the venue factory which pools exist and picks the fee tier that pays most', async () => {
    const n = v3Node();
    const route = await new EvmV3Adapter(v3, n.read).bestRoute(WETH, USDC, 10n ** 17n, []);
    expect(route).toMatchObject({ tokens: [WETH, USDC], fees: [500], amountOut: 3_000n * 10n ** 6n, gasEstimate: 80_000n });
  });
  it('skips pools whose quoter reverts and returns null when nothing can fill', async () => {
    const reverting = await new EvmV3Adapter(v3, v3Node({ revertFees: [500] }).read).bestRoute(WETH, USDC, 1n, []);
    expect(reverting?.fees).toEqual([3000]);
    expect(await new EvmV3Adapter(v3, v3Node({ pools: {} }).read).bestRoute(WETH, USDC, 1n, [])).toBeNull();
    expect(await new EvmV3Adapter(v3, v3Node({ revertFees: [500, 3000] }).read).bestRoute(WETH, USDC, 1n, [])).toBeNull();
  });
  it('rejects bad input and incomplete venue entries', async () => {
    const a = new EvmV3Adapter(v3, v3Node().read);
    await expect(a.bestRoute(WETH, WETH, 1n, [])).rejects.toThrow();
    await expect(a.bestRoute(WETH, '0x12', 1n, [])).rejects.toThrow();
    await expect(a.bestRoute(WETH, USDC, 0n, [])).rejects.toThrow();
    expect(() => new EvmV3Adapter({ ...v3, quoter: undefined }, v3Node().read)).toThrow();
    expect(() => new EvmV3Adapter(v2, v3Node().read)).toThrow();
  });
});

describe('DirectEvmProvider chooses between V2 and V3 and explains why', () => {
  // A node that serves both: V2 pays by constant product, V3 by the fake quoter.
  const v2Pair = '0x' + 'cd'.repeat(20);
  const [t0] = BigInt(USDC) < BigInt(WETH) ? [USDC] : [WETH];
  const R_USDC = 2_000_000n * 10n ** 6n;
  const R_WETH = 1_000n * 10n ** 18n;
  const [r0, r1] = t0 === USDC ? [R_USDC, R_WETH] : [R_WETH, R_USDC];
  const v2Out = getAmountOut(10n ** 17n, R_WETH, R_USDC, 3000);

  const node = (v3Pays: bigint) => {
    const inner = v3Node({ pools: { '500': v3Pays } }).read;
    const read = async (method: string, params: unknown[]): Promise<unknown> => {
      const c = (params?.[0] ?? {}) as { to?: string; data?: string };
      if (method === 'eth_blockNumber') return '0x64';
      if (method === 'eth_getBalance') return '0x' + (10n ** 20n).toString(16);
      const sel = c.data?.slice(2, 10);
      if (c.to === v2.factory) return '0x' + w(v2Pair);
      if (c.to === v2Pair && sel === selector('token0()')) return '0x' + w(t0);
      if (c.to === v2Pair && sel === selector('getReserves()')) return '0x' + w(r0) + w(r1) + w(1n);
      if (c.to === v2.router && sel === selector('getAmountsOut(uint256,address[])')) return '0x' + w(32n) + w(2n) + w(10n ** 17n) + w(v2Out);
      if (c.to === v2.router) return '0x' + w(32n) + w(2n) + w(1n) + w(1n);
      if (c.to === v3.quoter && sel === selector('quoteExactInput(bytes,uint256)')) return '0x' + w(v3Pays) + w(1n) + w(0n) + w(80_000n);
      if (c.to === v3.router) return '0x' + w(32n) + w(1n) + w(32n) + w(32n) + w(v3Pays);
      return inner(method, params);
    };
    return read as never;
  };
  const registry = () => new AretiaDexRegistry([v2, v3]);
  const req: SwapRequest = { chain: 'base', from: { chain: 'base', address: EVM_NATIVE_ADDRESS }, to: { chain: 'base', address: USDC }, amountIn: 10n ** 17n, slippageBps: 100, account: { chain: 'base', address: USER } };

  it('picks V3 when it pays more, builds a V3 transaction and keeps the comparison in the reasoning', async () => {
    const p = new DirectEvmProvider({ registry: registry(), read: () => node(v2Out + 50n * 10n ** 6n), now: () => 1_000_000 });
    const q = await p.getQuote(req);
    const raw = q.raw as { kind: string; reasons: string[] };
    expect(raw.kind).toBe('v3');
    expect(q.expectedOut).toBe(v2Out + 50n * 10n ** 6n);
    expect(raw.reasons[0]).toMatch(/Uniswap V3 \(V3, 1 hop\) pays .*Uniswap V2 \(V2, 1 hop\) pays/);
    const prepared = await p.buildTransaction(q);
    expect(prepared.simulation.ok).toBe(true);
    const payload = prepared.payload as { swap: { to: string; data: string } };
    expect(payload.swap.to).toBe(v3.router);
    expect(inspectV3Swap(payload.swap.data)).toMatchObject({ function: 'exactInputSingle', minOut: q.minOut, recipient: USER });
  });

  it('picks V2 when it pays more', async () => {
    const p = new DirectEvmProvider({ registry: registry(), read: () => node(v2Out - 1n), now: () => 1_000_000 });
    const q = await p.getQuote(req);
    expect((q.raw as { kind: string }).kind).toBe('v2');
    expect(q.expectedOut).toBe(v2Out);
  });

  it('never uses V3 when the output is the native coin, and blocks a V3 swap whose simulation pays under the minimum', async () => {
    const p = new DirectEvmProvider({ registry: registry(), read: () => node(10n ** 15n), now: () => 1_000_000 });
    const out = await p.getQuote({ ...req, from: { chain: 'base', address: USDC }, to: { chain: 'base', address: EVM_NATIVE_ADDRESS }, amountIn: 5_000_000n });
    expect((out.raw as { kind: string }).kind).toBe('v2');
  });

  it('still routes when only one venue family answers', async () => {
    const only = new AretiaDexRegistry([v3]);
    const p = new DirectEvmProvider({ registry: only, read: () => node(2_000_000n), now: () => 1_000_000 });
    expect(((await p.getQuote(req)).raw as { kind: string }).kind).toBe('v3');
  });
});
