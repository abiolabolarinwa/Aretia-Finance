import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildCurveSwap, EvmCurveAdapter, inspectCurveSwap } from './evmCurve.js';
import { DirectEvmProvider } from './directEvm.js';
import { EVM_CURVE, EVM_DEXES } from './entries.js';
import { AretiaDexRegistry } from '../engine/registry.js';
import { decodeParams, encodeParams } from '../engine/abiGeneric.js';
import { selector } from '../engine/abi.js';
import type { SwapRequest } from '../core/types.js';

const entry = EVM_CURVE.find((e) => e.chain === 'ethereum')!;
const POOL = entry.knownPools![0]!;
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const USER = '0x' + '1'.repeat(40);
const COINS = [DAI, USDC, USDT];

/** A fake 3pool: three coins, a flat 1:1 quote less 4 bps. */
const pool = (opts: { revertQuote?: boolean; dyBps?: bigint } = {}) => async (_: string, params: unknown[]): Promise<unknown> => {
  const c = params[0] as { to: string; data: string };
  const sel = c.data.slice(2, 10);
  if (c.to !== POOL && c.to !== entry.knownPools![1]) throw new Error('unknown pool');
  if (sel === selector('coins(uint256)')) {
    const [i] = decodeParams(['uint256'], '0x' + c.data.slice(10)) as [bigint];
    if (c.to !== POOL || Number(i) >= COINS.length) throw new Error('revert');
    return encodeParams(['address'], [COINS[Number(i)]]);
  }
  if (sel === selector('get_dy(int128,int128,uint256)')) {
    if (opts.revertQuote) throw new Error('revert');
    const [, , dx] = decodeParams(['int128', 'int128', 'uint256'], '0x' + c.data.slice(10)) as [bigint, bigint, bigint];
    return encodeParams(['uint256'], [(dx * (10_000n - (opts.dyBps ?? 4n))) / 10_000n]);
  }
  return '0x';
};

describe('Curve builder and inspector', () => {
  const base = { pool: POOL, i: 0, j: 1, tokenIn: DAI, amountIn: 5n * 10n ** 18n, minOut: 4n * 10n ** 18n };

  it('builds an exchange with an exact approval to the pool and reads back exactly', () => {
    const plan = buildCurveSwap(entry, base);
    expect(plan.to).toBe(POOL);
    expect(plan.value).toBe(0n);
    expect(plan.approval).toEqual({ token: DAI, spender: POOL, amount: 5n * 10n ** 18n });
    expect(inspectCurveSwap(plan.to, plan.data)).toEqual({ pool: POOL, i: 0, j: 1, amountIn: 5n * 10n ** 18n, minOut: 4n * 10n ** 18n });
  });

  it('refuses unsafe swaps, unknown pools and bad indices', () => {
    expect(() => buildCurveSwap(entry, { ...base, minOut: 0n })).toThrow(/minimum/);
    expect(() => buildCurveSwap(entry, { ...base, amountIn: 0n })).toThrow();
    expect(() => buildCurveSwap(entry, { ...base, pool: '0x' + '9'.repeat(40) })).toThrow(/recognises/);
    expect(() => buildCurveSwap(entry, { ...base, i: 1, j: 1 })).toThrow(/indices/);
    expect(() => buildCurveSwap(entry, { ...base, i: -1 })).toThrow();
    expect(() => buildCurveSwap(entry, { ...base, j: 99 })).toThrow();
    expect(() => buildCurveSwap(entry, { ...base, pool: 'x' })).toThrow();
    expect(inspectCurveSwap(POOL, '0x12345678')).toBeNull();
  });

  it('property: any swap round-trips through inspection', () => {
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: 10n ** 30n }), fc.bigInt({ min: 1n, max: 10n ** 30n }), fc.integer({ min: 0, max: 2 }), fc.integer({ min: 3, max: 7 }), (amountIn, minOut, i, j) => {
      const back = inspectCurveSwap(POOL, buildCurveSwap(entry, { ...base, amountIn, minOut, i, j }).data)!;
      return back.amountIn === amountIn && back.minOut === minOut && back.i === i && back.j === j;
    }));
  });
});

