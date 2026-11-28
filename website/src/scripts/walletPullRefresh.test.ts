import { describe, expect, it } from 'vitest';
import { PULL_AT, pullDistance } from './walletPullRefresh';

describe('pull to refresh', () => {
  it('follows the finger, then slows down past the point where it loads', () => {
    expect(pullDistance(-10)).toBe(0);
    expect(pullDistance(40)).toBe(40);
    expect(pullDistance(PULL_AT)).toBe(PULL_AT);
    expect(pullDistance(PULL_AT + 100)).toBeCloseTo(PULL_AT + 35);
  });
});
