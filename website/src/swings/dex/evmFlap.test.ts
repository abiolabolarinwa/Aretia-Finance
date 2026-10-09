import { describe, expect, it, vi } from 'vitest';
import { EVM_LAUNCHPADS } from './entries.js';
import { buildFlapSwap, EvmFlapAdapter } from './evmFlap.js';
import { buildLaunchpadSwap, launchpadAdapter } from './evmLaunchpad.js';
import { selector } from '../engine/abi.js';

const entry = EVM_LAUNCHPADS.find((e) => e.id === 'flap-bnb')!;
const fourMeme = EVM_LAUNCHPADS.find((e) => e.id === 'fourmeme-bnb')!;
const TOKEN = '0x41e2b6b065166dba42fe34a0efcbc0571bcf7777';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const word = (v: bigint | string): string => (typeof v === 'bigint' ? v.toString(16) : v.replace(/^0x/, '')).padStart(64, '0');
const join = (...ws: string[]): string => '0x' + ws.join('');
const ZERO = '0x0000000000000000000000000000000000000000';

function stateWords(o: { status?: bigint; quote?: string; short?: boolean } = {}): string {
  const w = Array.from({ length: o.short ? 5 : 18 }, () => word(0n));
  w[0] = word(o.status ?? 1n);
  if (!o.short) w[9] = word(o.quote ?? ZERO);
  return join(...w);
}

function readWith(o: { status?: bigint; quote?: string; short?: boolean; out?: bigint; quoteFails?: boolean } = {}) {
  return vi.fn(async (_m: string, params: unknown[]) => {
    const data = (params[0] as { data: string }).data;
    if (data.startsWith('0x' + selector('getTokenV8Safe(address)'))) return stateWords(o);
    if (data.startsWith('0x' + selector('quoteExactInput((address,address,uint256))'))) {
      if (o.quoteFails) throw new Error('revert');
      return join(word(o.out ?? 555n));
    }
    throw new Error('unexpected call');
  });
}

describe('the Flap venue', () => {
  it('prices a buy and a sell through the Portal', async () => {
    const a = new EvmFlapAdapter(entry, readWith());
    expect(await a.bestRoute(WBNB, TOKEN, 10n ** 16n)).toEqual({ token: TOKEN, buying: true, amountOut: 555n });
    expect(await a.bestRoute(TOKEN, WBNB, 10n ** 18n)).toEqual({ token: TOKEN, buying: false, amountOut: 555n });
  });

  it('offers nothing for a pair without BNB', async () => {
    expect(await new EvmFlapAdapter(entry, readWith()).bestRoute(TOKEN, '0x55d398326f99059ff775485246999027b3197955', 1n)).toBeNull();
  });

  it('refuses a token that has migrated, is priced in another coin, has a short state, or whose quote fails', async () => {
    for (const bad of [{ status: 4n }, { quote: '0x1111111111111111111111111111111111111111' }, { short: true }, { quoteFails: true }, { out: 0n }]) {
      expect(await new EvmFlapAdapter(entry, readWith(bad)).bestRoute(WBNB, TOKEN, 10n ** 16n)).toBeNull();
    }
  });

  it('gives nothing back when the node fails or the token address is malformed', async () => {
    const failing = vi.fn(async () => {
      throw new Error('rpc down');
    });
    expect(await new EvmFlapAdapter(entry, failing).bestRoute(WBNB, TOKEN, 1n)).toBeNull();
    expect(await new EvmFlapAdapter(entry, readWith()).isOpen('0x12')).toBe(false);
  });

  it('builds a buy with BNB attached and a floor, and a sell with an exact approval to the Portal', () => {
    const buy = buildFlapSwap(entry, { token: TOKEN, buying: true, amountIn: 5n, minOut: 3n });
    expect(buy).toMatchObject({ to: entry.router, value: 5n, approval: null });
    expect(buy.data.startsWith('0x' + selector('swapExactInput((address,address,uint256,uint256,bytes))'))).toBe(true);
    // The input is BNB (the zero address), the output is the token, then the amount and the floor.
    expect(buy.data).toContain(word(ZERO) + word(TOKEN) + word(5n) + word(3n));
    const sell = buildFlapSwap(entry, { token: TOKEN, buying: false, amountIn: 7n, minOut: 2n });
    expect(sell).toMatchObject({ to: entry.router, value: 0n, approval: { token: TOKEN, spender: entry.router, amount: 7n } });
    expect(sell.data).toContain(word(TOKEN) + word(ZERO) + word(7n) + word(2n));
  });

  it('refuses to build with a bad token, a zero amount or no floor, and only for a Flap entry', () => {
    expect(() => buildFlapSwap(entry, { token: '0x12', buying: true, amountIn: 1n, minOut: 1n })).toThrow(/Invalid token/);
    expect(() => buildFlapSwap(entry, { token: TOKEN, buying: true, amountIn: 0n, minOut: 1n })).toThrow(/above zero/);
    expect(() => buildFlapSwap(entry, { token: TOKEN, buying: false, amountIn: 1n, minOut: 0n })).toThrow(/minimum/);
    expect(() => buildFlapSwap(fourMeme, { token: TOKEN, buying: true, amountIn: 1n, minOut: 1n })).toThrow(/cannot build Flap/);
    expect(() => new EvmFlapAdapter(fourMeme, readWith())).toThrow(/not a Flap entry/);
  });
});

describe('the launchpad face', () => {
  it('picks the right adapter and builder for each launchpad, and refuses an unknown one', () => {
    expect(launchpadAdapter(entry, readWith())).toBeInstanceOf(EvmFlapAdapter);
    expect(buildLaunchpadSwap(entry, { token: TOKEN, buying: true, amountIn: 1n, minOut: 1n }).data.startsWith('0x' + selector('swapExactInput((address,address,uint256,uint256,bytes))'))).toBe(true);
    expect(buildLaunchpadSwap(fourMeme, { token: TOKEN, buying: true, amountIn: 1n, minOut: 1n }).data.startsWith('0x' + selector('buyTokenAMAP(address,uint256,uint256)'))).toBe(true);
    const unknown = { ...entry, protocol: 'uniswap-v2' as const };
    expect(() => launchpadAdapter(unknown, readWith())).toThrow(/not a launchpad/);
    expect(() => buildLaunchpadSwap(unknown, { token: TOKEN, buying: true, amountIn: 1n, minOut: 1n })).toThrow(/not a launchpad/);
  });
});
