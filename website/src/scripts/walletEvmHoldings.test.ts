import { describe, expect, it } from 'vitest';
import { bestPrices, evmTargets, extraTargets, loadEvmHoldings, unitsToNumber } from './walletEvmHoldings';
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

describe('tokens named besides the well-known ones', () => {
  const BOUGHT = '0x2546f34438ceedcbd668ad71b77e7767ca3d0000';
  const NOT_HELD = '0x1111111111111111111111111111111111111111';
  const abiString = (text: string): string => {
    const bytes = [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return '0x' + (32).toString(16).padStart(64, '0') + text.length.toString(16).padStart(64, '0') + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0');
  };
  const read = async (method: string, params: unknown[]): Promise<string> => {
    if (method === 'eth_getBalance') return '0x0';
    const call = params[0] as { to: string; data: string };
    if (call.data.startsWith('0x70a08231')) return call.to === BOUGHT ? '0x' + (2_500_000_000_000_000_000n).toString(16) : '0x0';
    if (call.data === '0x313ce567') return '0x12';
    if (call.data === '0x95d89b41') return abiString('SNOW');
    if (call.data === '0x06fdde03') return abiString('Snowball');
    return '0x';
  };

  it('finds a token the caller names when it is held, with its name and decimals read from the contract, and priced', async () => {
    const rows = await loadEvmHoldings(ACCOUNT, ['bnb'], {
      read: (() => read) as never,
      extra: [{ chain: 'bnb', address: BOUGHT.toUpperCase().replace('0X', '0x') }, { chain: 'bnb', address: NOT_HELD }],
      fetchPairs: async (_slug, addresses) => {
        expect(addresses).toContain(BOUGHT);
        return [{ baseToken: { address: BOUGHT }, priceUsd: '0.4', liquidity: { usd: 5e4 } }];
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chain: 'bnb', mint: `bnb:${BOUGHT}`, symbol: 'SNOW', name: 'Snowball', decimals: 18, price: 0.4 });
    expect(rows[0]?.amount).toBeCloseTo(2.5, 9);
    expect(rows[0]?.value).toBeCloseTo(1, 9);
  });

  it('leaves out a named address that is not a token, and keeps going when the contract will not answer', async () => {
    const odd = async (method: string, params: unknown[]): Promise<string> => {
      const call = params[0] as { data: string } | undefined;
      if (method === 'eth_call' && call?.data.startsWith('0x70a08231')) return '0x' + (7n).toString(16);
      if (method === 'eth_call') throw new Error('execution reverted');
      return '0x0';
    };
    const rows = await loadEvmHoldings(ACCOUNT, ['bnb'], { read: (() => odd) as never, extra: [{ chain: 'bnb', address: BOUGHT }], fetchPairs: async () => [] });
    expect(rows.some((r) => r.address === BOUGHT)).toBe(false);
  });

  it('asks only for valid, new tokens on the networks being read', () => {
    const known = evmTargets(['bnb']);
    const hub = known.find((t) => !t.native)!;
    const out = extraTargets(
      [
        { chain: 'bnb', address: BOUGHT },
        { chain: 'bnb', address: BOUGHT.toUpperCase().replace('0X', '0x') },
        { chain: 'bnb', address: hub.address },
        { chain: 'bnb', address: 'not-an-address' },
        { chain: 'bnb', address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
        { chain: 'ethereum', address: NOT_HELD },
        { chain: 'solana', address: 'So11111111111111111111111111111111111111112' },
      ],
      ['bnb', 'solana'],
      known,
    );
    expect(out).toEqual([{ chain: 'bnb', address: BOUGHT }]);
  });
});
