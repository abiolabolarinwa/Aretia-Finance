import { describe, expect, it } from 'vitest';
import { AlertStore, DEFAULT_PCT, evaluateMoves, watchKey, type WatchedPrice } from './priceAlerts.js';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const tok = (symbol: string, priceUsd: number | null, address = `0x${symbol.toLowerCase().padEnd(40, '0')}`): WatchedPrice => ({ chain: 'bnb', address, symbol, icon: null, priceUsd });

describe('evaluateMoves', () => {
  it('gives a token seen for the first time a baseline and no alert', () => {
    const r = evaluateMoves([tok('AAA', 2)], {}, 5, 1);
    expect(r.alerts).toEqual([]);
    expect(r.baselines[watchKey('bnb', tok('AAA', 2).address)]).toBe(2);
  });

  it('alerts when the price moves by the chosen percentage, and moves the baseline', () => {
    const k = watchKey('bnb', tok('AAA', 1).address);
    const up = evaluateMoves([tok('AAA', 1.06)], { [k]: 1 }, 5, 7);
    expect(up.alerts).toHaveLength(1);
    expect(up.alerts[0]).toMatchObject({ symbol: 'AAA', baseline: 1, price: 1.06, at: 7 });
    expect(up.alerts[0]!.movePct).toBeCloseTo(6, 6);
    expect(up.baselines[k]).toBe(1.06);
    const down = evaluateMoves([tok('AAA', 0.9)], { [k]: 1 }, 5, 7);
    expect(down.alerts[0]!.movePct).toBeCloseTo(-10, 6);
  });

  it('stays quiet below the threshold and keeps the old baseline, so small moves add up', () => {
    const k = watchKey('bnb', tok('AAA', 1).address);
    const small = evaluateMoves([tok('AAA', 1.03)], { [k]: 1 }, 5, 1);
    expect(small.alerts).toEqual([]);
    expect(small.baselines[k]).toBe(1);
    expect(evaluateMoves([tok('AAA', 1.05)], small.baselines, 5, 2).alerts).toHaveLength(1);
  });

  it('skips a token with no price instead of treating it as zero, and keeps its baseline', () => {
    const k = watchKey('bnb', tok('AAA', 1).address);
    const r = evaluateMoves([tok('AAA', null)], { [k]: 1 }, 5, 1);
    expect(r.alerts).toEqual([]);
    expect(r.baselines[k]).toBe(1);
  });

  it('drops baselines of tokens no longer watched and lists the biggest move first', () => {
    const a = tok('AAA', 1.1);
    const b = tok('BBB', 2);
    const base = { [watchKey('bnb', a.address)]: 1, [watchKey('bnb', b.address)]: 1, [watchKey('bnb', '0xgone')]: 3 };
    const r = evaluateMoves([a, b], base, 5, 1);
    expect(r.alerts.map((x) => x.symbol)).toEqual(['BBB', 'AAA']);
    expect(Object.keys(r.baselines)).not.toContain(watchKey('bnb', '0xgone'));
  });

  it('treats EVM addresses case-insensitively', () => {
    expect(watchKey('bnb', '0xABC')).toBe(watchKey('bnb', '0xabc'));
    expect(watchKey('solana', 'AbC')).not.toBe(watchKey('solana', 'abc'));
  });
});

describe('AlertStore', () => {
  it('defaults to 5% and remembers a valid choice only', () => {
    const s = new AlertStore(mem());
    expect(s.pct()).toBe(DEFAULT_PCT);
    s.setPct(10);
    expect(s.pct()).toBe(10);
    s.setPct(7);
    expect(s.pct()).toBe(10);
  });

  it('starts and stops watching a token and keeps a short log of alerts', () => {
    const s = new AlertStore(mem());
    s.startWatching('bnb', '0xAA', 2);
    expect(s.baselines()[watchKey('bnb', '0xaa')]).toBe(2);
    s.startWatching('bnb', '0xBB', null);
    expect(Object.keys(s.baselines())).toHaveLength(1);
    s.stopWatching('bnb', '0xaa');
    expect(s.baselines()).toEqual({});
    const alerts = Array.from({ length: 25 }, (_, i) => ({ key: `k${i}`, chain: 'bnb' as const, address: '0x1', symbol: 'A', icon: null, price: 1, baseline: 1, movePct: 5, at: i }));
    s.record({}, alerts);
    expect(s.log()).toHaveLength(20);
  });

  it('survives unreadable storage', () => {
    const bad = { getItem: () => '{not json', setItem: () => { throw new Error('full'); }, removeItem: () => undefined };
    const s = new AlertStore(bad);
    expect(s.pct()).toBe(DEFAULT_PCT);
    expect(() => s.setPct(2)).not.toThrow();
  });
});
