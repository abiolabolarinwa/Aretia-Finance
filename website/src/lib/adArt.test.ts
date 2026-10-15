import { describe, expect, it } from 'vitest';
import { chartArt, walk } from './adArt.js';

describe('advert chart art', () => {
  it('draws the same chart for the same seed and a different one for another', () => {
    expect(chartArt(5, 'candles', true).inner).toBe(chartArt(5, 'candles', true).inner);
    expect(chartArt(5, 'candles', true).inner).not.toBe(chartArt(6, 'candles', true).inner);
  });

  it('keeps every value inside the picture and trends the way it is told to', () => {
    const upWalk = walk(11, 60, true);
    const downWalk = walk(11, 60, false);
    for (const v of [...upWalk, ...downWalk]) {
      expect(v).toBeGreaterThanOrEqual(0.05);
      expect(v).toBeLessThanOrEqual(0.95);
    }
    expect(upWalk[59]!).toBeGreaterThan(upWalk[0]!);
    expect(downWalk[59]!).toBeLessThan(downWalk[0]!);
  });

  it('makes a line with an area, and candlesticks with wicks', () => {
    expect(chartArt(3, 'line', true).inner).toMatch(/<path/);
    expect(chartArt(3, 'candles', false).inner).toMatch(/<rect/);
  });
});
