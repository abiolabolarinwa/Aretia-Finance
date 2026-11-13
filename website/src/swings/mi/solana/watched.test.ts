import { describe, expect, it } from 'vitest';
import { chainConfig } from '../chains.js';
import { SOLANA_SPECS } from '../dexes.js';
import { DEFAULT_RULES } from '../lifecycle.js';
import { InMemoryMiStore } from '../store.js';
import type { MiPool } from '../types.js';
import { followWatchedPools, type SolDeps } from './engine.js';

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
});
