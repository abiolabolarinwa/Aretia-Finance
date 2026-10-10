import { describe, expect, it } from 'vitest';
import { bestPrices, evmTargets, loadEvmHoldings, unitsToNumber } from './walletEvmHoldings';
import { WRAPPED_NATIVE } from '../swings/dex/entries.js';

const ACCOUNT = '0xd366000000000000000000000000000000007ec2';
const BNB_USDT = '0x55d398326f99059ff775485246999027b3197955';

describe('evmTargets', () => {
  it('lists the native coin first, then the known tokens, and skips Solana', () => {
    const t = evmTargets(['solana', 'bnb']);
    expect(t.every((x) => x.chain === 'bnb')).toBe(true);
    expect(t[0]).toMatchObject({ symbol: 'BNB', native: true, decimals: 18 });
    expect(t.some((x) => x.address === BNB_USDT)).toBe(true);
  });
});

describe('unitsToNumber', () => {
  it('scales by decimals', () => {
    expect(unitsToNumber(62_500_000_000_000_000n, 18)).toBeCloseTo(0.0625, 10);
    expect(unitsToNumber(5_050_000n, 6)).toBeCloseTo(5.05, 10);
  });
});

describe('bestPrices', () => {
  it('takes the deepest pool for each token and ignores bad prices', () => {
    const m = bestPrices([
      { baseToken: { address: '0xAA' }, priceUsd: '1', liquidity: { usd: 10 } },
      { baseToken: { address: '0xaa' }, priceUsd: '2', liquidity: { usd: 99 } },
      { baseToken: { address: '0xbb' }, priceUsd: 'nope' },
    ]);
    expect(m.get('0xaa')).toBe(2);
    expect(m.has('0xbb')).toBe(false);
  });
});

describe('loadEvmHoldings', () => {
  const read = (chain: string) => async (method: string, params: unknown[]) => {
    if (chain !== 'bnb') return '0x0';
    if (method === 'eth_getBalance') return '0x' + (62_500_000_000_000_000n).toString(16); // 0.0625 BNB
    const call = params[0] as { to: string };
    return call.to === BNB_USDT ? '0x' + (3_000_000_000_000_000_000n).toString(16) : '0x0'; // 3 USDT
  };
  const fetchPairs = async (slug: string, addresses: string[]) => {
    expect(slug).toBe('bsc');
    expect(addresses).toContain(WRAPPED_NATIVE.bnb);
    return [
      { baseToken: { address: WRAPPED_NATIVE.bnb }, priceUsd: '750', liquidity: { usd: 1e6 } },
      { baseToken: { address: BNB_USDT }, priceUsd: '1', liquidity: { usd: 1e6 } },
    ];
  };

  it('returns only balances above zero, priced, with the native coin priced via its wrapped token', async () => {
    const rows = await loadEvmHoldings(ACCOUNT, ['ethereum', 'bnb'], { read: read as never, fetchPairs });
    expect(rows.map((r) => r.mint)).toEqual(['bnb:native', `bnb:${BNB_USDT}`]);
    expect(rows[0]).toMatchObject({ symbol: 'BNB', price: 750 });
    expect(rows[0]?.value).toBeCloseTo(46.875, 6);
    expect(rows[1]?.value).toBeCloseTo(3, 6);
  });

  it('keeps balances unpriced when the price feed fails, and drops a network that cannot be read', async () => {
    const flaky = (chain: string) => (chain === 'ethereum' ? async () => { throw new Error('down'); } : read(chain));
    const rows = await loadEvmHoldings(ACCOUNT, ['ethereum', 'bnb'], { read: flaky as never, fetchPairs: async () => { throw new Error('feed down'); } });
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.price === null && r.value === null)).toBe(true);
  });
});
