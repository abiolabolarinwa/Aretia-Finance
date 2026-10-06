import { describe, expect, it, vi } from 'vitest';
import { DirectEvmProvider } from './directEvm.js';
import { EVM_V2_DEXES } from './entries.js';
import { AretiaRouter } from '../router/router.js';
import { AretiaDexRegistry } from '../engine/registry.js';
import { selector, decodeUintArray } from '../engine/abi.js';
import { inspectV2Swap } from '../execution/evmV2Builder.js';
import { EVM_NATIVE_ADDRESS, type SwapRequest } from '../core/types.js';
import { getAmountOut } from '../engine/amm.js';

const entry = EVM_V2_DEXES.find((e) => e.id === 'uniswap-v2-base')!;
const WETH = entry.wrappedNative!;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const USER = '0x' + '1'.repeat(40);
const PAIR = '0x' + 'cd'.repeat(20);
const word = (v: bigint | string) => (typeof v === 'bigint' ? v.toString(16) : v.replace('0x', '')).padStart(64, '0');
const token0 = BigInt(USDC) < BigInt(WETH) ? USDC : WETH;
const R_USDC = 2_000_000n * 10n ** 6n;
const R_WETH = 1_000n * 10n ** 18n;
const [r0, r1] = token0 === USDC ? [R_USDC, R_WETH] : [R_WETH, R_USDC];

interface Opts {
  routerPays?: (amountIn: bigint) => bigint;
  balance?: bigint;
  allowance?: bigint;
  nativeBalance?: bigint;
  failSwap?: boolean;
  noPair?: boolean;
}

/** A fake node that behaves like Uniswap V2 on Base for one WETH/USDC pair. */
function node(o: Opts = {}) {
  const calls: { method: string; to?: string; sel?: string }[] = [];
  const read = vi.fn(async (method: string, params: unknown[]) => {
    const call = (params?.[0] ?? {}) as { to?: string; data?: string };
    const sel = call.data?.slice(2, 10);
    calls.push({ method, to: call.to, sel });
    if (method === 'eth_blockNumber') return '0x64';
    if (method === 'eth_getBalance') return '0x' + (o.nativeBalance ?? 10n ** 20n).toString(16);
    if (call.to === entry.factory) return o.noPair ? '0x' + word(0n) : '0x' + word(PAIR);
    if (call.to === PAIR && sel === selector('token0()')) return '0x' + word(token0);
    if (call.to === PAIR && sel === selector('getReserves()')) return '0x' + word(r0) + word(r1) + word(1n);
    if (call.to === entry.router && sel === selector('getAmountsOut(uint256,address[])')) {
      const amountIn = BigInt('0x' + call.data!.slice(10, 74));
      const out = o.routerPays ? o.routerPays(amountIn) : getAmountOut(amountIn, token0 === USDC ? r0 : r1, token0 === USDC ? r1 : r0, 3000);
      return '0x' + word(32n) + word(2n) + word(amountIn) + word(out);
    }
    if (sel === selector('balanceOf(address)')) return '0x' + word(o.balance ?? 10n ** 12n);
    if (sel === selector('allowance(address,address)')) return '0x' + word(o.allowance ?? 0n);
    if (call.to === entry.router && sel !== undefined && inspectV2Swap(call.data!)) {
      if (o.failSwap) throw new Error('execution reverted: UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT');
      return '0x' + word(32n) + word(2n) + word(1n) + word(1n);
    }
    return '0x' + word(0n);
  });
  return { read: read as unknown as (m: string, p: unknown[]) => Promise<unknown>, calls };
}

const provider = (o: Opts = {}) => {
  const n = node(o);
  const registry = new AretiaDexRegistry([entry]);
  return { p: new DirectEvmProvider({ registry, read: () => n.read as never, now: () => 1_000_000 }), registry, n };
};
const req = (over: Partial<SwapRequest> = {}): SwapRequest => ({ chain: 'base', from: { chain: 'base', address: EVM_NATIVE_ADDRESS }, to: { chain: 'base', address: USDC }, amountIn: 10n ** 17n, slippageBps: 100, account: { chain: 'base', address: USER }, ...over });

