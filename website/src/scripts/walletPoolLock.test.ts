import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POOL_FORM, validatePool, type PoolToken } from './walletPoolCore';

const read = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const CREATOR = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const token: PoolToken = { mint: MINT, decimals: 6, supply: 10n ** 15n, mintAuthority: null, freezeAuthority: null, extensions: [18, 19], held: 10n ** 15n };

describe('every pool opened on Aretia is locked for good, and nothing in the forms can turn that off', () => {
  it('the Solana rules always lock, whatever the form says', () => {
    const v = validatePool({ ...DEFAULT_POOL_FORM, mint: MINT, tokenAmount: '1,000', price: '0.000001' }, CREATOR, token);
    expect(v.ok && v.config.lockLiquidity).toBe(true);
    // A form that still carries the old field (a stale tab, a hand-built object) cannot unlock it.
    const old = validatePool({ ...DEFAULT_POOL_FORM, mint: MINT, tokenAmount: '1,000', price: '0.000001', lockLiquidity: false } as never, CREATOR, token);
    expect(old.ok && old.config.lockLiquidity).toBe(true);
    expect('lockLiquidity' in DEFAULT_POOL_FORM).toBe(false);
  });

  it('neither pool card has a control for it, and the EVM card always asks for the locked version', () => {
    const solana = read('walletPool.ts');
    const evm = read('walletPoolEvm.ts');
    // The review may read the config's lock; nothing may read a form field or write one.
    expect(solana).not.toMatch(/form\.lockLiquidity|set\(\{ lockLiquidity/);
    expect(evm).not.toMatch(/form\.lock\b/);
    expect(evm).toContain('poolConfigOf(v, creator, true, facts)');
    expect(solana).toContain('locked for good');
    expect(evm).toContain('locked for good');
  });
});
