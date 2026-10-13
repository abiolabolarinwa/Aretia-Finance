import { describe, expect, it } from 'vitest';
import { planForOwner, telegramText, MAX_MESSAGES_PER_RUN, type OwnerWatch } from './plan.js';
import { watchKey } from '../account/priceAlerts.js';
import type { PriceOrder } from '../account/priceOrders.js';

const fav = (n: number) => ({ chain: 'base' as const, address: `0x${String(n).repeat(40)}`, symbol: `T${n}`, icon: null });
const k = (n: number) => watchKey('base', fav(n).address);
const order = (id: string, n: number, side: 'buy' | 'sell', targetUsd: number): PriceOrder => ({ id, chain: 'base', address: fav(n).address, symbol: `T${n}`, name: '', icon: null, side, targetUsd, createdAt: 0, hitAt: null, hitPrice: null });
const watch = (over: Partial<OwnerWatch> = {}): OwnerWatch => ({ movePct: 5, favourites: [fav(1)], orders: [], baselines: { [k(1)]: 1 }, ...over });

describe('planForOwner', () => {
  it('says nothing for a small move and keeps the baseline', () => {
    const p = planForOwner(watch(), { [k(1)]: 1.02 }, 1);
    expect(p.messages).toEqual([]);
    expect(p.baselines[k(1)]).toBe(1);
  });
  it('reports a move of the chosen size and moves the baseline', () => {
    const p = planForOwner(watch(), { [k(1)]: 1.1 }, 1);
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]).toMatchObject({ kind: 'move', title: 'T1 ▲ +10.0%', url: '/wallet#/favourites' });
    expect(p.baselines[k(1)]).toBe(1.1);
  });
  it('reports a price order once, when it is reached, and lists it to be marked', () => {
    const w = watch({ favourites: [], baselines: {}, orders: [order('a', 2, 'buy', 0.5), order('b', 2, 'sell', 2)] });
    const p = planForOwner(w, { [k(2)]: 0.4 }, 1);
    expect(p.messages.map((m) => m.title)).toEqual(['T2 reached $0.5']);
    expect(p.hitOrders).toEqual([{ id: 'a', price: 0.4 }]);
  });
  it('gives a token with no price no message and no baseline of zero', () => {
    const p = planForOwner(watch(), { [k(1)]: null }, 1);
    expect(p.messages).toEqual([]);
    expect(p.baselines[k(1)]).toBe(1);
  });
  it('folds a flood into a few messages and a summary', () => {
    const favs = Array.from({ length: 12 }, (_, i) => fav(i + 1));
    const baselines = Object.fromEntries(favs.map((_, i) => [k(i + 1), 1]));
    const prices = Object.fromEntries(favs.map((_, i) => [k(i + 1), 2]));
    const p = planForOwner(watch({ favourites: favs, baselines }), prices, 1);
    expect(p.messages).toHaveLength(MAX_MESSAGES_PER_RUN + 1);
    expect(p.messages.at(-1)?.title).toBe('7 more price alerts');
  });
  it('writes the Telegram text with the link', () => {
    expect(telegramText({ kind: 'move', title: 'T1 ▲ +10.0%', body: '$1.1, was $1', url: '/wallet#/favourites' }, 'https://aretiafinance.org')).toBe('🔔 T1 ▲ +10.0%\n$1.1, was $1\nhttps://aretiafinance.org/wallet#/favourites');
  });
});
