import { describe, expect, it } from 'vitest';
import { swapRequestFor, swapTargetFor } from './walletHoldingActions';

const SOL = 'So11111111111111111111111111111111111111112';
const SNOW_CONTRACT = '0x2546F34438ceedcbd668ad71b77e7767ca3d0000';

describe('which token a dashboard holding is, for Buy and Sell', () => {
  it('reads an Ethereum-style holding by its network and contract, and its own coin as the native placeholder', () => {
    expect(swapTargetFor({ mint: `bnb:${SNOW_CONTRACT}` })).toEqual({ chain: 'bnb', address: SNOW_CONTRACT.toLowerCase() });
    expect(swapTargetFor({ mint: 'ethereum:native' })).toEqual({ chain: 'ethereum', address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' });
    expect(swapTargetFor({ mint: 'polygon:native' })?.chain).toBe('polygon');
  });
  it('reads anything else as a Solana mint, including native SOL', () => {
    expect(swapTargetFor({ mint: SOL })).toEqual({ chain: 'solana', address: SOL });
    expect(swapTargetFor({ mint: 'FQTnKFsQVtwky2LZ1iiQ4fRj5MgCMYN8ySJM1Mdjpump' })?.chain).toBe('solana');
  });
  it('gives nothing for a key it cannot place', () => {
    for (const mint of ['', 'bnb:notanaddress', 'mars:native', 'solana:native', '0x123', 'short']) expect(swapTargetFor({ mint }), mint).toBeNull();
  });
});

describe('the Buy and Sell requests', () => {
  const holding = { mint: `bnb:${SNOW_CONTRACT}`, symbol: 'SNOW', name: 'Snowball', icon: null, decimals: 18 };
  it('carry the token and the side', () => {
    expect(swapRequestFor(holding, 'buy')).toMatchObject({ chain: 'bnb', address: SNOW_CONTRACT.toLowerCase(), symbol: 'SNOW', side: 'buy', decimals: 18 });
    expect(swapRequestFor(holding, 'sell')?.side).toBe('sell');
  });
  it('are not made for a holding that cannot be placed', () => {
    expect(swapRequestFor({ ...holding, mint: 'garbage' }, 'buy')).toBeNull();
  });
});
