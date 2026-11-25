import { describe, expect, it } from 'vitest';
import { nextPace } from './pace';

describe('the pace of chain reads', () => {
  it('stays at the base while the price moves, and slows to the ceiling while it keeps still', () => {
    expect(nextPace(1000, 1000, true, 8000)).toBe(1000);
    expect(nextPace(1000, 1000, false, 8000)).toBe(1500);
    let p = 1000;
    for (let i = 0; i < 10; i++) p = nextPace(1000, p, false, 8000);
    expect(p).toBe(8000);
    expect(nextPace(1000, p, true, 8000)).toBe(1000);
  });
  it('never goes below the base', () => {
    expect(nextPace(400, 0, false, 4000)).toBe(600);
  });
});
