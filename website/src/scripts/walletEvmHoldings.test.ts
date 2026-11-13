import { describe, expect, it } from 'vitest';
import { bestPools, bestPrices, evmTargets, extraTargets, loadEvmHoldings, PRICE_GROUP, unitsToNumber } from './walletEvmHoldings';
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

describe('named tokens are read in batches through Multicall3', () => {
  const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11'.toLowerCase();
  const word = (n: bigint | number): string => BigInt(n).toString(16).padStart(64, '0');
  const abiString = (text: string): string => {
    const hex = [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return word(32) + word(text.length) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  };
  const addr = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
  /** The calls packed into an aggregate3 request: [target, call data without 0x]. */
  const callsOf = (data: string): [string, string][] => {
    const body = data.slice(10);
    const n = Number(BigInt('0x' + body.slice(64, 128)));
    const out: [string, string][] = [];
    for (let i = 0; i < n; i++) {
      const s = 128 + Number(BigInt('0x' + body.slice(128 + i * 64, 192 + i * 64))) * 2;
      const len = Number(BigInt('0x' + body.slice(s + 192, s + 256)));
      out.push(['0x' + body.slice(s + 24, s + 64), body.slice(s + 256, s + 256 + len * 2)]);
    }
    return out;
  };
  /** Multicall3's answer: success and the returned bytes of each call. */
  const answer = (results: (string | null)[]): string => {
    const structs = results.map((r) => (r === null ? word(0) + word(0x40) + word(0) : word(1) + word(0x40) + word(r.length / 2) + r.padEnd(Math.ceil(r.length / 64) * 64, '0')));
    let off = results.length * 32;
    const offsets = structs.map((x) => {
      const o = off;
      off += x.length / 2;
      return word(o);
    });
    return '0x' + word(0x20) + word(results.length) + offsets.join('') + structs.join('');
  };
  const HELD = new Map([
    [addr(7), 5n * 10n ** 18n],
    [addr(100), 3n * 10n ** 6n],
  ]);
  const respond = (calls: [string, string][]): (string | null)[] =>
    calls.map(([target, data]) => {
      if (data.startsWith('70a08231')) return word(HELD.get(target) ?? 0n);
      if (data === '313ce567') return word(target === addr(100) ? 6 : 18);
      if (data === '95d89b41') return abiString(target === addr(100) ? 'SIX' : 'SEVEN');
      if (data === '06fdde03') return abiString(target === addr(100) ? 'Six Token' : 'Seven Token');
      return null;
    });
  const extras = Array.from({ length: 130 }, (_, i) => ({ chain: 'bnb' as const, address: addr(i + 1) }));

  it('asks a batch of 60 tokens in one call and finds the held ones with their names and decimals', async () => {
    const sent: { to: string; calls: number }[] = [];
    const node = async (method: string, params: unknown[]): Promise<string> => {
      if (method === 'eth_getBalance') return '0x0';
      const { to, data } = params[0] as { to: string; data: string };
      if (to.toLowerCase() === MULTICALL) {
        const calls = callsOf(data);
        sent.push({ to, calls: calls.length });
        return answer(respond(calls));
      }
      return '0x0'; // the well-known tokens: not held
    };
    const rows = await loadEvmHoldings(ACCOUNT, ['bnb'], { read: (() => node) as never, extra: extras, fetchPairs: async () => [] });
    const mine = rows.filter((r) => r.address === addr(7) || r.address === addr(100));
    expect(mine.map((r) => [r.symbol, r.name, r.decimals, r.amount])).toEqual([
      ['SEVEN', 'Seven Token', 18, 5],
      ['SIX', 'Six Token', 6, 3],
    ]);
    expect(sent.map((s) => s.calls)).toEqual([240, 240, 40]);
  });

  it('falls back to reading each token alone when the node will not answer a batch', async () => {
    const node = async (method: string, params: unknown[]): Promise<string> => {
      if (method === 'eth_getBalance') return '0x0';
      const { to, data } = params[0] as { to: string; data: string };
      if (to.toLowerCase() === MULTICALL) throw new Error('execution reverted');
      if (data.startsWith('0x70a08231')) return '0x' + word(HELD.get(to) ?? 0n);
      if (data === '0x313ce567') return '0x' + word(18);
      if (data === '0x95d89b41') return '0x' + abiString('SEVEN');
      if (data === '0x06fdde03') return '0x' + abiString('Seven Token');
      return '0x0';
    };
    const rows = await loadEvmHoldings(ACCOUNT, ['bnb'], { read: (() => node) as never, extra: [{ chain: 'bnb', address: addr(7) }, { chain: 'bnb', address: addr(8) }], fetchPairs: async () => [] });
    expect(rows.filter((r) => r.address === addr(7)).map((r) => r.symbol)).toEqual(['SEVEN']);
    expect(rows.some((r) => r.address === addr(8))).toBe(false);
  });

  it('leaves out a token whose decimals are not a sane number', async () => {
    const node = async (method: string, params: unknown[]): Promise<string> => {
      if (method === 'eth_getBalance') return '0x0';
      const { to, data } = params[0] as { to: string; data: string };
      if (to.toLowerCase() !== MULTICALL) return '0x0';
      return answer(callsOf(data).map(([target, d]) => (d.startsWith('70a08231') ? word(1) : d === '313ce567' ? word(999) : abiString(target.slice(-2)))));
    };
    const rows = await loadEvmHoldings(ACCOUNT, ['bnb'], { read: (() => node) as never, extra: [{ chain: 'bnb', address: addr(7) }], fetchPairs: async () => [] });
    expect(rows.some((r) => r.address === addr(7))).toBe(false);
  });
});

describe('pricing a wallet with many tokens', () => {
  const word = (n: bigint | number): string => BigInt(n).toString(16).padStart(64, '0');
  const abiString = (text: string): string => {
    const hex = [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return word(32) + word(text.length) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  };
  const addr = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
  const many = Array.from({ length: 75 }, (_, i) => ({ chain: 'bnb' as const, address: addr(i + 1) }));

  it('asks the market feed for no more than 30 addresses at a time and prices every token, including the last ones', async () => {
    // Every named token is held; the batch read answers for each of them.
    const node = async (method: string, params: unknown[]): Promise<string> => {
      if (method === 'eth_getBalance') return '0x0';
      const { to, data } = params[0] as { to: string; data: string };
      if (to.toLowerCase() !== '0xca11bde05977b3631167028862be2a173976ca11') return '0x0';
      const body = data.slice(10);
      const n = Number(BigInt('0x' + body.slice(64, 128)));
      const results: string[] = [];
      for (let i = 0; i < n; i++) {
        const s = 128 + Number(BigInt('0x' + body.slice(128 + i * 64, 192 + i * 64))) * 2;
        const len = Number(BigInt('0x' + body.slice(s + 192, s + 256)));
        const call = body.slice(s + 256, s + 256 + len * 2);
        const r = call.startsWith('70a08231') ? word(10n ** 18n) : call === '313ce567' ? word(18) : abiString('T');
        results.push(word(1) + word(0x40) + word(r.length / 2) + r);
      }
      let off = n * 32;
      const offsets = results.map((x) => {
        const o = off;
        off += x.length / 2;
        return word(o);
      });
      return '0x' + word(0x20) + word(n) + offsets.join('') + results.join('');
    };
    const asked: number[] = [];
    const fetchPairs = async (_slug: string, addresses: string[]) => {
      asked.push(addresses.length);
      return addresses.map((a) => ({ baseToken: { address: a }, priceUsd: '2', liquidity: { usd: 1e5 } }));
    };
    const rows = await loadEvmHoldings(ACCOUNT, ['bnb'], { read: (() => node) as never, extra: many, fetchPairs });
    expect(Math.max(...asked)).toBeLessThanOrEqual(PRICE_GROUP);
    expect(asked.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(75);
    const named = rows.filter((r) => many.some((m) => m.address === r.address));
    expect(named).toHaveLength(75);
    expect(named.every((r) => r.price === 2 && r.value === 2)).toBe(true);
  });
});

describe('a price from a shallow pool', () => {
  it('is marked thin so it is shown on its row but never added to the total', async () => {
    const SHALLOW = '0x4444444444444444444444444444444444444444';
    const word = (n: bigint | number): string => BigInt(n).toString(16).padStart(64, '0');
    const read = (() => async (method: string, params: unknown[]) => {
      if (method === 'eth_getBalance') return '0x' + (10n ** 18n).toString(16);
      const call = params[0] as { to: string; data: string };
      if (call.to.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11') return '0x';
      if (call.data.startsWith('0x70a08231')) return call.to === SHALLOW ? '0x' + word(1000n * 10n ** 18n) : '0x0';
      if (call.data === '0x313ce567') return '0x' + word(18);
      return '0x';
    }) as never;
    const fetchPairs = async (_s: string, addresses: string[]) => [
      { baseToken: { address: WRAPPED_NATIVE.bnb }, priceUsd: '600', liquidity: { usd: 5e7 } },
      ...(addresses.includes(SHALLOW) ? [{ baseToken: { address: SHALLOW }, priceUsd: '5', liquidity: { usd: 800 } }] : []),
    ];
    const rows = await loadEvmHoldings(ACCOUNT, ['bnb'], { read, extra: [{ chain: 'bnb', address: SHALLOW }], fetchPairs });
    const bnb = rows.find((r) => r.mint === 'bnb:native')!;
    const odd = rows.find((r) => r.address === SHALLOW)!;
    expect(bnb).toMatchObject({ price: 600, thin: false });
    expect(odd).toMatchObject({ price: 5, thin: true });
    expect(odd.value).toBe(5000);
  });
  it('keeps the depth of each pool beside its price', () => {
    const m = bestPools([
      { baseToken: { address: '0xAA' }, priceUsd: '1', liquidity: { usd: 10 } },
      { baseToken: { address: '0xaa' }, priceUsd: '2', liquidity: { usd: 99 } },
    ]);
    expect(m.get('0xaa')).toEqual({ price: 2, liq: 99 });
  });
});
