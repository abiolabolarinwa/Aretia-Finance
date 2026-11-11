import { describe, expect, it } from 'vitest';
import { rateLabel, stageFor } from './walletSwapSheet';

describe('which swap window the swap calls for', () => {
  it('shows the review, the wallet wait and the network wait as they happen', () => {
    expect(stageFor('review', null, false)).toBe('review');
    expect(stageFor('signing', null, false)).toBe('signing');
    expect(stageFor('tracking', null, false)).toBe('tracking');
  });
  it('shows nothing while a price is still being read or nothing has been asked', () => {
    for (const p of ['idle', 'quoting', 'quoted', 'preparing']) expect(stageFor(p, null, false)).toBeNull();
  });
  it('tells how it ended: complete, failed, or not confirmed yet', () => {
    expect(stageFor('done', { status: 'confirmed' }, false)).toBe('done');
    expect(stageFor('done', { status: 'failed' }, true)).toBe('failed');
    expect(stageFor('done', null, true)).toBe('failed');
    expect(stageFor('done', { status: 'submitted' }, false)).toBe('unconfirmed');
    // An error beats a vague status: it is told as a failure.
    expect(stageFor('done', { status: 'submitted' }, true)).toBe('failed');
  });
});

describe('the rate line', () => {
  it('reads "1 X ≈ n Y", with sensible digits for large and tiny numbers', () => {
    expect(rateLabel(2, 24_690, 'BNB', 'TRUMP')).toBe('1 BNB ≈ 12,345 TRUMP');
    expect(rateLabel(1, 0.000123456789, 'TRUMP', 'BNB')).toBe('1 TRUMP ≈ 0.000123457 BNB');
  });
  it('gives no rate when an amount is missing, zero or not a number', () => {
    expect(rateLabel(0, 5, 'A', 'B')).toBeNull();
    expect(rateLabel(5, 0, 'A', 'B')).toBeNull();
    expect(rateLabel(Number.NaN, 5, 'A', 'B')).toBeNull();
    expect(rateLabel(5, Number.POSITIVE_INFINITY, 'A', 'B')).toBeNull();
  });
});
