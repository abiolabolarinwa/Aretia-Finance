import { describe, expect, it } from 'vitest';
import { buildV3Split, EvmV3Adapter, inspectV3Swap, inspectV3Swaps, simulateV3Swap } from './evmV3.js';
import { DirectEvmProvider } from './directEvm.js';
import { EVM_V3_DEXES } from './entries.js';
import { AretiaDexRegistry } from '../engine/registry.js';
import { selector } from '../engine/abi.js';
import { EVM_NATIVE_ADDRESS, type SwapRequest } from '../core/types.js';

const v3 = EVM_V3_DEXES.find((e) => e.id === 'uniswap-v3-base')!;
const WETH = v3.wrappedNative!;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const USER = '0x' + '1'.repeat(40);
const POOL = '0x' + 'ee'.repeat(20);
const w = (h: string | bigint) => (typeof h === 'bigint' ? h.toString(16) : h.replace('0x', '')).padStart(64, '0');

const TRADE = 10n ** 12n;
/** Two pools that both fill at 2 out per 1 in, and lose to the trade's own size: the 0.05% pool less than the 0.3% one. */
const depth: Record<number, bigint> = { 500: 20n * TRADE, 3000: 10n * TRADE };
const payOut = (fee: number, amountIn: bigint): bigint => 2n * amountIn - (2n * amountIn * amountIn) / depth[fee]!;

function node(opts: { depths?: Record<number, bigint> } = {}) {
  const d = opts.depths ?? depth;
  const pay = (fee: number, a: bigint): bigint => 2n * a - (2n * a * a) / d[fee]!;
  return (async (method: string, params: unknown[]): Promise<unknown> => {
    const c = (params?.[0] ?? {}) as { to?: string; data?: string };
    if (method === 'eth_blockNumber') return '0x64';
    if (method === 'eth_getBalance') return '0x' + (10n ** 30n).toString(16);
    const sel = c.data?.slice(2, 10);
    if (c.to === v3.factory) {
      const fee = Number.parseInt(c.data!.slice(10 + 128, 10 + 192), 16);
      return '0x' + w(fee in d ? POOL : '0x' + '0'.repeat(40));
    }
    if (c.to === v3.quoter && sel === selector('quoteExactInputSingle((address,address,uint256,uint24,uint160))')) {
      const amountIn = BigInt('0x' + c.data!.slice(10 + 128, 10 + 192));
      const fee = Number.parseInt(c.data!.slice(10 + 192, 10 + 256), 16);
      return '0x' + w(pay(fee, amountIn)) + w(1n) + w(0n) + w(80_000n);
    }
    if (c.to === v3.quoter && sel === selector('quoteExactInput(bytes,uint256)')) {
      const amountIn = BigInt('0x' + c.data!.slice(10 + 64, 10 + 128));
      const fee = Number.parseInt(c.data!.slice(10 + 192 + 40, 10 + 192 + 46), 16);
      return '0x' + w(pay(fee, amountIn)) + w(1n) + w(0n) + w(80_000n);
    }
    if (c.to === v3.router) {
      const swaps = inspectV3Swaps(c.data!)!;
      const outs = swaps.map((s) => pay(s.fees[0]!, s.amountIn));
      // bytes[]: offset, count, one offset per item, then (length, value) for each
      return '0x' + w(32n) + w(BigInt(outs.length)) + outs.map((_, k) => w(BigInt(32 * outs.length + 64 * k))).join('') + outs.map((o) => w(32n) + w(o)).join('');
    }
    return '0x' + w(0n);
  }) as never;
}

