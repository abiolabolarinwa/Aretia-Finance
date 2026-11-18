/**
 * Time of day for the roaming city: where the sun and moon are, what colour the sky, haze and light are, and how dark it is, for any hour
 * from 0 to 24. A game day passes in about 24 minutes of play, starting from the player's own local hour. Pure, so it is tested without
 * a screen; the renderer reads one answer per frame and applies it.
 *
 * Sky colours come from the chosen look's daytime sky, blended with warm dusk colours as the sun gets low and deep blue as it sets.
 */
import type { Palette } from './style.js';

type SkyColours = Palette['sky'];

export interface Moment {
  /** Hours since midnight, 0 to 24. */
  hours: number;
  /** Sun and moon directions, from the player towards them. The one that is below the horizon points downwards. */
  sun: [number, number, number];
  moon: [number, number, number];
  sky: SkyColours;
  /** 0 in full day to 1 in deep night: for lit windows, street lamps, headlights and stars. */
  night: number;
  /** The direction the main light comes from (the sun by day, the moon at night), and its colour and strength (0 to 1 of the look's sun). */
  lightDir: [number, number, number];
  lightColour: string;
  lightStrength: number;
  /** How much of the look's sky light, reflections and brightness is left (never fully dark, so the city can still be played at night). */
  ambient: number;
  exposure: number;
  /** 0 to 1: how much of the sky is covered in cloud (the weather sets it; 0 for a clear sky). */
  cover: number;
  /** 0 to 1: how bright a lightning flash is this instant (the weather sets it). */
  flash: number;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
export const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

const hexToRgb = (h: string): [number, number, number] => {
  const v = h.replace('#', '');
  const n = parseInt(v.length === 3 ? v.split('').map((c) => c + c).join('') : v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbToHex = (c: [number, number, number]): string => `#${c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('')}`;

/** Mixes colours by weights that need not add up to one. */
export function mixColours(parts: [string, number][]): string {
  let total = 0;
  const acc: [number, number, number] = [0, 0, 0];
  for (const [hex, w] of parts) {
    if (w <= 0) continue;
    const c = hexToRgb(hex);
    acc[0] += c[0] * w;
    acc[1] += c[1] * w;
    acc[2] += c[2] * w;
    total += w;
  }
  if (total <= 0) return parts[0]![0];
  return rgbToHex([acc[0] / total, acc[1] / total, acc[2] / total]);
}

const DUSK: Pick<SkyColours, 'zenith' | 'mid' | 'haze' | 'sun' | 'cloudLit' | 'cloudShade'> = { zenith: '#3b4f8f', mid: '#d9876e', haze: '#f2a97a', sun: '#ff9a5a', cloudLit: '#ffb98a', cloudShade: '#7a6a8c' };
const NIGHT: Pick<SkyColours, 'zenith' | 'mid' | 'haze' | 'sun' | 'cloudLit' | 'cloudShade'> = { zenith: '#050b1e', mid: '#0d1a3b', haze: '#18244a', sun: '#aab8ff', cloudLit: '#2b3a66', cloudShade: '#101a35' };

/** The sun's direction at an hour: it rises in the east at 6, is highest at 12 and sets in the west at 18, then travels under the world. */
export function sunDirection(hours: number): [number, number, number] {
  const e = Math.sin(((hours - 6) / 24) * Math.PI * 2) * 0.95; // elevation in radians, up to about 54 degrees
  const theta = (Math.PI * (hours - 6)) / 12; // from east, through south at noon, to west
  const c = Math.cos(e);
  const x = Math.cos(theta) * c;
  const z = Math.sin(theta) * c;
  const y = Math.sin(e);
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

/** The local hour of day for a date, as a decimal (14.5 is half past two). */
export const hoursOf = (d: Date): number => d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;

export function formatClock(hours: number): string {
  const h = ((hours % 24) + 24) % 24;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function momentAt(hoursIn: number, day: SkyColours): Moment {
  const hours = ((hoursIn % 24) + 24) % 24;
  const sun = sunDirection(hours);
  const moon: [number, number, number] = [-sun[0], -sun[1], -sun[2]];
  const e = sun[1];
  const dayW = smoothstep(0.1, 0.4, e);
  const nightW = 1 - smoothstep(-0.2, -0.02, e);
  const duskW = Math.max(0, 1 - dayW - nightW);
  const mix = (k: 'zenith' | 'mid' | 'haze' | 'sun' | 'cloudLit' | 'cloudShade'): string =>
    mixColours([[day[k], dayW], [DUSK[k], duskW], [NIGHT[k], nightW]]);
  const sky: SkyColours = {
    zenith: mix('zenith'),
    mid: mix('mid'),
    haze: mix('haze'),
    sun: mix('sun'),
    cloudLit: mix('cloudLit'),
    cloudShade: mix('cloudShade'),
    glow: day.glow * (1 - nightW),
  };
  const sunUp = smoothstep(-0.03, 0.22, e);
  const moonLight = nightW * 0.16;
  const useSun = sunUp > moonLight;
  return {
    hours,
    sun,
    moon,
    sky,
    night: 1 - smoothstep(-0.1, 0.1, e),
    lightDir: useSun ? sun : moon,
    lightColour: useSun ? mixColours([[day.sun, dayW], [DUSK.sun, 1 - dayW]]) : NIGHT.sun,
    lightStrength: Math.max(sunUp, moonLight),
    ambient: 0.22 + 0.78 * smoothstep(-0.1, 0.3, e),
    exposure: 1 + 0.25 * nightW,
    cover: 0,
    flash: 0,
  };
}

/** A game clock: starts at the player's local hour and runs fast, so a whole day takes about 24 minutes of play. */
export const GAME_HOURS_PER_REAL_SECOND = 1 / 60;

export interface Clock {
  hours(): number;
  /** Moves the clock on by a number of real seconds. */
  tick(seconds: number): void;
  /** Jumps forward by game hours (to skip the night, or to see it). */
  skip(hours: number): void;
}

export function makeClock(startHours: number, rate = GAME_HOURS_PER_REAL_SECOND): Clock {
  let h = ((startHours % 24) + 24) % 24;
  return {
    hours: () => h,
    tick(seconds) {
      h = (h + seconds * rate) % 24;
    },
    skip(hours) {
      h = (((h + hours) % 24) + 24) % 24;
    },
  };
}
