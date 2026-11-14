import { describe, expect, it } from 'vitest';
import { swapTokens } from './walletSwapTokens';

const A = '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('swapTokens', () => {
  it('names both tokens of each swap that went through, once each, in any letter case', () => {
    const got = swapTokens([
      { status: 'confirmed', chain: 'bnb', fromAddress: A, toAddress: B },
      { status: 'submitted', chain: 'bnb', fromAddress: A.toLowerCase(), toAddress: B },
      { status: 'confirmed', chain: 'ethereum', fromAddress: A, toAddress: B },
    ]);
    expect(got).toEqual([
      { chain: 'bnb', address: B },
      { chain: 'bnb', address: A },
      { chain: 'ethereum', address: B },
      { chain: 'ethereum', address: A },
    ]);
  });

  it('skips swaps that never moved a token, and swaps saved without addresses', () => {
    expect(swapTokens([{ status: 'failed', chain: 'bnb', fromAddress: A, toAddress: B }, { status: 'rejected', chain: 'bnb', fromAddress: A }, { status: 'expired', chain: 'bnb', toAddress: B }])).toEqual([]);
    expect(swapTokens([{ status: 'confirmed', chain: 'bnb' }])).toEqual([]);
  });
});
