import { describe, expect, it } from 'vitest';
import { chainConfig } from '../chains.js';
import { SOLANA_SPECS } from '../dexes.js';
import { DEFAULT_RULES } from '../lifecycle.js';
import { InMemoryMiStore } from '../store.js';
import type { MiPool } from '../types.js';
import { followWatchedPools, pollIntervalMs, type SolDeps } from './engine.js';

const NOW = 1_800_000_000_000;
const spec = SOLANA_SPECS.find((s) => s.id === 'pumpswap-solana')!;
const pool = (over: Partial<MiPool>): MiPool =>
  ({ key: 'solana:P' + over.address, chain: 'solana', address: 'PoolAddress' + (over.address ?? '1'), adapterId: spec.id, state: 'active', paused: false, quoteVault: 'QuoteVault111', baseVault: 'BaseVault1111', lastTradeAt: NOW - 60_000, base: 'B', quote: 'Q', baseDecimals: 6, quoteDecimals: 9, ...over }) as MiPool;

function deps(calls: string[]): SolDeps {
  return {
    spec,
    chain: chainConfig('solana', {}),
    rpc: (async (method: string) => {
      calls.push(method);
      return method === 'getSignaturesForAddress' ? [] : null;
    }) as unknown as SolDeps['rpc'],
    store: new InMemoryMiStore(),
    rules: DEFAULT_RULES,
    now: () => NOW,
  };
}

describe('following the pools people are watching', () => {
  it('reads only active, unpaused pools that traded in the last 24 hours', async () => {
    const calls: string[] = [];
    const pools = [
      pool({ address: '1' }),
      pool({ address: '2', lastTradeAt: NOW - 3 * 86_400_000 }), // quiet for days: left to the normal rotation
      pool({ address: '3', state: 'inactive' }),
      pool({ address: '4', paused: true }),
      pool({ address: '5', lastTradeAt: null }),
      pool({ address: '6', quoteVault: null }),
    ];
    const r = await followWatchedPools(deps(calls), pools, { budgetMs: 10_000, maxPools: 10 });
    expect(r.polled).toBe(1);
    expect(calls).toEqual(['getSignaturesForAddress']); // one signature read; nothing new, so nothing more
    expect(r.traded).toBe(0);
  });
  it('reads at most maxPools in a pass', async () => {
    const calls: string[] = [];
    const pools = ['1', '2', '3', '4', '5'].map((a) => pool({ address: a }));
    const r = await followWatchedPools(deps(calls), pools, { budgetMs: 10_000, maxPools: 3 });
    expect(r.polled).toBe(3);
    expect(calls).toHaveLength(3);
  });
  it('reads a lively pool often and a quiet one rarely, remembering when each was read', async () => {
    expect(pollIntervalMs(NOW - 60_000, NOW, 2_000)).toBe(2_000); // traded in the last 5 minutes
    expect(pollIntervalMs(NOW - 20 * 60_000, NOW, 2_000)).toBe(10_000); // in the last hour
    expect(pollIntervalMs(NOW - 5 * 3_600_000, NOW, 2_000)).toBe(30_000); // today
    expect(pollIntervalMs(NOW - 5 * 3_600_000, NOW, 500)).toBe(15_000); // never faster than the floor of 15 s
    expect(pollIntervalMs(null, NOW, 2_000)).toBe(30_000);
    const calls: string[] = [];
    const lastPolled = new Map<string, number>();
    const pools = [pool({ address: '1', lastTradeAt: NOW - 30_000 }), pool({ address: '2', lastTradeAt: NOW - 4 * 3_600_000 })];
    const first = await followWatchedPools(deps(calls), pools, { budgetMs: 10_000, maxPools: 10, fastMs: 2_000, lastPolled });
    expect(first.polled).toBe(2);
    // Nothing is due straight away; the clock here does not move, so a second pass reads nothing.
    const second = await followWatchedPools(deps(calls), pools, { budgetMs: 10_000, maxPools: 10, fastMs: 2_000, lastPolled });
    expect(second.polled).toBe(0);
    expect(calls).toHaveLength(2);
  });
});
