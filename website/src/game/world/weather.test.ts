import { describe, expect, it } from 'vitest';
import { BRIGHT } from './style.js';
import { momentAt } from './daylight.js';
import { MAX_SPELL_S, MIN_SPELL_S, PRESET, WEATHER_NAMES, WeatherSystem, applyWeather, flashAt, fogRange, wetness } from './weather.js';

/** A random source that returns a list of numbers in turn, so what happens next can be chosen. */
const seq = (...v: number[]) => {
  let i = 0;
  return () => v[i++ % v.length]!;
};
const run = (w: WeatherSystem, seconds: number, step = 0.5) => {
  let last = w.update(0);
  for (let t = 0; t < seconds; t += step) last = w.update(step);
  return last;
};

describe('the weather system', () => {
  it('starts clear and dry', () => {
    const w = new WeatherSystem({ random: seq(0.5) });
    const n = w.update(0.1);
    expect(n.name).toBe('clear');
    expect(n.rain).toBe(0);
    expect(n.overcast).toBe(0);
    expect(n.fog).toBe(0);
    expect(n.held).toBe(false);
    expect(n.flash).toBe(0);
  });

  it('builds up to rain gradually and clears gradually, never jumping', () => {
    const w = new WeatherSystem({ auto: false, random: seq(0.5) });
    w.set('rain');
    let prev = 0;
    let steps = 0;
    for (; steps < 400; steps++) {
      const n = w.update(0.1);
      expect(n.rain - prev).toBeLessThan(0.03); // small change each tenth of a second
      expect(n.rain).toBeGreaterThanOrEqual(prev);
      prev = n.rain;
      if (n.rain >= PRESET.rain.rain) break;
    }
    expect(prev).toBe(PRESET.rain.rain);
    expect(steps * 0.1).toBeGreaterThan(1.5); // takes a few seconds, not instant
    w.set('clear');
    expect(run(w, 20).rain).toBe(0);
    expect(run(w, 40).overcast).toBe(0);
  });

  it('a chosen weather is held for as long as you like, and auto brings the changes back', () => {
    const w = new WeatherSystem({ random: seq(0.5) });
    w.set('fog');
    const held = run(w, MAX_SPELL_S * 3);
    expect(held.name).toBe('fog');
    expect(held.held).toBe(true);
    expect(held.fog).toBe(1);
    expect(w.isAuto).toBe(false);
    w.set('auto');
    expect(w.isAuto).toBe(true);
    expect(run(w, MAX_SPELL_S + 10).held).toBe(false);
  });

  it('changes by itself after a spell, to something that can follow, and each spell lasts two to five minutes', () => {
    // First random picks a spell length of exactly the minimum (0), then the next weather with 0.3: from clear that is cloudy.
    const w = new WeatherSystem({ random: seq(0, 0.3, 0.9) });
    expect(w.update(MIN_SPELL_S - 1).name).toBe('clear');
    expect(w.update(2).name).toBe('cloudy');
    // The following spell is 0.9 of the way between the minimum and the maximum.
    const before = w.update(0).name;
    expect(before).toBe('cloudy');
    expect(w.update(MIN_SPELL_S + 0.9 * (MAX_SPELL_S - MIN_SPELL_S) - 5).name).toBe('cloudy');
  });

  it('only ever picks weather that is listed, and every kind can be reached', () => {
    const seen = new Set<string>();
    for (const r of [0.01, 0.2, 0.4, 0.6, 0.8, 0.99]) {
      for (const start of WEATHER_NAMES) {
        const w = new WeatherSystem({ start, random: seq(0, r) });
        const n = w.update(MIN_SPELL_S + 1);
        expect(WEATHER_NAMES).toContain(n.name);
        seen.add(n.name);
      }
    }
    expect([...seen].sort()).toEqual([...WEATHER_NAMES].sort());
  });

  it('flashes and thunders only in a storm: thunder comes after the flash, later when it is further away', () => {
    const calm = new WeatherSystem({ auto: false, random: seq(0.5) });
    calm.set('rain');
    run(calm, 120);
    expect(calm.takeThunder()).toEqual([]);
    const storm = new WeatherSystem({ auto: false, random: seq(0.9, 0.1, 0.9, 0.9) });
    storm.set('storm');
    let flashed = false;
    for (let t = 0; t < 60; t += 0.05) {
      const n = storm.update(0.05);
      if (n.flash > 0.5) flashed = true;
    }
    expect(flashed).toBe(true);
    const th = storm.takeThunder();
    expect(th.length).toBeGreaterThan(2);
    for (const t of th) {
      expect(t.delay).toBeGreaterThan(0.4); // never at the same instant: sound is slower than light
      expect(t.delay).toBeLessThan(8);
      expect(t.power).toBeGreaterThanOrEqual(0.25);
      expect(t.power).toBeLessThanOrEqual(1);
    }
    expect(storm.takeThunder()).toEqual([]); // each peal is handed over once
  });

  it('shapes lightning as a flash, a dip, a second flash and a fade, and nothing outside it', () => {
    expect(flashAt(-1)).toBe(0);
    expect(flashAt(0)).toBe(0);
    expect(flashAt(0.06)).toBeCloseTo(1);
    expect(flashAt(0.14)).toBeCloseTo(0.3);
    expect(flashAt(0.2)).toBeCloseTo(1);
    expect(flashAt(0.35)).toBeLessThan(flashAt(0.25));
    expect(flashAt(0.5)).toBe(0);
    expect(flashAt(5)).toBe(0);
    for (let t = 0; t < 0.5; t += 0.01) expect(flashAt(t)).toBeLessThanOrEqual(1);
  });
});

