import { describe, expect, it, vi } from 'vitest';
import { EVM_LAUNCHPADS } from './entries.js';
import { buildVirtualsSwap, EvmVirtualsAdapter } from './evmVirtuals.js';
import { buildLaunchpadSwap, launchpadAdapter } from './evmLaunchpad.js';
import { selector } from '../engine/abi.js';

const virtuals = EVM_LAUNCHPADS.find((e) => e.id === 'virtuals-base')!;
const other = EVM_LAUNCHPADS.find((e) => e.protocol === 'flap')!;
const TOKEN = '0x243c68d4bc16a7265031cbf07ead79ba1a9d629c';
const VIRTUAL = virtuals.quoteAsset!;
const ZERO = '0x0000000000000000000000000000000000000000';
const PAIR = '0x9999999999999999999999999999999999999999';
const word = (v: bigint | string): string => (typeof v === 'bigint' ? v.toString(16) : v.replace(/^0x/, '')).padStart(64, '0');
const join = (...ws: string[]): string => '0x' + ws.join('');

describe('the Virtuals venue', () => {
  interface S {
    trading?: bigint;
    launched?: bigint;
    onUniswap?: bigint;
    pair?: string;
    sniper?: bigint;
    buyTax?: bigint;
    sellTax?: bigint;
    out?: bigint;
  }
  const readWith = (s: S = {}) =>
    vi.fn(async (_m: string, params: unknown[]) => {
      const { to, data } = params[0] as { to: string; data: string };
      const is = (sig: string): boolean => data.startsWith('0x' + selector(sig));
      if (is('tokenInfo(address)')) {
        const w = Array.from({ length: 20 }, () => word(0n));
        w[11] = word(s.trading ?? 1n);
        w[12] = word(s.onUniswap ?? 0n);
        w[16] = word(s.launched ?? 1n);
        return join(...w);
      }
      if (is('getPair(address,address)')) return join(word(s.pair ?? PAIR));
      if (is('hasAntiSniperTax(address)')) return join(word(s.sniper ?? 0n));
      if (is('buyTax()')) return join(word(s.buyTax ?? 1n));
      if (is('sellTax()')) return join(word(s.sellTax ?? 1n));
      if (is('getAmountsOut(address,address,uint256)')) return join(word(s.out ?? 1000n));
      throw new Error(`unexpected call to ${to}`);
    });

  it('prices a buy after the router\'s tax and a sell after its tax', async () => {
    const a = new EvmVirtualsAdapter(virtuals, readWith({ out: 1000n, sellTax: 2n }));
    expect(await a.bestRoute(VIRTUAL, TOKEN, 100n)).toEqual({ token: TOKEN, buying: true, amountOut: 1000n });
    // A sell of 1000 is worth 1000 gross; 2% tax leaves 980.
    expect(await a.bestRoute(TOKEN, VIRTUAL, 5n)).toEqual({ token: TOKEN, buying: false, amountOut: 980n });
  });

  it('asks the quoter for the amount left after the buy tax', async () => {
    const read = readWith({ buyTax: 5n });
    await new EvmVirtualsAdapter(virtuals, read).quoteBuy(TOKEN, 1000n);
    const call = read.mock.calls.map((c) => (c[1] as { data: string }[])[0]!.data).find((d) => d.startsWith('0x' + selector('getAmountsOut(address,address,uint256)')))!;
    expect(call.endsWith(word(950n))).toBe(true);
  });

  it('offers nothing for a pair without VIRTUAL', async () => {
    expect(await new EvmVirtualsAdapter(virtuals, readWith()).bestRoute(TOKEN, '0x4200000000000000000000000000000000000006', 5n)).toBeNull();
  });

  it('refuses a token that is not trading, not launched, already on Uniswap, without a pair, or under an anti-sniper tax', async () => {
    for (const bad of [{ trading: 0n }, { launched: 0n }, { onUniswap: 1n }, { pair: ZERO }, { sniper: 1n }, { buyTax: 99n }, { out: 0n }]) {
      expect(await new EvmVirtualsAdapter(virtuals, readWith(bad)).bestRoute(VIRTUAL, TOKEN, 100n)).toBeNull();
    }
  });

  it('gives nothing back when the node fails or the token address is malformed', async () => {
    const failing = vi.fn(async () => {
      throw new Error('rpc down');
    });
    expect(await new EvmVirtualsAdapter(virtuals, failing).bestRoute(VIRTUAL, TOKEN, 1n)).toBeNull();
    expect(await new EvmVirtualsAdapter(virtuals, readWith()).quoteBuy('0x12', 5n)).toBeNull();
  });

  it('builds a buy and a sell with a floor, a deadline and an exact approval to the router', () => {
    const buy = buildVirtualsSwap(virtuals, { token: TOKEN, buying: true, amountIn: 5n, minOut: 3n, deadline: 1234 });
    expect(buy).toMatchObject({ to: virtuals.router, value: 0n, approval: { token: VIRTUAL, spender: virtuals.quoter, amount: 5n } });
    expect(buy.data.startsWith('0x' + selector('buy(uint256,address,uint256,uint256)'))).toBe(true);
    expect(buy.data.endsWith(word(5n) + word(TOKEN) + word(3n) + word(1234n))).toBe(true);
    const sell = buildVirtualsSwap(virtuals, { token: TOKEN, buying: false, amountIn: 7n, minOut: 2n, deadline: 1234 });
    expect(sell.approval).toEqual({ token: TOKEN, spender: virtuals.quoter, amount: 7n });
    expect(sell.data.startsWith('0x' + selector('sell(uint256,address,uint256,uint256)'))).toBe(true);
  });

  it('refuses to build with a bad token, a zero amount, no floor or no deadline, and only for a Virtuals entry', () => {
    const p = { token: TOKEN, buying: true, amountIn: 1n, minOut: 1n, deadline: 5 };
    expect(() => buildVirtualsSwap(virtuals, { ...p, token: '0x12' })).toThrow(/Invalid token/);
    expect(() => buildVirtualsSwap(virtuals, { ...p, amountIn: 0n })).toThrow(/above zero/);
    expect(() => buildVirtualsSwap(virtuals, { ...p, minOut: 0n })).toThrow(/minimum/);
    expect(() => buildVirtualsSwap(virtuals, { ...p, deadline: 0 })).toThrow(/deadline/);
    expect(() => buildVirtualsSwap(other, p)).toThrow(/cannot build Virtuals/);
    expect(() => new EvmVirtualsAdapter(other, readWith())).toThrow(/not a Virtuals entry/);
  });
});

describe('the launchpad face', () => {
  it('picks the right adapter and builder for Virtuals', () => {
    expect(launchpadAdapter(virtuals, vi.fn())).toBeInstanceOf(EvmVirtualsAdapter);
    expect(buildLaunchpadSwap(virtuals, { token: TOKEN, buying: true, amountIn: 1n, minOut: 1n, deadline: 9 }).data.startsWith('0x' + selector('buy(uint256,address,uint256,uint256)'))).toBe(true);
  });
});
