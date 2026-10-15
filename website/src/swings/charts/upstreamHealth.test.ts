import { beforeEach, describe, expect, it } from 'vitest';
import { allowEvery, markRouteDown, markRouteUp, resetUpstreamHealth, ROUTE_DOWN_MS, routeIsDown } from './upstreamHealth.js';

beforeEach(resetUpstreamHealth);

describe('a route that has failed', () => {
  it('is left alone for a minute and then given another chance', () => {
    expect(routeIsDown('trades', 1000)).toBe(false);
    markRouteDown('trades', 1000);
    expect(routeIsDown('trades', 1000)).toBe(true);
    expect(routeIsDown('trades', 1000 + ROUTE_DOWN_MS - 1)).toBe(true);
    expect(routeIsDown('trades', 1000 + ROUTE_DOWN_MS)).toBe(false);
  });

  it('is remembered per route, and forgotten as soon as it answers', () => {
    markRouteDown('trades', 0);
    expect(routeIsDown('candles', 1)).toBe(false);
    markRouteUp('trades');
    expect(routeIsDown('trades', 1)).toBe(false);
  });
});

describe('allowEvery', () => {
  it('says yes at most once per gap for each key', () => {
    expect(allowEvery('a', 15_000, 0)).toBe(true);
    expect(allowEvery('a', 15_000, 14_999)).toBe(false);
    expect(allowEvery('a', 15_000, 15_000)).toBe(true);
    // A refusal does not push the next yes further away.
    expect(allowEvery('a', 15_000, 20_000)).toBe(false);
    expect(allowEvery('a', 15_000, 30_000)).toBe(true);
    expect(allowEvery('b', 15_000, 30_001)).toBe(true);
  });
});
