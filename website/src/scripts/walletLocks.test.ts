import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketRow } from '../swings/market/types.js';
import { createLockQueue } from './walletLocks.js';

const row = (pool: string, over: Partial<MarketRow> = {}): MarketRow => ({
  chain: 'bnb', address: `0xtoken${pool}`, symbol: 'T', quoteSymbol: 'WBNB', name: 'T', icon: null, decimals: 18, pool,
  priceUsd: 1, capUsd: 1, ageMs: 1, txns24h: 1, volume24hUsd: 1, traders24h: 1, change: { m5: 0, h1: 0, h6: 0, h24: 0 },
  liquidityUsd: 1, risk: null, fresh: false, ...over,
});

describe('finding locked liquidity in the page', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('marks a pool whose liquidity is mostly burned, and only that one', async () => {
    const answers: Record<string, number | null> = { '0xa': 100, '0xb': 12, '0xc': null };
    const changed = vi.fn();
    const q = createLockQueue({ check: async (r) => answers[r.pool] ?? null, onChange: changed });
    const rows = [row('0xa'), row('0xb'), row('0xc')];
    q.rate(rows);
    await vi.advanceTimersByTimeAsync(400);
    expect(changed).toHaveBeenCalled();
    const marked = q.sync(rows);
    expect(marked.map((r) => r.pool)).toEqual(['0xa']);
    expect(rows[0]!.lockedPct).toBe(100);
    expect(rows[1]!.lockedPct ?? null).toBeNull();
    expect(rows[2]!.lockedPct ?? null).toBeNull();
  });

  it('keeps a padlock Aretia already had and does not ask again', async () => {
    const check = vi.fn(async () => 100);
    const q = createLockQueue({ check, onChange: () => undefined });
    q.rate([row('0xa', { lockedPct: 97.5 })]);
    await vi.advanceTimersByTimeAsync(400);
    expect(check).not.toHaveBeenCalled();
  });

  it('remembers every answer, including "not shown", so a refresh does not ask the chain again', async () => {
    const check = vi.fn(async (r: MarketRow) => (r.pool === '0xa' ? 100 : null));
    const q = createLockQueue({ check, onChange: () => undefined });
    q.rate([row('0xa'), row('0xb')]);
    await vi.advanceTimersByTimeAsync(400);
    expect(check).toHaveBeenCalledTimes(2);
    const again = [row('0xa'), row('0xb')];
    q.rate(again);
    await vi.advanceTimersByTimeAsync(400);
    expect(check).toHaveBeenCalledTimes(2);
    expect(again[0]!.lockedPct).toBe(100);
  });

  it('treats a failing check as "not shown" and carries on', async () => {
    const q = createLockQueue({ check: async () => { throw new Error('node down'); }, onChange: () => undefined });
    const rows = [row('0xa')];
    q.rate(rows);
    await vi.advanceTimersByTimeAsync(400);
    expect(q.sync(rows)).toEqual([]);
  });

  it('runs only a few checks at a time', async () => {
    let running = 0;
    let peak = 0;
    const q = createLockQueue({
      concurrency: 3,
      onChange: () => undefined,
      check: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 50));
        running--;
        return null;
      },
    });
    q.rate(Array.from({ length: 10 }, (_, i) => row(`0x${i}`)));
    await vi.advanceTimersByTimeAsync(1000);
    expect(peak).toBe(3);
  });
});
