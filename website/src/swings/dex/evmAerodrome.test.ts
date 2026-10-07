import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { buildAerodromeSwap, EvmAerodromeAdapter, inspectAerodromeSwap, type AeroHop } from './evmAerodrome.js';
import { DirectEvmProvider } from './directEvm.js';
import { EVM_AERODROME, EVM_DEXES } from './entries.js';
import { AretiaDexRegistry } from '../engine/registry.js';
import { selector } from '../engine/abi.js';
import { EVM_NATIVE_ADDRESS, type SwapRequest } from '../core/types.js';

const entry = EVM_AERODROME[0]!;
const WETH = entry.wrappedNative!;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
const USER = '0x' + '1'.repeat(40);
const F = entry.factory!;
const w = (h: string | bigint) => (typeof h === 'bigint' ? h.toString(16) : h.replace('0x', '')).padStart(64, '0');
const hop = (from: string, to: string, stable = false): AeroHop => ({ from, to, stable, factory: F });

describe('Aerodrome builder and inspector', () => {
  it('builds native-in, token and native-out swaps and reads them back exactly', () => {
    const native = buildAerodromeSwap(entry, { hops: [hop(WETH, USDC)], amountIn: 10n ** 17n, minOut: 5n, recipient: USER, deadline: 2_000_000_000, nativeIn: true }, 1_000);
    expect(native.value).toBe(10n ** 17n);
    expect(native.approval).toBeNull();
    expect(inspectAerodromeSwap(native.data)).toEqual({ function: 'swapExactETHForTokens', amountIn: null, minOut: 5n, hops: [hop(WETH, USDC)], recipient: USER, deadline: 2_000_000_000 });

    const tokens = buildAerodromeSwap(entry, { hops: [hop(USDC, WETH), hop(WETH, DAI, true)], amountIn: 5_000_000n, minOut: 7n, recipient: USER, deadline: 2_000_000_000 }, 1_000);
    expect(tokens.approval).toEqual({ token: USDC, spender: entry.router, amount: 5_000_000n });
    expect(inspectAerodromeSwap(tokens.data)).toEqual({ function: 'swapExactTokensForTokens', amountIn: 5_000_000n, minOut: 7n, hops: [hop(USDC, WETH), hop(WETH, DAI, true)], recipient: USER, deadline: 2_000_000_000 });

    const out = buildAerodromeSwap(entry, { hops: [hop(USDC, WETH)], amountIn: 9n, minOut: 1n, recipient: USER, deadline: 2_000_000_000, nativeOut: true }, 1_000);
    expect(inspectAerodromeSwap(out.data)?.function).toBe('swapExactTokensForETH');
  });

  it('refuses unsafe or malformed swaps', () => {
    const ok = { hops: [hop(WETH, USDC)], amountIn: 5n, minOut: 1n, recipient: USER, deadline: 2_000_000_000 };
    expect(() => buildAerodromeSwap(entry, { ...ok, minOut: 0n }, 1_000)).toThrow(/minimum/);
    expect(() => buildAerodromeSwap(entry, { ...ok, amountIn: 0n }, 1_000)).toThrow();
    expect(() => buildAerodromeSwap(entry, { ...ok, deadline: 5 }, 1_000)).toThrow(/deadline/);
    expect(() => buildAerodromeSwap(entry, { ...ok, recipient: 'x' }, 1_000)).toThrow();
    expect(() => buildAerodromeSwap(entry, { ...ok, hops: [] }, 1_000)).toThrow();
    expect(() => buildAerodromeSwap(entry, { ...ok, hops: [hop(WETH, WETH)] }, 1_000)).toThrow();
    expect(() => buildAerodromeSwap(entry, { ...ok, hops: [hop(WETH, USDC), hop(DAI, WETH)] }, 1_000)).toThrow(/connect/);
    expect(() => buildAerodromeSwap(entry, { ...ok, hops: [{ ...hop(WETH, USDC), factory: '0x' + '9'.repeat(40) }] }, 1_000)).toThrow(/factory/);
    expect(() => buildAerodromeSwap(entry, { ...ok, hops: [hop(USDC, WETH)], nativeIn: true }, 1_000)).toThrow(/wrapped/);
    expect(() => buildAerodromeSwap(entry, { ...ok, nativeIn: true, nativeOut: true }, 1_000)).toThrow();
    expect(inspectAerodromeSwap('0x12345678')).toBeNull();
    expect(inspectAerodromeSwap('0x' + selector('swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)') + 'zz')).toBeNull();
  });

  it('property: any swap round-trips through inspection', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 30n }), fc.bigInt({ min: 1n, max: 10n ** 30n }), fc.boolean(), fc.boolean(), (amountIn, minOut, stable, twoHop) => {
        const hops = twoHop ? [hop(USDC, WETH, stable), hop(WETH, DAI, !stable)] : [hop(USDC, DAI, stable)];
        const back = inspectAerodromeSwap(buildAerodromeSwap(entry, { hops, amountIn, minOut, recipient: USER, deadline: 2_000_000_000 }, 1_000).data)!;
        return back.amountIn === amountIn && back.minOut === minOut && JSON.stringify(back.hops) === JSON.stringify(hops);
      }),
    );
  });
});