describe('EvmCurveAdapter', () => {
  it('reads each pool\'s coins from the pool, finds the indices, and asks the pool what it pays', async () => {
    const a = new EvmCurveAdapter(entry, pool() as never);
    expect(await a.coins(POOL)).toEqual(COINS);
    expect(await a.coins(entry.knownPools![1]!)).toBeNull(); // answers nothing: not a usable pool
    const r = await a.bestRoute(DAI, USDT, 10n ** 18n);
    expect(r).toEqual({ pool: POOL, i: 0, j: 2, amountOut: (10n ** 18n * 9_996n) / 10_000n });
    expect(await a.bestRoute(DAI, '0x' + '9'.repeat(40), 1n)).toBeNull();
  });
  it('returns null when the pool refuses the trade, and rejects bad input', async () => {
    const a = new EvmCurveAdapter(entry, pool({ revertQuote: true }) as never);
    expect(await a.bestRoute(DAI, USDC, 10n ** 18n)).toBeNull();
    await expect(a.bestRoute(DAI, DAI, 1n)).rejects.toThrow();
    await expect(a.bestRoute(DAI, '0x12', 1n)).rejects.toThrow();
    await expect(a.bestRoute(DAI, USDC, 0n)).rejects.toThrow();
    expect(() => new EvmCurveAdapter({ ...entry, mechanism: 'evm-v2-router' }, pool() as never)).toThrow();
  });
});

describe('DirectEvmProvider with Curve', () => {
  const req: SwapRequest = { chain: 'ethereum', from: { chain: 'ethereum', address: DAI }, to: { chain: 'ethereum', address: USDC }, amountIn: 1_000n * 10n ** 18n, slippageBps: 50, account: { chain: 'ethereum', address: USER } };
  const node = (o: { allowance: bigint; dy?: bigint; revertSwap?: boolean }) =>
    (async (method: string, params: unknown[]): Promise<unknown> => {
      if (method === 'eth_blockNumber') return '0x10';
      const c = (params[0] ?? {}) as { to?: string; data?: string };
      const sel = c.data?.slice(2, 10);
      if (sel === selector('balanceOf(address)')) return encodeParams(['uint256'], [10n ** 24n]);
      if (sel === selector('allowance(address,address)')) return encodeParams(['uint256'], [o.allowance]);
      if (c.to === POOL && sel === selector('exchange(int128,int128,uint256,uint256)')) {
        if (o.revertSwap) throw new Error('execution reverted: Exchange resulted in fewer coins than expected');
        return '0x';
      }
      return pool({ dyBps: o.dy })(method, params);
    }) as never;
  const provider = (read: never) => new DirectEvmProvider({ registry: new AretiaDexRegistry(EVM_DEXES.filter((e) => e.id === 'curve-ethereum')), read: () => read, now: () => 1_000_000 });

  it('quotes from the pool, asks for an exact approval to the pool when needed, and builds an inspectable exchange', async () => {
    const p = provider(node({ allowance: 0n }));
    const q = await p.getQuote(req);
    expect((q.raw as { kind: string }).kind).toBe('curve');
    expect(q.expectedOut).toBe((1_000n * 10n ** 18n * 9_996n) / 10_000n);
    const prepared = await p.buildTransaction(q);
    const payload = prepared.payload as { approval: { spender: string; amount: bigint } | null; swap: { to: string; data: string } };
    expect(payload.approval).toMatchObject({ spender: POOL, amount: 1_000n * 10n ** 18n });
    expect(inspectCurveSwap(payload.swap.to, payload.swap.data)).toMatchObject({ i: 0, j: 1, minOut: q.minOut });
    expect(prepared.simulation.ok).toBe(true);
  });

  it('simulates the real exchange once approved, and blocks when the pool rejects it or the price moved', async () => {
    const approved = provider(node({ allowance: 10n ** 30n }));
    const q = await approved.getQuote(req);
    expect((await approved.buildTransaction(q)).simulation.ok).toBe(true);
    const rejecting = provider(node({ allowance: 10n ** 30n, revertSwap: true }));
    const bad = await rejecting.buildTransaction(q);
    expect(bad.simulation.ok).toBe(false);
    expect(bad.simulation.blockers.join(' ')).toMatch(/reject this swap/);
    const moved = provider(node({ allowance: 10n ** 30n, dy: 5_000n }));
    expect((await moved.buildTransaction(q)).simulation.blockers.join(' ')).toMatch(/price has moved/);
  });

  it('does not use Curve for native-coin swaps', async () => {
    const p = provider(node({ allowance: 0n }));
    await expect(p.getQuote({ ...req, from: { chain: 'ethereum', address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' } })).rejects.toMatchObject({ code: 'no-route' });
  });
});
