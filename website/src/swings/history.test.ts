import { describe, expect, it } from 'vitest';
import { lastSwapOf, repeatLabel, type HistoryItem } from './history.js';

const item = (over: Partial<HistoryItem>): HistoryItem => ({
  id: 'a',
  at: 100,
  account: '0xabc',
  chain: 'solana',
  provider: 'jupiter',
  fromSymbol: 'USDC',
  toSymbol: 'BONK',
  amountIn: '25',
  expectedOut: '1000',
  txId: 'tx',
  status: 'confirmed',
  fromAddress: 'FromMint',
  toAddress: 'ToMint',
  ...over,
});

describe('the swap offered to repeat', () => {
  it('is the newest confirmed swap that kept both addresses and has a plain amount', () => {
    const got = lastSwapOf([item({ id: 'old', at: 1 }), item({ id: 'new', at: 5 }), item({ id: 'failed', at: 9, status: 'failed' })]);
    expect(got?.id).toBe('new');
  });
  it('skips swaps that cannot be repeated safely, and is null when none can', () => {
    expect(lastSwapOf([])).toBeNull();
    expect(lastSwapOf([item({ fromAddress: undefined }), item({ toAddress: undefined }), item({ amountIn: '1,000' }), item({ amountIn: '0' }), item({ amountIn: '1e9' }), item({ status: 'rejected' })])).toBeNull();
    expect(lastSwapOf([item({ amountIn: '0.5' })])?.amountIn).toBe('0.5');
    expect(lastSwapOf([item({ amountIn: '.5' })])?.amountIn).toBe('.5');
  });
  it('is labelled with the amount and both symbols', () => {
    expect(repeatLabel(item({}))).toBe('25 USDC → BONK');
  });
});
