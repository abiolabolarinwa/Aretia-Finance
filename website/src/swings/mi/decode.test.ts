import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeCreation, decodeSwap, logMeta, tradeOf } from './decode.js';
import { allSpecs, TOPICS } from './dexes.js';
import { addrTopic, pairCreatedLog, poolCreatedLog, v2SwapLog, v3SwapLog, word } from './testkit.js';

interface Fixture {
  error?: string;
  factoryLogs?: unknown[];
  swapLogs?: unknown[];
  pool?: { address: string; token0: string; token1: string; decimals0: number; decimals1: number };
}
const dir = join(process.cwd(), 'src/swings/mi/fixtures');
const fixtures = JSON.parse(readFileSync(join(dir, 'real-logs.json'), 'utf8')) as Record<string, Fixture>;

/** Runs the decoders over a spec's real logs; what they achieved is the evidence level that spec has earned. */
function evidenceFor(id: string): { creations: number; swaps: number; trades: number } {
  const spec = allSpecs().find((s) => s.id === id)!;
  const f = fixtures[id];
  if (!f || f.error) return { creations: 0, swaps: 0, trades: 0 };
  const creations = (f.factoryLogs ?? []).filter((l) => decodeCreation(l, spec.kind, spec.factory) !== null).length;
  let swaps = 0;
  let trades = 0;
  for (const l of f.swapLogs ?? []) {
    const s = decodeSwap(l, spec.kind, spec.swapTopic);
    if (!s || !f.pool || s.pool !== f.pool.address.toLowerCase()) continue;
    swaps++;
    const t = tradeOf({ chain: spec.chain, address: s.pool, baseIsToken0: true, baseDecimals: f.pool.decimals0, quoteDecimals: f.pool.decimals1 }, s, 1_700_000_000);
    if (t && Number(t.price) > 0) trades++;
  }
  return { creations, swaps, trades };
}

describe('decoders on real captured logs', () => {
  for (const spec of allSpecs()) {
    const f = fixtures[spec.id];
    it(`${spec.id}: every captured log decodes exactly, none is rejected`, () => {
      expect(f, 'run scripts/capture-mi-fixtures.mjs').toBeDefined();
      expect(f!.error).toBeUndefined();
      for (const l of f!.factoryLogs ?? []) {
        const c = decodeCreation(l, spec.kind, spec.factory);
        expect(c, 'creation log').not.toBeNull();
        expect(c!.pool).toMatch(/^0x[0-9a-f]{40}$/);
        expect(c!.token0).not.toBe(c!.token1);
        if (spec.kind === 'v3') expect(c!.feeTier).toBeGreaterThan(0);
      }
      for (const l of f!.swapLogs ?? []) {
        const s = decodeSwap(l, spec.kind, spec.swapTopic);
        expect(s, 'swap log').not.toBeNull();
        expect(s!.net0 === 0n && s!.net1 === 0n).toBe(false);
      }
    });
  }

  it('the evidence file matches what the fixtures prove (both creation and swap decode, with a priced trade)', () => {
    const earned: Record<string, string> = {};
    for (const s of allSpecs()) {
      const e = evidenceFor(s.id);
      if (e.creations > 0 && e.swaps > 0 && e.trades > 0) earned[s.id] = 'fixture-tested';
    }
    const file = join(dir, 'evidence.json');
    if (process.env.MI_WRITE_SPECS === '1') writeFileSync(file, JSON.stringify(earned, null, 1));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(earned);
    // Never claims what was not captured.
    expect(Object.keys(earned).length).toBeGreaterThan(15);
  });

  it('prices real swaps plausibly: the busy wrapped-native pools price at a sensible dollar value', () => {
    for (const id of ['pancakeswap-v2-bnb', 'uniswap-v2-ethereum', 'uniswap-v3-ethereum', 'pancakeswap-v3-bnb']) {
      const spec = allSpecs().find((s) => s.id === id)!;
      const f = fixtures[id]!;
      const s = decodeSwap(f.swapLogs![0], spec.kind, spec.swapTopic)!;
      // token0/token1 of these pools are one wrapped native and one dollar token in some order; the base is the wrapped native one.
      const nativeIs0 = ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'].includes(f.pool!.token0.toLowerCase());
      const t = tradeOf({ chain: spec.chain, address: s.pool, baseIsToken0: nativeIs0, baseDecimals: nativeIs0 ? f.pool!.decimals0 : f.pool!.decimals1, quoteDecimals: nativeIs0 ? f.pool!.decimals1 : f.pool!.decimals0 }, s, 1_700_000_000)!;
      expect(t).not.toBeNull();
      const price = Number(t.price);
      // ETH and BNB are worth between $50 and $20,000 each; a wrong decimal or direction would be off by orders of magnitude.
      expect(price).toBeGreaterThan(50);
      expect(price).toBeLessThan(20_000);
    }
  });
});

