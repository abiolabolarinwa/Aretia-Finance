import { describe, expect, it, vi } from 'vitest';
import { EVM_LAUNCHPADS } from './entries.js';
import { buildFourMemeSwap, EvmFourMemeAdapter } from './evmFourMeme.js';
import { selector } from '../engine/abi.js';

const entry = EVM_LAUNCHPADS.find((e) => e.id === 'fourmeme-bnb')!;
const TOKEN = '0x72b6ab07a4d728bee625e89fc5a7dabe3210ffff';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const word = (v: bigint | string): string => (typeof v === 'bigint' ? v.toString(16) : v.replace(/^0x/, '')).padStart(64, '0');
const join = (...ws: string[]): string => '0x' + ws.join('');
const ZERO = '0x0000000000000000000000000000000000000000';

interface Setup {
  manager?: string;
  quote?: string;
  liquidityAdded?: boolean;
  offers?: bigint;
  helperManager?: string;
  out?: bigint;
}

function readWith(s: Setup = {}) {
  const manager = s.manager ?? entry.router!;
  return vi.fn(async (_m: string, params: unknown[]) => {
    const data = (params[0] as { data: string }).data;
    if (data.startsWith('0x' + selector('getTokenInfo(address)'))) return join(word(2n), word(manager), word(s.quote ?? ZERO), word(1n), word(100n), word(0n), word(0n), word(s.offers ?? 5n), word(8n), word(1n), word(9n), word(s.liquidityAdded ? 1n : 0n));
    if (data.startsWith('0x' + selector('tryBuy(address,uint256,uint256)')) || data.startsWith('0x' + selector('trySell(address,uint256)'))) return join(word(s.helperManager ?? entry.router!), word(ZERO), word(s.out ?? 777n), word(1n));
    throw new Error('unexpected call');
  });
}

describe('the Four.meme venue', () => {
  it('prices a buy and a sell through the launchpad helper', async () => {
    const a = new EvmFourMemeAdapter(entry, readWith());
    expect(await a.bestRoute(WBNB, TOKEN, 10n ** 16n)).toEqual({ token: TOKEN, buying: true, amountOut: 777n });
    expect(await a.bestRoute(TOKEN, WBNB, 10n ** 18n)).toEqual({ token: TOKEN, buying: false, amountOut: 777n });
  });

  it('offers nothing for a pair without BNB', async () => {
    const a = new EvmFourMemeAdapter(entry, readWith());
    expect(await a.bestRoute(TOKEN, '0x55d398326f99059ff775485246999027b3197955', 1n)).toBeNull();
  });

  it('refuses curves that are closed, priced in another coin, managed by another contract or answered by another one', async () => {
    for (const bad of [{ liquidityAdded: true }, { quote: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82' }, { manager: '0x1111111111111111111111111111111111111111' }, { offers: 0n }, { helperManager: '0x1111111111111111111111111111111111111111' }, { out: 0n }]) {
      expect(await new EvmFourMemeAdapter(entry, readWith(bad)).bestRoute(WBNB, TOKEN, 10n ** 16n)).toBeNull();
    }
  });

  it('gives nothing back when the helper fails, or for a malformed token address', async () => {
    const failing = vi.fn(async () => {
      throw new Error('rpc down');
    });
    expect(await new EvmFourMemeAdapter(entry, failing).bestRoute(WBNB, TOKEN, 1n)).toBeNull();
    expect(await new EvmFourMemeAdapter(entry, readWith()).info('0x12')).toBeNull();
  });

  it('builds a buy that sends the BNB with a floor, and a sell with a floor and an exact approval', () => {
    const buy = buildFourMemeSwap(entry, { token: TOKEN, buying: true, amountIn: 5n, minOut: 3n });
    expect(buy).toMatchObject({ to: entry.router, value: 5n, approval: null });
    expect(buy.data.startsWith('0x' + selector('buyTokenAMAP(address,uint256,uint256)'))).toBe(true);
    const sell = buildFourMemeSwap(entry, { token: TOKEN, buying: false, amountIn: 7n, minOut: 2n });
    expect(sell).toMatchObject({ to: entry.router, value: 0n, approval: { token: TOKEN, spender: entry.router, amount: 7n } });
    expect(sell.data.startsWith('0x' + selector('sellToken(uint256,address,uint256,uint256,uint256,address)'))).toBe(true);
    // The floor and the amount are in the call data.
    expect(sell.data).toContain(word(7n));
    expect(sell.data).toContain(word(2n));
  });

  it('refuses to build with a bad token, a zero amount or no floor', () => {
    expect(() => buildFourMemeSwap(entry, { token: '0x12', buying: true, amountIn: 1n, minOut: 1n })).toThrow(/Invalid token/);
    expect(() => buildFourMemeSwap(entry, { token: TOKEN, buying: true, amountIn: 0n, minOut: 1n })).toThrow(/above zero/);
    expect(() => buildFourMemeSwap(entry, { token: TOKEN, buying: false, amountIn: 1n, minOut: 0n })).toThrow(/minimum/);
  });
});
