import { describe, expect, it } from 'vitest';
import { featuredWindow, guessNetwork, shortDay, tomorrow } from './promoteFlow';

describe('promote flow helpers', () => {
  it('reads the kind of address that was pasted', () => {
    expect(guessNetwork('0x' + 'a'.repeat(40))).toBe('evm');
    expect(guessNetwork('  So11111111111111111111111111111111111111112 ')).toBe('solana');
    expect(guessNetwork('')).toBeNull();
    expect(guessNetwork('0x123')).toBeNull();
    expect(guessNetwork('hello world')).toBeNull();
  });
  it('turns a start day and a length into first and last day, both included', () => {
    expect(featuredWindow('2026-11-14', 1)).toEqual({ from: '2026-11-14', to: '2026-11-14' });
    expect(featuredWindow('2026-11-14', 7)).toEqual({ from: '2026-11-14', to: '2026-11-20' });
    expect(featuredWindow('2026-11-28', 14)).toEqual({ from: '2026-11-28', to: '2026-12-11' });
    expect(featuredWindow('2026-02-31', 7)).toBeNull();
    expect(featuredWindow('soon', 7)).toBeNull();
    expect(featuredWindow('2026-11-14', 0)).toBeNull();
  });
  it('proposes tomorrow (UTC) as the first day and writes days briefly', () => {
    expect(tomorrow(new Date('2026-11-30T23:30:00Z'))).toBe('2026-12-01');
    expect(shortDay('2026-11-14')).toBe('14 Nov');
    expect(shortDay('2026-01-05')).toBe('5 Jan');
  });
});
