/**
 * Weather for the roaming city: clear, cloudy, rain, storm and fog. It changes by itself every few minutes (clear days are the most
 * likely) and eases from one kind into the next, and the player can pick one. A storm brings lightning, with thunder that arrives after
 * the flash, later the further away the strike. Pure maths with an injectable random source, so it is tested without a screen; the
 * renderer and the sound read one answer per frame.
 */
import type { Moment } from './daylight.js';
import { mixColours } from './daylight.js';

export type WeatherName = 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog';
export const WEATHER_NAMES: WeatherName[] = ['clear', 'cloudy', 'rain', 'storm', 'fog'];
export const WEATHER_LABEL: Record<WeatherName, string> = { clear: 'Clear', cloudy: 'Cloudy', rain: 'Rain', storm: 'Storm', fog: 'Fog' };

export interface WeatherLevels {
  /** 0 to 1: how hard it rains. */
  rain: number;
  /** 0 to 1: how much of the sky is covered in grey cloud (and how dim the sun is). */
  overcast: number;
  /** 0 to 1: how thick the fog is. */
  fog: number;
  /** 0 to 1: how windy. */
  wind: number;
}

export const PRESET: Record<WeatherName, WeatherLevels> = {
  clear: { rain: 0, overcast: 0, fog: 0, wind: 0.1 },
  cloudy: { rain: 0, overcast: 0.6, fog: 0.1, wind: 0.3 },
  rain: { rain: 0.65, overcast: 0.85, fog: 0.35, wind: 0.5 },
  storm: { rain: 1, overcast: 1, fog: 0.45, wind: 0.9 },
  fog: { rain: 0, overcast: 0.5, fog: 1, wind: 0.05 },
};

/** What tends to follow what, when the weather changes by itself (each row adds up to one). */
const NEXT: Record<WeatherName, [WeatherName, number][]> = {
  clear: [['clear', 0.2], ['cloudy', 0.55], ['fog', 0.1], ['rain', 0.15]],
  cloudy: [['clear', 0.35], ['cloudy', 0.1], ['rain', 0.35], ['storm', 0.1], ['fog', 0.1]],
  rain: [['cloudy', 0.4], ['rain', 0.25], ['storm', 0.2], ['clear', 0.15]],
  storm: [['rain', 0.6], ['cloudy', 0.4]],
  fog: [['clear', 0.6], ['cloudy', 0.4]],
};

/** How long each kind of weather lasts when it changes by itself, in seconds of play: between these. */
export const MIN_SPELL_S = 120;
export const MAX_SPELL_S = 300;

export interface Thunder {
  /** Seconds from the flash until the sound reaches the player. */
  delay: number;
  /** 0 to 1: how loud, louder for a close strike. */
  power: number;
}

export interface WeatherNow extends WeatherLevels {
  name: WeatherName;
  /** True when the player chose it, so it stays until they change it. */
  held: boolean;
  /** 0 to 1: how bright the lightning is this instant. */
  flash: number;
}

/** The brightness of a lightning strike `t` seconds after it began: a quick flash, a dip, a second flash, then a fade. */
export function flashAt(t: number): number {
  if (t < 0 || t >= 0.5) return 0;
  if (t < 0.06) return t / 0.06;
  if (t < 0.14) return 1 - ((t - 0.06) / 0.08) * 0.7;
  if (t < 0.2) return 0.3 + ((t - 0.14) / 0.06) * 0.7;
  return 1 - (t - 0.2) / 0.3;
}

const approach = (v: number, target: number, ratePerSecond: number, dt: number): number => {
  const step = ratePerSecond * dt;
  return Math.abs(target - v) <= step ? target : v + Math.sign(target - v) * step;
};

export interface WeatherOptions {
  start?: WeatherName;
  /** Where random numbers come from (0 up to but not including 1); the browser's by default. */
  random?: () => number;
  /** Whether it changes by itself. */
  auto?: boolean;
}

export class WeatherSystem {
  private target: WeatherName;
  private cur: WeatherLevels;
  private auto: boolean;
  private spellLeft: number;
  private strikeIn = 6;
  private flashT = Infinity;
  private pending: Thunder[] = [];
  private readonly rand: () => number;

  constructor(o: WeatherOptions = {}) {
    this.rand = o.random ?? Math.random;
    this.target = o.start ?? 'clear';
    this.cur = { ...PRESET[this.target] };
    this.auto = o.auto ?? true;
    this.spellLeft = this.spell();
  }

  private spell(): number {
    return MIN_SPELL_S + this.rand() * (MAX_SPELL_S - MIN_SPELL_S);
  }

  /** Picks the weather: a name holds it until changed; 'auto' lets it change by itself again. */
  set(choice: WeatherName | 'auto'): void {
    if (choice === 'auto') {
      this.auto = true;
      this.spellLeft = this.spell();
      return;
    }
    this.auto = false;
    this.target = choice;
  }

