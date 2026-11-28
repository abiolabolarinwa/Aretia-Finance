import { describe, expect, it } from 'vitest';
import { MAX_RECENT, RECENT_KEY, clearRecent, loadRecent, rememberToken } from './walletRecentTokens';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const tok = (n: number, chain: 'solana' | 'ethereum' = 'solana') => ({ chain, address: `Addr${String(n).padStart(30, '0')}`, symbol: `T${n}`, name: `Token ${n}`, icon: null });

describe('recently viewed tokens', () => {
  it('keeps the newest first, moves a repeat to the top and stops at ten', () => {
    const s = mem();
    for (let i = 1; i <= 12; i++) rememberToken(tok(i), s);
    rememberToken(tok(5), s);
    const list = loadRecent(s);
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0]!.symbol).toBe('T5');
    expect(list.filter((t) => t.symbol === 'T5')).toHaveLength(1);
  });
  it('drops malformed entries and non-https pictures', () => {
    const s = mem();
    s.setItem(RECENT_KEY, JSON.stringify([{ chain: 'mars', address: 'x' }, { ...tok(1), icon: 'javascript:alert(1)' }, 'junk']));
    const list = loadRecent(s);
    expect(list).toHaveLength(1);
    expect(list[0]!.icon).toBeNull();
  });
  it('clears', () => {
    const s = mem();
    rememberToken(tok(1), s);
    clearRecent(s);
    expect(loadRecent(s)).toEqual([]);
  });
});
