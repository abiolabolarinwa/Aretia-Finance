import { describe, expect, it } from 'vitest';
import { BRIGHT, REAL } from './style.js';
import { formatClock, hoursOf, makeClock, mixColours, momentAt, smoothstep, sunDirection } from './daylight.js';

describe('the sun through the day', () => {
  it('rises in the east, is high in the south at noon, sets in the west, and is under the world at midnight', () => {
    const dawn = sunDirection(6);
    expect(dawn[0]).toBeGreaterThan(0.95); // east
    expect(Math.abs(dawn[1])).toBeLessThan(0.05); // on the horizon
    const noon = sunDirection(12);
    expect(noon[1]).toBeGreaterThan(0.7); // high
    expect(noon[2]).toBeGreaterThan(0.5); // south is +z
    const dusk = sunDirection(18);
    expect(dusk[0]).toBeLessThan(-0.95); // west
    expect(Math.abs(dusk[1])).toBeLessThan(0.05);
    expect(sunDirection(0)[1]).toBeLessThan(-0.7);
    for (const h of [0, 3, 6, 9, 12, 15, 18, 21]) expect(Math.hypot(...sunDirection(h))).toBeCloseTo(1, 5);
  });

  it('reads the local hour and formats a clock', () => {
    expect(hoursOf(new Date(2026, 10, 17, 14, 30, 0))).toBeCloseTo(14.5);
    expect(formatClock(14.5)).toBe('14:30');
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(23.999)).toBe('23:59');
    expect(formatClock(25.25)).toBe('01:15');
    expect(formatClock(-1)).toBe('23:00');
  });

  it('mixes colours by weight, and a zero weight leaves a colour out', () => {
    expect(mixColours([['#000000', 1], ['#ffffff', 1]])).toBe('#808080');
    expect(mixColours([['#ff0000', 1], ['#0000ff', 0]])).toBe('#ff0000');
    expect(mixColours([['#ff0000', 3], ['#0000ff', 1]])).toBe('#bf0040');
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5);
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
  });
});

describe('the sky and light at each hour', () => {
  it('is the look\'s own daytime sky and sun at midday', () => {
    const m = momentAt(12, BRIGHT.sky);
    expect(m.night).toBe(0);
    expect(m.sky.zenith).toBe(BRIGHT.sky.zenith.toLowerCase());
    expect(m.sky.haze).toBe(BRIGHT.sky.haze.toLowerCase());
    expect(m.lightStrength).toBe(1);
    expect(m.lightDir).toEqual(m.sun);
    expect(m.ambient).toBeCloseTo(1, 1);
    expect(m.exposure).toBe(1);
  });

  it('turns warm and orange as the sun gets low, then deep blue with stars at night', () => {
    const dusk = momentAt(17.8, REAL.sky);
    const noon = momentAt(12, REAL.sky);
    const night = momentAt(1, REAL.sky);
    const red = (hex: string): number => parseInt(hex.slice(1, 3), 16);
    const blue = (hex: string): number => parseInt(hex.slice(5, 7), 16);
    expect(red(dusk.sky.haze)).toBeGreaterThan(blue(dusk.sky.haze)); // warm
    expect(night.night).toBe(1);
    expect(blue(night.sky.zenith)).toBeGreaterThan(red(night.sky.zenith));
    expect(parseInt(night.sky.haze.slice(1, 3), 16)).toBeLessThan(parseInt(noon.sky.haze.slice(1, 3), 16) / 2); // much darker
    expect(night.sky.glow).toBe(0); // no sun glare at night
    expect(noon.sky.glow).toBe(REAL.sky.glow);
  });

  it('lights the night with the moon, which is dim but never nothing, and keeps some ambient light', () => {
    const m = momentAt(0, BRIGHT.sky);
    expect(m.lightDir[1]).toBeGreaterThan(0.5); // the moon is up when the sun is down
    expect(m.lightDir).toEqual(m.moon);
    expect(m.lightStrength).toBeGreaterThan(0.1);
    expect(m.lightStrength).toBeLessThan(0.25);
    expect(m.ambient).toBeGreaterThanOrEqual(0.22);
    expect(m.ambient).toBeLessThan(0.3);
    expect(m.exposure).toBeGreaterThan(1);
  });

  it('changes smoothly: no hour-to-hour jump in how dark it is, and lamps come on around dusk and off around dawn', () => {
    let prev = momentAt(0, BRIGHT.sky);
    for (let h = 0.1; h <= 24; h += 0.1) {
      const m = momentAt(h, BRIGHT.sky);
      expect(Math.abs(m.night - prev.night)).toBeLessThan(0.2);
      expect(Math.abs(m.lightStrength - prev.lightStrength)).toBeLessThan(0.2);
      expect(Math.abs(m.ambient - prev.ambient)).toBeLessThan(0.1);
      prev = m;
    }
    expect(momentAt(15, BRIGHT.sky).night).toBe(0);
    expect(momentAt(19.5, BRIGHT.sky).night).toBeGreaterThan(0.9);
    expect(momentAt(4.5, BRIGHT.sky).night).toBeGreaterThan(0.9);
    expect(momentAt(8, BRIGHT.sky).night).toBe(0);
  });

  it('wraps round midnight', () => {
    expect(momentAt(25, BRIGHT.sky).hours).toBeCloseTo(1);
    expect(momentAt(-2, BRIGHT.sky).hours).toBeCloseTo(22);
  });
});

describe('the game clock', () => {
  it('starts at the given hour, runs a day in about 24 minutes, and can skip ahead', () => {
    const c = makeClock(10);
    expect(c.hours()).toBe(10);
    c.tick(60); // one real minute is one game hour
    expect(c.hours()).toBeCloseTo(11);
    c.tick(60 * 14);
    expect(c.hours()).toBeCloseTo(1); // wrapped past midnight
    c.skip(5);
    expect(c.hours()).toBeCloseTo(6);
    c.skip(-8);
    expect(c.hours()).toBeCloseTo(22);
    expect(makeClock(30).hours()).toBe(6);
  });
});