describe('DirectEvmProvider (Aretia router for EVM)', () => {
  it('quotes from pools it read itself, with the local maths, and no aggregator call', async () => {
    const { p, n } = provider();
    const q = await p.getQuote(req());
    expect(q.providerId).toBe('aretia');
    expect(q.expectedOut).toBe(getAmountOut(10n ** 17n, R_WETH, R_USDC, 3000));
    expect(q.minOut).toBe((q.expectedOut * 9900n) / 10_000n);
    expect(q.route.legs[0]!.venue).toBe('Uniswap V2');
    expect(q.priceImpactBps).toBeGreaterThan(0);
    expect(n.calls.every((c) => c.method === 'eth_call' || c.method === 'eth_blockNumber')).toBe(true);
  });

  it('builds an inspectable native-in transaction that matches the quote and carries no approval', async () => {
    const { p } = provider();
    const q = await p.getQuote(req());
    const prepared = await p.buildTransaction(q);
    expect(prepared.simulation).toMatchObject({ ok: true });
    const payload = prepared.payload as { approval: unknown; swap: { to: string; data: string; value: string } };
    expect(payload.approval).toBeNull();
    expect(payload.swap.to).toBe(entry.router);
    expect(payload.swap.value).toBe('0x' + (10n ** 17n).toString(16));
    expect(inspectV2Swap(payload.swap.data)).toMatchObject({ function: 'swapExactETHForTokens', minOut: q.minOut, path: [WETH, USDC], recipient: USER });
  });

  it('asks for an exact-amount approval when the allowance is short, and says simulation waits for it', async () => {
    const { p } = provider({ allowance: 0n });
    const q = await p.getQuote(req({ from: { chain: 'base', address: USDC }, to: { chain: 'base', address: EVM_NATIVE_ADDRESS }, amountIn: 5_000_000n }));
    const prepared = await p.buildTransaction(q);
    const payload = prepared.payload as { approval: { amount: bigint; spender: string } | null };
    expect(payload.approval).toMatchObject({ amount: 5_000_000n, spender: entry.router });
    expect(prepared.simulation.warnings.join(' ')).toMatch(/approval/i);
    expect(prepared.simulation.ok).toBe(true);
  });

  it('simulates the real swap when the allowance already covers it, and blocks on a revert', async () => {
    const { p } = provider({ allowance: 10n ** 12n, failSwap: true });
    const q = await p.getQuote(req({ from: { chain: 'base', address: USDC }, to: { chain: 'base', address: WETH }, amountIn: 5_000_000n }));
    const prepared = await p.buildTransaction(q);
    expect(prepared.simulation.ok).toBe(false);
    expect(prepared.simulation.blockers.join(' ')).toMatch(/reject this swap/);
  });

  it('blocks when the router would now pay less than the minimum (price moved)', async () => {
    const { p } = provider({ routerPays: () => 1n });
    const q = await p.getQuote(req());
    const prepared = await p.buildTransaction(q);
    expect(prepared.simulation.ok).toBe(false);
    expect(prepared.simulation.blockers.join(' ')).toMatch(/price has moved/);
  });

  it('blocks on insufficient balances, token or native', async () => {
    const tok = provider({ balance: 1n });
    const q1 = await tok.p.getQuote(req({ from: { chain: 'base', address: USDC }, to: { chain: 'base', address: WETH }, amountIn: 5_000_000n }));
    expect((await tok.p.buildTransaction(q1)).simulation.blockers.join(' ')).toMatch(/balance is too low/);
    const nat = provider({ nativeBalance: 1n });
    const q2 = await nat.p.getQuote(req());
    expect((await nat.p.buildTransaction(q2)).simulation.blockers.join(' ')).toMatch(/ETH balance is too low/);
  });

  it('refuses to build after the quote expires, for a removed venue, or for another provider', async () => {
    const { p, registry } = provider();
    const q = await p.getQuote(req());
    const late = new DirectEvmProvider({ registry, read: () => node().read as never, now: () => 1_000_000 + 60_000 });
    await expect(late.buildTransaction(q)).rejects.toMatchObject({ code: 'expired' });
    registry.remove(entry.id);
    await expect(p.buildTransaction(q)).rejects.toMatchObject({ code: 'invalid' });
    await expect(p.buildTransaction({ ...q, providerId: '0x' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('reports no route when the venue has no pair, rejects wrapping, bad tokens and zero amounts', async () => {
    await expect(provider({ noPair: true }).p.getQuote(req())).rejects.toMatchObject({ code: 'no-route' });
    const { p } = provider();
    await expect(p.getQuote(req({ to: { chain: 'base', address: WETH } }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(p.getQuote(req({ to: { chain: 'base', address: '0x12' } }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(p.getQuote(req({ amountIn: 0n }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(p.getQuote(req({ chain: 'solana' }))).rejects.toThrow();
  });

  it('does not support a chain whose venues are in maintenance', () => {
    const { p, registry } = provider();
    expect(p.supports('base')).toBe(true);
    expect(p.supports('solana')).toBe(false);
    registry.setStatus(entry.id, 'MAINTENANCE');
    expect(p.supports('base')).toBe(false);
  });

  it('runs end to end through the router with no aggregator: quote, build, confirm once, track', async () => {
    const { p } = provider();
    const sent: unknown[] = [];
    const adapter = { chain: 'base' as const, getBalance: async () => 0n, getStatus: async () => 'confirmed' as const, signAndSubmit: async () => { sent.push(1); return '0x' + 'ab'.repeat(32); } };
    const router = new AretiaRouter({ providers: [p], adapters: [adapter], isChainEnabled: () => true, now: () => 1_000_001 });
    const quote = await router.getQuote(req());
    const prepared = await router.buildTransaction(quote);
    const ex = await router.executeRoute(prepared, quote, { quoteId: quote.id, confirmed: true });
    expect(ex.status).toBe('submitted');
    expect(sent).toHaveLength(1);
    await expect(router.executeRoute(prepared, quote, { quoteId: quote.id, confirmed: true })).rejects.toMatchObject({ code: 'invalid' });
    expect(decodeUintArray('0x' + word(32n) + word(1n) + word(7n))).toEqual([7n]);
  });
});