describe('V3 split calldata', () => {
  const legs = [
    { fee: 500, amountIn: 7n * 10n ** 17n, minOut: 111n },
    { fee: 3000, amountIn: 3n * 10n ** 17n, minOut: 55n },
  ];

  it('builds one multicall with an exact total value or approval, and reads every leg back', () => {
    const native = buildV3Split(v3, { tokenIn: WETH, tokenOut: USDC, legs, recipient: USER, deadline: 2_000_000_000, nativeIn: true }, 1_000);
    expect(native.to).toBe(v3.router);
    expect(native.value).toBe(10n ** 18n);
    expect(native.approval).toBeNull();
    const back = inspectV3Swaps(native.data)!;
    expect(back).toHaveLength(2);
    expect(back.map((b) => [b.fees[0], b.amountIn, b.minOut])).toEqual([[500, 7n * 10n ** 17n, 111n], [3000, 3n * 10n ** 17n, 55n]]);
    expect(back.every((b) => b.recipient === USER && b.tokens[0] === WETH && b.tokens[1] === USDC)).toBe(true);
    expect(inspectV3Swap(native.data)).toBeNull(); // not a single swap
    const token = buildV3Split(v3, { tokenIn: USDC, tokenOut: WETH, legs, recipient: USER, deadline: 2_000_000_000 }, 1_000);
    expect(token.approval).toEqual({ token: USDC, spender: v3.router, amount: 10n ** 18n });
    expect(token.value).toBe(0n);
  });

  it('refuses unsafe splits', () => {
    const ok = { tokenIn: USDC, tokenOut: WETH, legs, recipient: USER, deadline: 2_000_000_000 };
    expect(() => buildV3Split(v3, { ...ok, legs: [legs[0]!] }, 1_000)).toThrow(/two to four/);
    expect(() => buildV3Split(v3, { ...ok, legs: [legs[0]!, { ...legs[0]! }] }, 1_000)).toThrow(/different pool/);
    expect(() => buildV3Split(v3, { ...ok, legs: [legs[0]!, { ...legs[1]!, minOut: 0n }] }, 1_000)).toThrow(/minimum/);
    expect(() => buildV3Split(v3, { ...ok, legs: [legs[0]!, { ...legs[1]!, amountIn: 0n }] }, 1_000)).toThrow();
    expect(() => buildV3Split(v3, { ...ok, tokenOut: USDC }, 1_000)).toThrow();
    expect(() => buildV3Split(v3, { ...ok, deadline: 5 }, 1_000)).toThrow(/deadline/);
    expect(() => buildV3Split(v3, { ...ok, nativeIn: true }, 1_000)).toThrow(/wrapped/);
    expect(inspectV3Swaps('0x12345678')).toBeNull();
  });

  it('simulation adds up every leg', async () => {
    const small = [{ fee: 500, amountIn: 7n * 10n ** 11n, minOut: 1n }, { fee: 3000, amountIn: 3n * 10n ** 11n, minOut: 1n }];
    const plan = buildV3Split(v3, { tokenIn: WETH, tokenOut: USDC, legs: small, recipient: USER, deadline: 2_000_000_000, nativeIn: true }, 1_000);
    const sim = await simulateV3Swap(node(), plan, USER);
    expect(sim).toEqual({ ok: true, amountOut: payOut(500, 7n * 10n ** 11n) + payOut(3000, 3n * 10n ** 11n), error: null });
  });

  it('the adapter lists each existing tier on its own, best first', async () => {
    const tiers = await new EvmV3Adapter(v3, node()).tierQuotes(WETH, USDC, TRADE);
    expect(tiers.map((t) => t.fees[0])).toEqual([500, 3000]);
    expect(tiers[0]!.amountOut).toBe(payOut(500, TRADE));
  });
});

describe('DirectEvmProvider splits a large V3 trade between fee tiers', () => {
  const req: SwapRequest = { chain: 'base', from: { chain: 'base', address: EVM_NATIVE_ADDRESS }, to: { chain: 'base', address: USDC }, amountIn: TRADE, slippageBps: 100, account: { chain: 'base', address: USER } };
  const provider = (read: never) => new DirectEvmProvider({ registry: new AretiaDexRegistry([v3]), read: () => read, now: () => 1_000_000 });

  it('quotes the split, with a floor on each leg, builds one multicall and simulates the sum', async () => {
    const p = provider(node());
    const q = await p.getQuote(req);
    const raw = q.raw as { v3split?: { fee: number; amountIn: bigint; minOut: bigint }[]; reasons: string[] };
    expect(raw.v3split).toHaveLength(2);
    expect(raw.v3split!.reduce((n, l) => n + l.amountIn, 0n)).toBe(TRADE);
    expect(q.expectedOut).toBeGreaterThan(payOut(500, TRADE));
    expect(raw.v3split!.every((l) => l.minOut > 0n)).toBe(true);
    expect(q.route.legs.map((l) => l.shareBps).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(9_999);
    expect(raw.reasons.join(' ')).toMatch(/split between the/);
    const prepared = await p.buildTransaction(q);
    expect(prepared.simulation.blockers).toEqual([]);
    const payload = prepared.payload as { swap: { to: string; data: string; value: string } };
    expect(payload.swap.to).toBe(v3.router);
    expect(BigInt(payload.swap.value)).toBe(TRADE);
    const swaps = inspectV3Swaps(payload.swap.data)!;
    expect(swaps).toHaveLength(2);
    expect(swaps.reduce((n, s) => n + s.amountIn, 0n)).toBe(TRADE);
    expect(swaps.reduce((n, s) => n + s.minOut, 0n)).toBeGreaterThanOrEqual(q.minOut - 2n);
  });

  it('does not split a small trade, or when only one pool exists', async () => {
    const small = await provider(node()).getQuote({ ...req, amountIn: TRADE / 1000n });
    expect((small.raw as { v3split?: unknown }).v3split).toBeUndefined();
    const one = await provider(node({ depths: { 500: depth[500]! } })).getQuote(req);
    expect((one.raw as { v3split?: unknown }).v3split).toBeUndefined();
  });

  it('blocks the swap when the venue price has moved since the quote', async () => {
    const q = await provider(node()).getQuote(req);
    const moved = await provider(node({ depths: { 500: 2n * TRADE, 3000: 2n * TRADE } })).buildTransaction(q);
    expect(moved.simulation.ok).toBe(false);
    expect(moved.simulation.blockers.join(' ')).toMatch(/price has moved|less than your minimum/);
  });
});