describe('what weather does to the view', () => {
  const noon = () => momentAt(12, BRIGHT.sky);
  const dry = { overcast: 0, fog: 0, flash: 0 };

  it('leaves a clear sky exactly as it was', () => {
    const m = noon();
    const w = applyWeather(m, dry);
    expect(w.sky).toEqual({ ...m.sky, glow: m.sky.glow });
    expect(w.lightStrength).toBe(m.lightStrength);
    expect(w.ambient).toBe(m.ambient);
    expect(w.cover).toBe(0);
  });

  it('turns the sky grey, dims the sun and removes its glare under heavy cloud, by day', () => {
    const m = noon();
    const w = applyWeather(m, { overcast: 1, fog: 0, flash: 0 });
    const chroma = (hex: string): number => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return Math.max(...c) - Math.min(...c);
    };
    expect(chroma(w.sky.zenith)).toBeLessThan(chroma(m.sky.zenith) / 2); // much less blue
    expect(w.lightStrength).toBeLessThan(m.lightStrength * 0.4);
    expect(w.sky.glow).toBe(0);
    expect(w.cover).toBe(1);
    expect(w.ambient).toBeLessThan(m.ambient);
  });

  it('at night, cloud makes it darker, not lighter', () => {
    const m = momentAt(1, BRIGHT.sky);
    const w = applyWeather(m, { overcast: 1, fog: 0.5, flash: 0 });
    const lum = (hex: string): number => [1, 3, 5].reduce((s, i) => s + parseInt(hex.slice(i, i + 2), 16), 0);
    expect(lum(w.sky.zenith)).toBeLessThanOrEqual(lum(m.sky.zenith) + 3);
    expect(lum(w.sky.haze)).toBeLessThanOrEqual(lum(m.sky.haze) + 3);
  });

  it('lights everything up in a lightning flash, and the flash is gone when it is over', () => {
    const m = momentAt(1, BRIGHT.sky);
    const flash = applyWeather(m, { overcast: 1, fog: 0, flash: 1 });
    const calm = applyWeather(m, { overcast: 1, fog: 0, flash: 0 });
    expect(flash.ambient).toBeGreaterThan(calm.ambient + 0.5);
    expect(flash.lightStrength).toBeGreaterThan(calm.lightStrength + 0.4);
    expect(parseInt(flash.sky.haze.slice(1, 3), 16)).toBeGreaterThan(parseInt(calm.sky.haze.slice(1, 3), 16) + 80);
    expect(flash.flash).toBe(1);
    expect(applyWeather(m, { overcast: 1, fog: 0, flash: 5 }).flash).toBe(1); // capped
    expect(applyWeather(m, { overcast: 1, fog: 0, flash: 0 }).flash).toBe(0);
  });

  it('pulls the fog in for fog and for heavy rain, but never shuts the view down completely', () => {
    expect(fogRange([260, 1100], { fog: 0, rain: 0 })).toEqual([260, 1100]);
    const rain = fogRange([260, 1100], { fog: 0.35, rain: 0.65 });
    const thick = fogRange([260, 1100], { fog: 1, rain: 0 });
    expect(rain[1]).toBeLessThan(1100);
    expect(thick[1]).toBeLessThan(rain[1]);
    const worst = fogRange([140, 950], { fog: 1, rain: 1 });
    expect(worst[0]).toBeGreaterThanOrEqual(10);
    expect(worst[1]).toBeGreaterThanOrEqual(40);
    expect(worst[1]).toBeGreaterThan(worst[0]);
  });

  it('gets wet while it rains and dries slowly after', () => {
    let w = 0;
    for (let i = 0; i < 100; i++) w = wetness(0.65, w, 0.1);
    expect(w).toBeCloseTo(0.65, 1);
    const wetNow = w;
    for (let i = 0; i < 100; i++) w = wetness(0, w, 0.1); // 10 s of dry weather
    expect(w).toBeGreaterThan(wetNow - 0.25);
    expect(w).toBeLessThan(wetNow);
    for (let i = 0; i < 4000; i++) w = wetness(0, w, 0.1);
    expect(w).toBe(0);
    expect(wetness(1, 0, 0.1)).toBeLessThan(0.02); // never instantly wet
  });
});
