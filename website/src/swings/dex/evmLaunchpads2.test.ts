import { describe, expect, it, vi } from 'vitest';
import { EVM_LAUNCHPADS } from './entries.js';
import { buildVirtualsSwap, EvmVirtualsAdapter } from './evmVirtuals.js';
import { buildArenaSwap, EvmArenaAdapter } from './evmArena.js';
import { buildLaunchpadSwap, launchpadAdapter } from './evmLaunchpad.js';
import { selector } from '../engine/abi.js';
import { encodeFunction } from '../engine/abiGeneric.js';

const virtuals = EVM_LAUNCHPADS.find((e) => e.id === 'virtuals-base')!;
const arena = EVM_LAUNCHPADS.find((e) => e.id === 'arena-avalanche')!;
const TOKEN = '0x243c68d4bc16a7265031cbf07ead79ba1a9d629c';
const VIRTUAL = virtuals.quoteAsset!;
const ARENA = arena.quoteAsset!;
const ZERO = '0x0000000000000000000000000000000000000000';
const PAIR = '0x9999999999999999999999999999999999999999';
const word = (v: bigint | string): string => (typeof v === 'bigint' ? v.toString(16) : v.replace(/^0x/, '')).padStart(64, '0');
const join = (...ws: string[]): string => '0x' + ws.join('');
const E18 = 10n ** 18n;

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
    expect(() => buildVirtualsSwap(arena, p)).toThrow(/cannot build Virtuals/);
    expect(() => new EvmVirtualsAdapter(arena, readWith())).toThrow(/not a Virtuals entry/);
  });
});

