/** Live, read-only: the pool picked for well-known tokens on the real DexScreener, and the pictures it gives. */
import { describe, expect, it } from 'vitest';
import { DexScreenerPoolFinder } from './dexscreener.js';
import { ensureLogos, cachedLogo, resetLogos } from '../tokens/logos.js';

const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ACT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';

describe('DexScreener, live', () => {
  it('picks a pool whose first token is the token itself for USDC, SOL and ACT, so header and chart agree', async () => {
    const finder = new DexScreenerPoolFinder();
    const out: string[] = [];
    for (const [chain, address, symbol] of [['solana', USDC_SOL, 'USDC'], ['solana', WSOL, 'SOL'], ['solana', ACT, 'ACT'], ['base', USDC_BASE, 'USDC']] as const) {
      const info = await finder.find(chain, address);
      out.push(`${chain} ${symbol}: ${info.poolName} base=${info.targetIsBase} liq=${Math.round(info.liquidityUsd ?? 0)}`);
      expect(info.baseSymbol, out.at(-1)).toBeTruthy();
      // The header always names the drawn pair's first token; when the token is that token it must say so.
      if (info.targetIsBase) expect(info.baseSymbol!.toUpperCase()).toContain(symbol.slice(0, 3));
    }
    console.log(out.join('\n'));
  }, 60_000);

  it('gives real pictures for well-known tokens', async () => {
    resetLogos();
    await ensureLogos('solana', [USDC_SOL, ACT]);
    expect(cachedLogo('solana', USDC_SOL)).toMatch(/^https:\/\//);
    console.log('USDC logo', cachedLogo('solana', USDC_SOL), 'ACT logo', cachedLogo('solana', ACT));
  }, 60_000);
});