  get name(): WeatherName {
    return this.target;
  }

  get isAuto(): boolean {
    return this.auto;
  }

  private pick(): WeatherName {
    const row = NEXT[this.target];
    let r = this.rand();
    for (const [n, p] of row) {
      if (r < p) return n;
      r -= p;
    }
    return row[row.length - 1]![0];
  }

  /** Moves the weather on by dt seconds and says what it is like now. */
  update(dt: number): WeatherNow {
    if (this.auto) {
      this.spellLeft -= dt;
      if (this.spellLeft <= 0) {
        this.target = this.pick();
        this.spellLeft = this.spell();
      }
    }
    const t = PRESET[this.target];
    // Rain and cloud build over several seconds, and fog and wind more slowly.
    this.cur.rain = approach(this.cur.rain, t.rain, 0.22, dt);
    this.cur.overcast = approach(this.cur.overcast, t.overcast, 0.12, dt);
    this.cur.fog = approach(this.cur.fog, t.fog, 0.1, dt);
    this.cur.wind = approach(this.cur.wind, t.wind, 0.15, dt);

    // Lightning, only in a storm (and the end of one): a strike every few seconds, and thunder behind it.
    this.flashT += dt;
    if (this.target === 'storm' && this.cur.rain > 0.85) {
      this.strikeIn -= dt;
      if (this.strikeIn <= 0) {
        this.strikeIn = 4 + this.rand() * 10;
        this.flashT = 0;
        const km = 0.15 + this.rand() * 2.4; // how far away, in kilometres
        this.pending.push({ delay: (km * 1000) / 340, power: Math.max(0.25, 1 - km / 2.6) });
      }
    }
    return { name: this.target, held: !this.auto, ...this.cur, flash: flashAt(this.flashT) };
  }

  /** Thunder that has been caused since last asked, for the sound to schedule. */
  takeThunder(): Thunder[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

const GREY = { zenith: '#7d8794', mid: '#9aa3ae', haze: '#aab1ba', sun: '#d9dde3', cloudLit: '#b9c0ca', cloudShade: '#5b6270' } as const;

/**
 * Changes the sky and light for the weather: grey cloud over the colours of the time of day (more so by day than at night, when it
 * only gets darker), a dimmer and softer sun, a brighter flash in lightning, and a cloud cover amount for the sky to draw.
 */
export function applyWeather(m: Moment, w: Pick<WeatherNow, 'overcast' | 'fog' | 'flash'>): Moment {
  const dayness = 1 - m.night;
  const c = Math.min(1, w.overcast * 0.9 + w.fog * 0.25) * dayness;
  const toGrey = (k: 'zenith' | 'mid' | 'haze' | 'sun'): string => mixColours([[m.sky[k], 1 - c], [GREY[k], c]]);
  const flash = Math.max(0, Math.min(1, w.flash));
  const lit = (hex: string): string => (flash > 0.01 ? mixColours([[hex, 1 - flash * 0.7], ['#e6edff', flash * 0.7]]) : hex);
  return {
    ...m,
    sky: {
      zenith: lit(toGrey('zenith')),
      mid: lit(toGrey('mid')),
      haze: lit(toGrey('haze')),
      sun: toGrey('sun'),
      cloudLit: mixColours([[m.sky.cloudLit, 1 - w.overcast * dayness], [GREY.cloudLit, w.overcast * dayness]]),
      cloudShade: mixColours([[m.sky.cloudShade, 1 - w.overcast * dayness], [GREY.cloudShade, w.overcast * dayness]]),
      glow: m.sky.glow * (1 - w.overcast),
    },
    lightStrength: Math.min(1.4, m.lightStrength * (1 - 0.7 * w.overcast) + flash * 0.7),
    ambient: m.ambient * (1 - 0.25 * w.overcast) + flash * 0.8,
    cover: w.overcast,
    flash,
  };
}

/** How far the view reaches in the weather: fog and heavy rain pull the fog in. Returns [near, far] in metres, never closer than 40. */
export function fogRange(base: [number, number], w: Pick<WeatherLevels, 'fog' | 'rain'>): [number, number] {
  const k = Math.min(0.85, w.fog * 0.8 + w.rain * 0.35);
  return [Math.max(10, base[0] * (1 - 0.85 * k)), Math.max(40, base[1] * (1 - 0.82 * k))];
}

/** How wet surfaces look, 0 to 1: they get wet as it rains and are slow to dry. */
export const wetness = (rain: number, previous: number, dt: number): number => (rain > previous ? Math.min(rain, previous + 0.12 * dt) : Math.max(rain, previous - 0.02 * dt));