describe('EvmAerodromeAdapter', () => {
  /** A fake router that prices only the routes it is told about. */
  const router = (prices: Record<string, bigint>) =>
    vi.fn(async (_: string, params: unknown[]) => {
      const c = params[0] as { to: string; data: string };
      if (c.to !== entry.router || c.data.slice(2, 10) !== selector('getAmountsOut(uint256,(address,address,bool,address)[])')) throw new Error('unexpected call');
      const body = c.data.slice(10);
      const count = Number(BigInt('0x' + body.slice(64 * 2, 64 * 3)));
      const key: string[] = [];
      for (let i = 0; i < count; i++) {
        const o = 3 + i * 4;
        const addr = (k: number) => '0x' + body.slice(64 * (o + k) + 24, 64 * (o + k) + 64);
        key.push(`${addr(0).slice(2, 6)}>${addr(1).slice(2, 6)}${BigInt('0x' + body.slice(64 * (o + 2), 64 * (o + 3))) === 1n ? 's' : 'v'}`);
      }
      const out = prices[key.join(',')];
      if (out === undefined) throw new Error('pool does not exist');
      return '0x' + w(32n) + w(BigInt(count + 1)) + w(1n) + Array.from({ length: count - 1 }, () => w(1n)).join('') + w(out);
    }) as unknown as (m: string, p: unknown[]) => Promise<unknown>;

  it('asks the router, tries volatile, stable and hub routes, and picks the best', async () => {
    const k = (a: string, b: string, s: 'v' | 's') => `${a.slice(2, 6)}>${b.slice(2, 6)}${s}`;
    const read = router({ [k(WETH, USDC, 'v')]: 1_000n, [k(WETH, USDC, 's')]: 900n, [[k(WETH, DAI, 'v'), k(DAI, USDC, 's')].join(',')]: 1_200n });
    const route = await new EvmAerodromeAdapter(entry, read).bestRoute(WETH, USDC, 10n ** 17n, [DAI]);
    expect(route!.amountOut).toBe(1_200n);
    expect(route!.hops.map((h) => `${h.stable}`)).toEqual(['false', 'true']);
  });
  it('returns null when no pool exists, and rejects bad input', async () => {
    const a = new EvmAerodromeAdapter(entry, router({}));
    expect(await a.bestRoute(WETH, USDC, 1n, [])).toBeNull();
    await expect(a.bestRoute(WETH, WETH, 1n, [])).rejects.toThrow();
    await expect(a.bestRoute(WETH, '0x12', 1n, [])).rejects.toThrow();
    await expect(a.bestRoute(WETH, USDC, 0n, [])).rejects.toThrow();
    expect(() => new EvmAerodromeAdapter({ ...entry, factory: undefined }, router({}))).toThrow();
  });
});

describe('DirectEvmProvider with Aerodrome', () => {
  it('quotes from the router, builds the transaction with the venue price re-checked, and blocks when the price moved', async () => {
    let routerPays = 1_000_000n;
    const read = (async (method: string, params: unknown[]) => {
      if (method === 'eth_blockNumber') return '0x10';
      if (method === 'eth_getBalance') return '0x' + (10n ** 20n).toString(16);
      const c = (params[0] ?? {}) as { to?: string; data?: string };
      if (c.to === entry.router && c.data!.slice(2, 10) === selector('getAmountsOut(uint256,(address,address,bool,address)[])')) return '0x' + w(32n) + w(2n) + w(1n) + w(routerPays);
      if (c.to === entry.router) return '0x' + w(32n) + w(2n) + w(1n) + w(routerPays);
      throw new Error('execution reverted');
    }) as never;
    const registry = new AretiaDexRegistry(EVM_DEXES.filter((e) => e.id === 'aerodrome-base'));
    const p = new DirectEvmProvider({ registry, read: () => read, now: () => 1_000_000 });
    const req: SwapRequest = { chain: 'base', from: { chain: 'base', address: EVM_NATIVE_ADDRESS }, to: { chain: 'base', address: USDC }, amountIn: 10n ** 17n, slippageBps: 100, account: { chain: 'base', address: USER } };
    const q = await p.getQuote(req);
    expect((q.raw as { kind: string }).kind).toBe('aero');
    expect(q.expectedOut).toBe(1_000_000n);
    const prepared = await p.buildTransaction(q);
    expect(prepared.simulation.ok).toBe(true);
    const payload = prepared.payload as { swap: { to: string; data: string } };
    expect(payload.swap.to).toBe(entry.router);
    expect(inspectAerodromeSwap(payload.swap.data)).toMatchObject({ function: 'swapExactETHForTokens', minOut: q.minOut, recipient: USER });
    routerPays = 10n;
    const moved = await p.buildTransaction(q);
    expect(moved.simulation.ok).toBe(false);
    expect(moved.simulation.blockers.join(' ')).toMatch(/price has moved/);
  });
});