describe('decoders reject what is not exactly right', () => {
  const factory = '0x' + 'f0'.repeat(20);
  const block = { blockNumber: '0x10', blockHash: '0x' + '1'.repeat(64), transactionHash: '0x' + '2'.repeat(64), logIndex: '0x0' };
  const full = (l: { address: string; topics: string[]; data: string }, extra: object = {}) => ({ ...l, ...block, ...extra });
  const T0 = '0x' + 'a1'.repeat(20);
  const T1 = '0x' + 'b2'.repeat(20);
  const P = '0x' + 'c3'.repeat(20);

  it('accepts a well-formed creation and rejects wrong factory, wrong topic, reorg-removed and dirty address words', () => {
    const good = full(pairCreatedLog(factory, T0, T1, P));
    expect(decodeCreation(good, 'v2', factory)!.pool).toBe(P);
    expect(decodeCreation(good, 'v2', '0x' + 'e0'.repeat(20))).toBeNull();
    expect(decodeCreation(good, 'v3', factory)).toBeNull();
    expect(decodeCreation({ ...good, removed: true }, 'v2', factory)).toBeNull();
    expect(decodeCreation({ ...good, topics: [good.topics[0], '0x' + 'ff'.repeat(32), good.topics[2]] }, 'v2', factory)).toBeNull();
    expect(decodeCreation({ ...good, data: '0x' + 'ff'.repeat(32) + word(1n) }, 'v2', factory)).toBeNull();
    expect(decodeCreation({ ...good, data: '0x1234' }, 'v2', factory)).toBeNull();
    expect(decodeCreation(null, 'v2', factory)).toBeNull();
    expect(decodeCreation({ ...good, blockHash: 'nope' }, 'v2', factory)).toBeNull();
  });

  it('decodes V3 PoolCreated with its fee tier', () => {
    const c = decodeCreation(full(poolCreatedLog(factory, T0, T1, 3000, P)), 'v3', factory)!;
    expect([c.token0, c.token1, c.pool, c.feeTier]).toEqual([T0, T1, P, 3000]);
  });

  it('turns V2 and V3 swaps into the right side, amounts and price', () => {
    const pool = { chain: 'bnb' as const, address: P, baseIsToken0: true, baseDecimals: 18, quoteDecimals: 6 };
    const buyV2 = decodeSwap(full(v2SwapLog(P, { in1: 3_000_000n, out0: 10n ** 18n }, T1)), 'v2', TOPICS.v2Swap)!;
    expect(tradeOf(pool, buyV2, 1_700_000_000)).toMatchObject({ side: 'buy', price: '3', baseAmount: (10n ** 18n).toString(), quoteAmount: '3000000' });
    const sellV3 = decodeSwap(full(v3SwapLog(P, 2n * 10n ** 18n, -6_000_000n, T1)), 'v3', TOPICS.v3Swap)!;
    expect(tradeOf(pool, sellV3, 1_700_000_000)).toMatchObject({ side: 'sell', price: '3' });
    const pancake = decodeSwap(full(v3SwapLog(P, -(10n ** 18n), 3_000_000n, T1, TOPICS.pancakeV3Swap, 2)), 'v3', TOPICS.pancakeV3Swap)!;
    expect(tradeOf(pool, pancake, 1_700_000_000)).toMatchObject({ side: 'buy', price: '3' });
    // A Uniswap-shaped payload is not accepted under Pancake's topic and the reverse.
    expect(decodeSwap(full(v3SwapLog(P, 1n, -1n, T1, TOPICS.pancakeV3Swap, 0)), 'v3', TOPICS.pancakeV3Swap)).not.toBeNull();
    expect(decodeSwap(full(v3SwapLog(P, 1n, -1n, T1)), 'v3', TOPICS.pancakeV3Swap)).toBeNull();
  });

  it('refuses a swap with a missing side, equal-direction flows, or truncated data', () => {
    const pool = { chain: 'bnb' as const, address: P, baseIsToken0: true, baseDecimals: 18, quoteDecimals: 18 };
    const bothIn = decodeSwap(full(v2SwapLog(P, { in0: 5n, in1: 5n }, T1)), 'v2', TOPICS.v2Swap)!;
    expect(tradeOf(pool, bothIn, 1_700_000_000)).toBeNull();
    const oneSide = decodeSwap(full(v2SwapLog(P, { in0: 5n }, T1)), 'v2', TOPICS.v2Swap)!;
    expect(tradeOf(pool, oneSide, 1_700_000_000)).toBeNull();
    const bad = full({ address: P, topics: [TOPICS.v2Swap, addrTopic(T0), addrTopic(T1)], data: '0x' + word(1n) });
    expect(decodeSwap(bad, 'v2', TOPICS.v2Swap)).toBeNull();
  });

  it('logMeta requires every field', () => {
    expect(logMeta({ address: P, topics: [], data: '0x', ...block })).not.toBeNull();
    expect(logMeta({ address: P, topics: [], data: '0x', ...block, logIndex: undefined })).toBeNull();
  });
});
