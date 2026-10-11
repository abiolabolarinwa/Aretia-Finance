import { describe, expect, it } from 'vitest';
import { PriceOrderStore, evaluateOrders, parseTarget, reached } from './priceOrders.js';
import { watchKey } from './priceAlerts.js';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const base = { chain: 'solana', address: 'So111', symbol: 'SOL', name: 'Solana', icon: null } as const;

describe('reached', () => {
  it('buys at or below the target and sells at or above it', () => {
    expect(reached('buy', 1, 1)).toBe(true);
    expect(reached('buy', 1.01, 1)).toBe(false);
    expect(reached('sell', 1, 1)).toBe(true);
    expect(reached('sell', 0.99, 1)).toBe(false);
  });
});

describe('PriceOrderStore', () => {
  it('keeps orders, marks one hit once, and removes', () => {
    const m = mem();
    const s = new PriceOrderStore(m, () => 5);
    const o = s.add({ ...base, side: 'buy', targetUsd: 100 })!;
    expect(new PriceOrderStore(m).watching()).toHaveLength(1);
    s.markHit(o.id, 99);
    s.markHit(o.id, 50);
    expect(s.list()[0]).toMatchObject({ hitAt: 5, hitPrice: 99 });
    expect(s.watching()).toHaveLength(0);
    s.remove(o.id);
    expect(s.list()).toEqual([]);
  });

  it('refuses a bad price and ignores damaged storage', () => {
    const m = mem();
    expect(new PriceOrderStore(m).add({ ...base, side: 'buy', targetUsd: 0 })).toBeNull();
    m.setItem('aretia-price-orders-v1', '{not json');
    expect(new PriceOrderStore(m).list()).toEqual([]);
  });
});

describe('evaluateOrders', () => {
  it('reports only watching orders whose price was reached, and skips tokens with no price', () => {
    const m = mem();
    const s = new PriceOrderStore(m);
    s.add({ ...base, side: 'buy', targetUsd: 100 });
    s.add({ ...base, address: 'Other', side: 'sell', targetUsd: 10 });
    const prices = { [watchKey('solana', 'So111')]: 90, [watchKey('solana', 'Other')]: null };
    const hits = evaluateOrders(s.list(), prices);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.price).toBe(90);
  });
});

describe('parseTarget', () => {
  it('reads dollars and commas, rejects the rest', () => {
    expect(parseTarget('$1,250.5')).toBe(1250.5);
    expect(parseTarget('0.00012')).toBe(0.00012);
    expect(parseTarget('abc')).toBeNull();
    expect(parseTarget('-3')).toBeNull();
    expect(parseTarget('')).toBeNull();
  });
});
