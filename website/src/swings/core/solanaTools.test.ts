import { describe, expect, it } from 'vitest';
// Characterization test (docs/architecture/MIGRATION_LOG.md, M-02). It pins the values that decide where swap fees go
// and which tokens are known, so that moving or editing the module that defines them cannot change them silently.
// It imports through the long-standing `scripts/walletTools` path, which must keep exporting the same bindings.
import * as viaScripts from '../../scripts/walletTools.js';
import * as viaCore from './solanaTools.js';

describe('solana primitives are pinned', () => {
  it('swap fee wallet and token program ids', () => {
    expect(viaScripts.SWAP_FEE_WALLET).toBe('2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2');
    expect(viaScripts.TOKEN_PROGRAM_ID).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  });
  it('known token list', () => {
    expect(viaScripts.KNOWN_TOKENS).toMatchInlineSnapshot(`
      [
        {
          "decimals": 9,
          "mint": "So11111111111111111111111111111111111111112",
          "symbol": "SOL",
        },
        {
          "decimals": 6,
          "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          "symbol": "USDC",
        },
        {
          "decimals": 6,
          "mint": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
          "symbol": "USDT",
        },
        {
          "decimals": 9,
          "mint": "7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG",
          "symbol": "ACT",
        },
      ]
    `);
  });
  it('address validation behaviour', () => {
    expect(viaScripts.isSolanaAddress(viaScripts.SWAP_FEE_WALLET)).toBe(true);
    expect(viaScripts.isSolanaAddress('')).toBe(false);
    expect(viaScripts.isSolanaAddress('0x0000000000000000000000000000000000000000')).toBe(false);
    expect(viaScripts.isSolanaAddress('not an address')).toBe(false);
  });
  it('the old and new import paths expose the identical bindings', () => {
    expect(Object.keys(viaScripts).sort()).toEqual(Object.keys(viaCore).sort());
    for (const k of Object.keys(viaCore) as (keyof typeof viaCore)[]) expect(viaScripts[k]).toBe(viaCore[k]);
  });
});
