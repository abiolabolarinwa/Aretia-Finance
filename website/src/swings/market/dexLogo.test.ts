import { describe, expect, it } from 'vitest';
import { dexInitial, dexLogoSrc } from './dexLogo';

describe('the exchange logo of a Markets row', () => {
  it('matches a venue name to its exchange, whatever the version', () => {
    expect(dexLogoSrc('Uniswap V3')).toBe('/assets/dex/uniswap.png');
    expect(dexLogoSrc('PancakeSwap V2')).toBe('/assets/dex/pancakeswap.png');
    expect(dexLogoSrc('Raydium CPMM')).toBe('/assets/dex/raydium.png');
    expect(dexLogoSrc('Orca Whirlpool')).toBe('/assets/dex/orca.png');
    expect(dexLogoSrc('PumpSwap')).toBe('/assets/dex/pump.png');
  });
  it('has no logo for an unknown exchange or no name', () => {
    expect(dexLogoSrc('Meteora DLMM')).toBeNull();
    expect(dexLogoSrc(undefined)).toBeNull();
    expect(dexInitial('Meteora DLMM')).toBe('M');
  });
});
