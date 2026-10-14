import { describe, expect, it } from 'vitest';
import { SwapHistory, type HistoryItem } from './history.js';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const item = (over: Partial<HistoryItem> = {}): HistoryItem => ({ id: 'a', at: 1, account: 'acct', chain: 'bnb', provider: '0x', fromSymbol: 'BNB', toSymbol: 'SAFU', amountIn: '1', expectedOut: '2', txId: null, status: 'confirmed', ...over });

describe('swap history keeps the tokens\' addresses', () => {
  it('saves and returns them, and still reads a swap saved without them', () => {
    const s = mem();
    const h = new SwapHistory(s);
    h.save(item({ id: 'new', fromAddress: '0xeeee', toAddress: '0xb0f0e37' }));
    h.save(item({ id: 'old', at: 0 }));
    const got = new SwapHistory(s).list('acct');
    expect(got.find((x) => x.id === 'new')).toMatchObject({ fromAddress: '0xeeee', toAddress: '0xb0f0e37' });
    expect(got.find((x) => x.id === 'old')?.toAddress).toBeUndefined();
  });
  it('drops a saved item whose address is not text', () => {
    const s = mem();
    s.setItem('aretia-swings-history-v1', JSON.stringify([item({ id: 'x', toAddress: 5 as unknown as string })]));
    expect(new SwapHistory(s).list('acct')).toEqual([]);
  });
});
