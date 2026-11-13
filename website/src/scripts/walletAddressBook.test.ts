import { describe, expect, it } from 'vitest';
import type { StorageLike } from '../swings/history.js';
import { BOOK_KEY, cleanLabel, loadBook, MAX_SAVED, recipientKind, removeRecipient, saveRecipient, suitsNetwork } from './walletAddressBook';

const mem = (): StorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) } as never;
};
const SOL = '8s2TyD4Zr2kGdm3u1fCgZ7vJ3mB6Z4Cw6bX3pYv9DRHz';
const EVM = '0x1234567890abcdef1234567890abcdef12345678';

describe('what can be saved', () => {
  it('knows a Solana address or .sns name, an Ethereum-style address, and nothing else', () => {
    expect(recipientKind(SOL)).toBe('solana');
    expect(recipientKind('alice.sol')).toBe('solana');
    expect(recipientKind(EVM)).toBe('evm');
    expect(recipientKind('0x12')).toBeNull();
    expect(recipientKind('hello')).toBeNull();
    expect(recipientKind('')).toBeNull();
  });
  it('cleans a label: no line breaks or control characters, at most 30 characters', () => {
    expect(cleanLabel('  Mum\n\u0007  home ')).toBe('Mum home');
    expect(cleanLabel('x'.repeat(80))).toHaveLength(30);
  });
});

describe('the saved list', () => {
  it('saves, renames when the address is already there, and removes', () => {
    const s = mem();
    const first = saveRecipient(s, 'Mum', SOL);
    expect('book' in first && first.book).toHaveLength(1);
    const again = saveRecipient(s, 'Mother', SOL);
    expect('book' in again && again.book).toEqual([{ label: 'Mother', address: SOL, kind: 'solana' }]);
    expect(removeRecipient(s, SOL)).toEqual([]);
    expect(loadBook(s)).toEqual([]);
  });
  it('matches an Ethereum-style address without regard to capital letters', () => {
    const s = mem();
    saveRecipient(s, 'Rent', EVM);
    const r = saveRecipient(s, 'Landlord', EVM.toUpperCase().replace('0X', '0x'));
    expect('book' in r && r.book).toHaveLength(1);
  });
  it('says why it did not save', () => {
    const s = mem();
    expect(saveRecipient(s, 'Mum', 'nope')).toEqual({ problem: expect.stringContaining('not a Solana address') });
    expect(saveRecipient(s, '   ', SOL)).toEqual({ problem: expect.stringContaining('name') });
  });
  it('stops at the limit', () => {
    const s = mem();
    for (let i = 0; i < MAX_SAVED; i++) saveRecipient(s, `r${i}`, `0x${i.toString(16).padStart(40, '0')}`);
    expect(saveRecipient(s, 'one more', `0x${'f'.repeat(40)}`)).toEqual({ problem: expect.stringContaining('Remove one first') });
  });
  it('ignores damaged storage and entries that are not recipients', () => {
    const s = mem();
    s.setItem(BOOK_KEY, '{not json');
    expect(loadBook(s)).toEqual([]);
    s.setItem(BOOK_KEY, JSON.stringify([{ label: 'ok', address: SOL }, { label: 5 }, null, { label: 'bad', address: 'zzz' }]));
    expect(loadBook(s)).toEqual([{ label: 'ok', address: SOL, kind: 'solana' }]);
    expect(loadBook(null)).toEqual([]);
  });
  it('offers Solana recipients on Solana and 0x recipients on the other networks', () => {
    const book = [{ label: 'a', address: SOL, kind: 'solana' as const }, { label: 'b', address: EVM, kind: 'evm' as const }];
    expect(suitsNetwork(book, 'solana').map((r) => r.label)).toEqual(['a']);
    expect(suitsNetwork(book, 'bnb').map((r) => r.label)).toEqual(['b']);
  });
});
