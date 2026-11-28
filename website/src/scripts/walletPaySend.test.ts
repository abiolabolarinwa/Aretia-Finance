import { describe, expect, it } from 'vitest';
import { amountOf, checkRecipient, tokenText } from './walletPaySend';

const SOL = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T';
const EVM = '0x52908400098527886E0F7030069857D2E4169EE7';

describe('the live recipient check on phones', () => {
  it('says nothing for an empty box', () => {
    expect(checkRecipient('  ', 'solana', [], [])).toEqual({ tone: 'none', text: '' });
  });
  it('refuses your own address, in any letter case', () => {
    expect(checkRecipient(EVM.toLowerCase(), 'ethereum', ['', EVM], []).tone).toBe('bad');
  });
  it('flags a wrong address for the network', () => {
    expect(checkRecipient(SOL, 'ethereum', [], []).tone).toBe('bad');
    expect(checkRecipient(EVM, 'solana', [], []).tone).toBe('bad');
  });
  it('accepts a .sns name on Solana and leaves its address to Review', () => {
    expect(checkRecipient('bonfida.sol', 'solana', [], []).tone).toBe('ok');
  });
  it('marks a new recipient as a warning and a saved one as fine', () => {
    expect(checkRecipient(SOL, 'solana', [], []).tone).toBe('warn');
    expect(checkRecipient(SOL, 'solana', [], [SOL]).tone).toBe('ok');
  });
});

describe('amounts', () => {
  it('reads a typed amount', () => {
    expect(amountOf('1,250.5')).toBe(1250.5);
    expect(amountOf('.5')).toBe(0.5);
    expect(amountOf('2.')).toBe(2);
    expect(amountOf('abc')).toBeNull();
    expect(amountOf('')).toBeNull();
  });
  it('writes a share of a balance without trailing zeros or exponents', () => {
    expect(tokenText(2.5 * 0.25, 9)).toBe('0.625');
    expect(tokenText(1e-7, 9)).toBe('0.0000001');
    expect(tokenText(10, 6)).toBe('10');
    expect(tokenText(0)).toBe('0');
  });
});
