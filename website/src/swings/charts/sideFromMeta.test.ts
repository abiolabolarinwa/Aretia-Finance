import { describe, expect, it } from 'vitest';
import { sideFromMeta } from './tvDatafeed';
import { formatAxisPrice } from '../market/types';

const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const meta = (base: string, quote: string) => ({ meta: { base: { address: base }, quote: { address: quote } } });

describe('the side of the pool that holds the charted token', () => {
  it('keeps the side asked for when it already holds the token', () => {
    expect(sideFromMeta(meta(WBNB, USDT), WBNB, 'base')).toBe('base');
  });
  it('asks for the other side when the source orders the pool the other way round (USDT first, WBNB second)', () => {
    expect(sideFromMeta(meta(USDT, WBNB), WBNB, 'base')).toBe('quote');
    expect(sideFromMeta(meta(WBNB, USDT), WBNB, 'quote')).toBe('base');
  });
  it('compares addresses without regard to case', () => {
    expect(sideFromMeta(meta(USDT, WBNB.toUpperCase().replace('0X', '0x')), WBNB, 'base')).toBe('quote');
  });
  it('keeps the side when there is no target, no meta, or the token is in neither slot', () => {
    expect(sideFromMeta(meta(USDT, WBNB), undefined, 'base')).toBe('base');
    expect(sideFromMeta({}, WBNB, 'base')).toBe('base');
    expect(sideFromMeta(meta(USDT, '0xabc'), WBNB, 'base')).toBe('base');
  });
});

describe('chart axis prices', () => {
  it('writes a tiny price with a subscript count of zeros, not in scientific form', () => {
    expect(formatAxisPrice(3.264e-6)).toBe('0.0₅3264');
    expect(formatAxisPrice(0.65e-6)).toBe('0.0₆65');
  });
  it('writes ordinary prices plainly', () => {
    expect(formatAxisPrice(654.21)).toBe('654.21');
    expect(formatAxisPrice(0.025404)).toBe('0.025404');
    expect(formatAxisPrice(1)).toBe('1');
    expect(formatAxisPrice(0)).toBe('0');
    expect(formatAxisPrice(-0.5)).toBe('-0.5');
  });
});
