import { describe, expect, it } from 'vitest';
import { shortAmount } from './walletSwings';

describe('shortAmount', () => {
  it('leaves short amounts alone and cuts long tails', () => {
    expect(shortAmount('1.5')).toBe('1.5');
    expect(shortAmount('100')).toBe('100');
    expect(shortAmount('0.094189796833764515')).toBe('0.09418979');
    expect(shortAmount('12.123456789012')).toBe('12.12345678');
  });
  it('keeps six significant digits of a very small amount', () => {
    expect(shortAmount('0.000000001234567891')).toBe('0.00000000123456');
  });
  it('never turns a whole number into a smaller one', () => {
    expect(shortAmount('100.000000000000')).toBe('100');
    expect(shortAmount('2.000000000000')).toBe('2');
  });
});
