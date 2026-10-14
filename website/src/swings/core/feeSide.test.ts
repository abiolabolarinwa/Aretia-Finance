import { describe, expect, it } from 'vitest';
import { solanaFeeSide } from './fee.js';
import { KNOWN_TOKENS } from './solanaTools.js';

// On Solana the fee is taken from what the seller RECEIVES when a token that is not SOL, USDC or USDT is sold for one of those three,
// so the fee wallet only ever receives assets it already holds accounts for. Every other swap pays on the amount entered.
const mintOf = (symbol: string): string => KNOWN_TOKENS.find((k) => k.symbol === symbol)!.mint;
const SOL = mintOf('SOL');
const USDC = mintOf('USDC');
const USDT = mintOf('USDT');
const TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const OTHER = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYC';

describe('which side of a Solana swap pays the Aretia fee', () => {
  it('takes it from the output when a token is sold for SOL, USDC or USDT', () => {
    expect(solanaFeeSide(TOKEN, SOL)).toBe('output');
    expect(solanaFeeSide(TOKEN, USDC)).toBe('output');
    expect(solanaFeeSide(TOKEN, USDT)).toBe('output');
  });

  it('takes it from the amount entered for a buy, for SOL, USDC or USDT sold, and for a token swapped for another token', () => {
    expect(solanaFeeSide(SOL, TOKEN)).toBe('input');
    expect(solanaFeeSide(USDC, TOKEN)).toBe('input');
    expect(solanaFeeSide(USDT, TOKEN)).toBe('input');
    expect(solanaFeeSide(SOL, USDC)).toBe('input');
    expect(solanaFeeSide(USDC, SOL)).toBe('input');
    expect(solanaFeeSide(TOKEN, OTHER)).toBe('input');
  });

  it('is case-insensitive for the fee asset and never treats an unknown address as one', () => {
    expect(solanaFeeSide(TOKEN, USDC.toLowerCase())).toBe('output');
    expect(solanaFeeSide(TOKEN, OTHER)).toBe('input');
  });
});