describe('the Arena venue', () => {
  const FIRST = 1000n;
  const NEXT = 1010n;
  interface S {
    lpDeployed?: bigint;
    tokens?: Record<string, string>;
    maxSale?: bigint;
    costPerToken?: bigint;
    reward?: bigint;
    failCost?: boolean;
  }
  /** A launcher with ten tokens, ids 1000 to 1009, the token of id 1005 being TOKEN. */
  function launcher(s: S = {}) {
    const addrOf = (id: bigint): string => (id === 1005n ? TOKEN : '0x' + id.toString(16).padStart(40, '0'));
    const handle = (to: string, data: string): string => {
      const is = (sig: string): boolean => data.startsWith('0x' + selector(sig));
      const arg = (i: number): bigint => BigInt('0x' + data.slice(10 + i * 64, 10 + (i + 1) * 64));
      if (is('tokenIdentifier()')) return join(word(NEXT));
      if (is('INITIAL_TOKEN_ID()')) return join(word(FIRST));
      if (is('tokenParams(uint256)')) {
        const id = arg(0);
        if (id < FIRST || id >= NEXT) throw new Error('revert');
        const w = Array.from({ length: 10 }, () => word(0n));
        w[3] = word(id === 1005n ? (s.lpDeployed ?? 0n) : 0n);
        w[9] = word(addrOf(id));
        return join(...w);
      }
      if (is('getMaxTokensForSale(uint256)')) return join(word((s.maxSale ?? 1000n) * E18));
      if (is('calculateCostWithFees(uint256,uint256)')) {
        if (s.failCost) throw new Error('revert');
        const n = arg(0);
        if (n > (s.maxSale ?? 1000n)) throw new Error('revert');
        return join(word(n * (s.costPerToken ?? 10n)));
      }
      if (is('calculateRewardWithFees(uint256,uint256)')) return join(word(arg(0) * (s.reward ?? 7n)));
      throw new Error(`unexpected call to ${to}`);
    };
    return vi.fn(async (_m: string, params: unknown[]) => {
      const { to, data } = params[0] as { to: string; data: string };
      if (to.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11') {
        // Multicall3: decode the calls and answer each.
        const body = data.slice(10);
        const count = Number(BigInt('0x' + body.slice(64, 128)));
        const results: [boolean, string][] = [];
        const heads = Array.from({ length: count }, (_, i) => Number(BigInt('0x' + body.slice(128 + i * 64, 128 + (i + 1) * 64))));
        for (const h of heads) {
          const start = 128 + h * 2;
          const dataOffset = Number(BigInt('0x' + body.slice(start + 128, start + 192)));
          const len = Number(BigInt('0x' + body.slice(start + dataOffset * 2, start + dataOffset * 2 + 64)));
          const inner = '0x' + body.slice(start + dataOffset * 2 + 64, start + dataOffset * 2 + 64 + len * 2);
          try {
            results.push([true, handle(arena.router!, inner)]);
          } catch {
            results.push([false, '0x']);
          }
        }
        // ABI-encode (bool,bytes)[]
        const enc = (ret: string): string => {
          const bytes = ret.replace(/^0x/, '');
          return word(1n) + word(64n) + word(BigInt(bytes.length / 2)) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0');
        };
        const encodedItems = results.map(([ok, ret]) => (ok ? enc(ret) : word(0n) + word(64n) + word(0n)));
        let offset = results.length * 32;
        const heads2: string[] = [];
        for (const item of encodedItems) {
          heads2.push(word(BigInt(offset)));
          offset += item.length / 2;
        }
        return join(word(32n), word(BigInt(results.length)), ...heads2, ...encodedItems);
      }
      return handle(to, data);
    });
  }

  it('finds a token by its address among the launcher\'s records, and remembers it', async () => {
    const read = launcher();
    const a = new EvmArenaAdapter(arena, read);
    expect(await a.idOf(TOKEN)).toBe(1005n);
    const calls = read.mock.calls.length;
    expect(await a.idOf(TOKEN.toUpperCase().replace('0X', '0x'))).toBe(1005n);
    expect(read.mock.calls.length).toBe(calls);
    expect(await a.idOf('0x000000000000000000000000000000000000dead')).toBeNull();
  });

  it('quotes the most whole tokens a budget buys, and never more than the budget pays for', async () => {
    const a = new EvmArenaAdapter(arena, launcher({ costPerToken: 10n, maxSale: 1000n }));
    const q = await a.quoteBuy(TOKEN, 255n);
    // 10 per token: 255 pays for 25 whole tokens (250), not 26 (260).
    expect(q).toEqual({ amountOut: 25n * E18, ref: '1005' });
    expect(await a.quoteBuy(TOKEN, 9n)).toBeNull();
    expect((await a.quoteBuy(TOKEN, 10n ** 9n))!.amountOut).toBe(1000n * E18);
  });

  it('quotes a sell in whole tokens only', async () => {
    const a = new EvmArenaAdapter(arena, launcher({ reward: 7n }));
    expect(await a.quoteSell(TOKEN, 3n * E18 + 5n)).toEqual({ amountOut: 21n, ref: '1005' });
    expect(await a.quoteSell(TOKEN, E18 - 1n)).toBeNull();
  });

  it('routes ARENA to a token and back, and nothing for another pair', async () => {
    const a = new EvmArenaAdapter(arena, launcher());
    expect((await a.bestRoute(ARENA, TOKEN, 255n))!).toMatchObject({ token: TOKEN, buying: true, ref: '1005' });
    expect((await a.bestRoute(TOKEN, ARENA, 2n * E18))!).toMatchObject({ token: TOKEN, buying: false, ref: '1005' });
    expect(await a.bestRoute(TOKEN, '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7', 2n * E18)).toBeNull();
  });

  it('refuses a token whose liquidity pool is already deployed, or when pricing fails', async () => {
    expect(await new EvmArenaAdapter(arena, launcher({ lpDeployed: 1n })).quoteBuy(TOKEN, 255n)).toBeNull();
    expect(await new EvmArenaAdapter(arena, launcher({ failCost: true })).quoteBuy(TOKEN, 255n)).toBeNull();
  });

  it('builds a buy and a sell in raw units, with the budget as the limit and an exact approval', () => {
    const buy = buildArenaSwap(arena, { token: TOKEN, buying: true, amountIn: 255n, minOut: 24n * E18 + 5n, ref: '1005' });
    expect(buy).toMatchObject({ to: arena.router, value: 0n, approval: { token: ARENA, spender: arena.router, amount: 255n } });
    expect(buy.data).toBe(encodeFunction('buyAndCreateLpIfPossible(uint256,uint256,uint256)', [24n * E18, 1005n, 255n]));
    const sell = buildArenaSwap(arena, { token: TOKEN, buying: false, amountIn: 3n * E18 + 5n, minOut: 21n, ref: '1005' });
    expect(sell.data).toBe(encodeFunction('sell(uint256,uint256,uint256)', [3n * E18, 1005n, 21n]));
    expect(sell.approval).toEqual({ token: TOKEN, spender: arena.router, amount: 3n * E18 });
  });

  it('refuses to build with less than one whole token, a bad id, a zero amount or no floor, and only for an Arena entry', () => {
    const p = { token: TOKEN, buying: true, amountIn: 5n, minOut: 2n * E18, ref: '1005' };
    expect(() => buildArenaSwap(arena, { ...p, minOut: E18 - 1n })).toThrow(/less than one whole token/);
    expect(() => buildArenaSwap(arena, { ...p, buying: false, amountIn: E18 - 1n })).toThrow(/less than one whole token/);
    expect(() => buildArenaSwap(arena, { ...p, ref: 'abc' })).toThrow(/no launcher id/);
    expect(() => buildArenaSwap(arena, { ...p, amountIn: 0n })).toThrow(/above zero/);
    expect(() => buildArenaSwap(arena, { ...p, minOut: 0n })).toThrow(/minimum/);
    expect(() => buildArenaSwap(virtuals, p)).toThrow(/cannot build Arena/);
    expect(() => new EvmArenaAdapter(virtuals, launcher())).toThrow(/not an Arena entry/);
  });
});

describe('the launchpad face', () => {
  it('picks the right adapter and builder for Virtuals and Arena', () => {
    expect(launchpadAdapter(virtuals, vi.fn())).toBeInstanceOf(EvmVirtualsAdapter);
    expect(launchpadAdapter(arena, vi.fn())).toBeInstanceOf(EvmArenaAdapter);
    expect(buildLaunchpadSwap(virtuals, { token: TOKEN, buying: true, amountIn: 1n, minOut: 1n, deadline: 9 }).data.startsWith('0x' + selector('buy(uint256,address,uint256,uint256)'))).toBe(true);
    expect(buildLaunchpadSwap(arena, { token: TOKEN, buying: true, amountIn: 1n, minOut: E18, deadline: 9, ref: '1' }).data.startsWith('0x' + selector('buyAndCreateLpIfPossible(uint256,uint256,uint256)'))).toBe(true);
  });
});
