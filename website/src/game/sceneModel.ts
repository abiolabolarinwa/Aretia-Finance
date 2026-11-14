/**
 * What a 3D scene contains, worked out as plain data so it can be checked without a graphics card: the city diorama (water, ground,
 * buildings, hills, trees and the city's real landmarks placed by their coordinates) and the three chambers a mission can send a
 * player into (underwater, underground, a vault). The same city always gives the same scene. The drawing itself is in scene.ts.
 *
 * A diorama is a stylised model, not a survey: building positions are generated to suit the kind of city, and only the landmarks stand
 * where the real thing is (their positions are approximate).
 */
import type { City, SceneKind } from './cities.js';
import { seeded } from './challenges.js';

export interface Rect { x: number; z: number; w: number; d: number }
export interface Box extends Rect { h: number; color: string }
export interface Hill { x: number; z: number; r: number; h: number }
export interface Tree { x: number; z: number; s: number }
export interface Mark { name: string; x: number; z: number; h: number }

export interface CityModel {
  kind: SceneKind;
  width: number;
  depth: number;
  ground: string;
  sky: string;
  water: Rect[];
  boxes: Box[];
  hills: Hill[];
  trees: Tree[];
  marks: Mark[];
  /** Turns a longitude and latitude in this city into a place in the scene. */
  project(lng: number, lat: number): [number, number];
}

export const MAX_BOXES = 700;
const WIDTH = 120;
const CELL = 3.4;

export function projector(city: City): { width: number; depth: number; project(lng: number, lat: number): [number, number] } {
  const [w, s, e, n] = city.bounds;
  const midLat = (s + n) / 2;
  const kmEast = (e - w) * 111.32 * Math.cos((midLat * Math.PI) / 180);
  const kmNorth = (n - s) * 110.57;
  const depth = WIDTH * Math.min(1.6, Math.max(0.6, kmNorth / kmEast));
  return { width: WIDTH, depth, project: (lng, lat) => [((lng - w) / (e - w) - 0.5) * WIDTH, -((lat - s) / (n - s) - 0.5) * depth] };
}

const inRect = (r: Rect, x: number, z: number, pad = 0): boolean => Math.abs(x - r.x) <= r.w / 2 + pad && Math.abs(z - r.z) <= r.d / 2 + pad;
const mix = (a: string, b: string, t: number): string => {
  const p = (c: string, i: number): number => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
  const h = (i: number): string => Math.round(p(a, i) * (1 - t) + p(b, i) * t).toString(16).padStart(2, '0');
  return `#${h(0)}${h(1)}${h(2)}`;
};

interface Preset {
  ground: string;
  sky: string;
  water(w: number, d: number): Rect[];
  hills(rand: () => number, w: number, d: number): Hill[];
  /** How built-up a spot is, from 0 to 1. */
  density(x: number, z: number, w: number, d: number): number;
  height: number;
  trees: number;
}

const ring = (x: number, z: number, w: number, d: number): number => Math.max(0, 1 - Math.hypot(x / (w / 2), z / (d / 2)) * 1.05);
const river = (w: number, d: number, amp: number, thick: number, z0 = 0): Rect[] => Array.from({ length: 24 }, (_, i) => {
  const x = -w / 2 + ((i + 0.5) / 24) * w;
  return { x, z: z0 + Math.sin((i / 24) * Math.PI * 2) * amp * d, w: w / 24 + 0.4, d: thick };
});

const PRESETS: Record<SceneKind, Preset> = {
  lagoon: { ground: '#6f8f5a', sky: '#bfe3f2', water: (w, d) => [{ x: -w * 0.12, z: -d * 0.04, w: w * 0.42, d: d * 0.3 }, { x: 0, z: d * 0.46, w, d: d * 0.14 }], hills: () => [], density: (x, z, w, d) => ring(x, z, w, d) * 0.9, height: 5, trees: 60 },
  'harbour-towers': { ground: '#7d8590', sky: '#c9d6e8', water: (w, d) => [{ x: -w * 0.46, z: 0, w: w * 0.08, d }, { x: 0, z: d * 0.47, w, d: d * 0.08 }, { x: w * 0.12, z: -d * 0.05, w: w * 0.05, d: d * 0.8 }], hills: () => [], density: (x, z, w, d) => ring(x, z, w, d) * 1.1, height: 14, trees: 40 },
  'savanna-edge': { ground: '#b5a45a', sky: '#d8ecf5', water: () => [], hills: () => [], density: (x, z, w, d) => ring(x, z - d * 0.1, w * 0.8, d * 0.7) * 0.8, height: 6, trees: 140 },
  'harbour-hills': { ground: '#5d7a55', sky: '#cbd9e2', water: (w, d) => [{ x: 0, z: d * 0.02, w, d: d * 0.14 }], hills: (r, w, d) => Array.from({ length: 7 }, (_, i) => ({ x: (r() - 0.5) * w * 0.9, z: (i % 2 ? -1 : 1) * (d * 0.25 + r() * d * 0.15) - (i % 2 ? 0 : -d * 0.08), r: 9 + r() * 8, h: 8 + r() * 10 })), density: (x, z, w, d) => ring(x, z, w, d) * 1.2, height: 12, trees: 30 },
  'river-city': { ground: '#78925f', sky: '#c4d0dc', water: (w, d) => river(w, d, 0.08, d * 0.07), hills: () => [], density: (x, z, w, d) => ring(x, z, w, d) * 1.0, height: 7, trees: 90 },
  'desert-towers': { ground: '#d9c08a', sky: '#f2e3c2', water: (w, d) => [{ x: -w * 0.32, z: -d * 0.4, w: w * 0.4, d: d * 0.22 }], hills: (r, w, d) => Array.from({ length: 12 }, () => ({ x: (r() - 0.5) * w, z: (r() - 0.2) * d * 0.9, r: 10 + r() * 12, h: 1.5 + r() * 3 })), density: (x, z, w, d) => ring(x + w * 0.1, z - d * 0.05, w * 0.9, d * 0.7) * 1.0, height: 18, trees: 10 },
  boulevards: { ground: '#9aa58a', sky: '#d7dce6', water: (w, d) => river(w, d, 0.1, d * 0.05), hills: () => [], density: (x, z, w, d) => ring(x, z, w, d) * 1.05, height: 4.5, trees: 110 },
  'beach-bay': { ground: '#e3d6a8', sky: '#bfe8ee', water: (w, d) => [{ x: w * 0.38, z: 0, w: w * 0.28, d }, { x: -w * 0.1, z: d * 0.47, w: w * 0.8, d: d * 0.1 }], hills: () => [], density: (x, z, w, d) => ring(x - w * 0.1, z, w * 0.9, d) * 0.8, height: 5, trees: 90 },
  'old-walls': { ground: '#b79f78', sky: '#d9e4ea', water: () => [], hills: () => [], density: (x, z, w, d) => Math.max(0, 1 - Math.hypot(x / (w * 0.5), z / (d * 0.5))) * 0.95, height: 3.5, trees: 50 },
  skyline: { ground: '#7f8a78', sky: '#cdd8e2', water: () => [], hills: () => [], density: (x, z, w, d) => ring(x, z, w, d) * 0.9, height: 8, trees: 40 },
};

export function buildCityModel(city: City): CityModel {
  const { width, depth, project } = projector(city);
  const p = PRESETS[city.scene] ?? PRESETS.skyline;
  const rand = seeded(`scene|${city.id}|${city.scene}`);
  const water = p.water(width, depth);
  const hills = p.hills(rand, width, depth);
  const boxes: Box[] = [];
  const base = city.tint[0];
  for (let gx = -width / 2 + CELL; gx < width / 2 - CELL; gx += CELL) {
    for (let gz = -depth / 2 + CELL; gz < depth / 2 - CELL; gz += CELL) {
      const x = gx + (rand() - 0.5) * 0.8;
      const z = gz + (rand() - 0.5) * 0.8;
      const dens = p.density(x, z, width, depth);
      if (rand() > dens + 0.05 || water.some((r) => inRect(r, x, z, 1))) continue;
      // Boulevards: leave straight avenues open from the centre.
      if (city.scene === 'boulevards' && [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4].some((a) => Math.abs(Math.sin(Math.atan2(z, x) - a)) < 0.07) && Math.hypot(x, z) > 6) continue;
      const h = Math.max(0.8, p.height * (0.25 + dens * (0.4 + rand() * 0.9)));
      boxes.push({ x, z, w: CELL * (0.55 + rand() * 0.3), d: CELL * (0.55 + rand() * 0.3), h, color: mix(base, '#d8d8d8', 0.35 + rand() * 0.4) });
      if (boxes.length >= MAX_BOXES) break;
    }
    if (boxes.length >= MAX_BOXES) break;
  }
  if (city.scene === 'old-walls') {
    // The walled old town: a ring of wall blocks.
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const x = Math.cos(a) * width * 0.16;
      const z = Math.sin(a) * width * 0.16;
      if (boxes.length < MAX_BOXES + 64) boxes.push({ x, z, w: 3.2, d: 3.2, h: 2.4, color: mix(base, '#e8d9b0', 0.6) });
    }
  }
  const trees: Tree[] = [];
  for (let i = 0; i < p.trees * 4 && trees.length < p.trees; i++) {
    const x = (rand() - 0.5) * width * 0.95;
    const z = (rand() - 0.5) * depth * 0.95;
    if (water.some((r) => inRect(r, x, z, 0.5)) || boxes.some((b) => inRect(b, x, z, 0.4))) continue;
    trees.push({ x, z, s: 0.7 + rand() * 0.9 });
  }
  const marks: Mark[] = city.landmarks.map((m, i) => {
    const [x, z] = project(m.lng, m.lat);
    return { name: m.name, x, z, h: p.height * 0.9 + 6 + (i % 3) * 2 };
  });
  return { kind: city.scene, width, depth, ground: p.ground, sky: p.sky, water, boxes, hills, trees, marks, project };
}

// ---------------------------------------------------------------- chambers

export type ChamberKind = 'underwater' | 'underground' | 'vault';
export const CHAMBERS: readonly ChamberKind[] = ['underwater', 'underground', 'vault'];
export const isChamber = (v: unknown): v is ChamberKind => typeof v === 'string' && (CHAMBERS as readonly string[]).includes(v);

export interface Prop { type: 'rock' | 'kelp' | 'crystal' | 'stalactite' | 'column' | 'coin'; x: number; z: number; h: number; r: number; color: string }
export interface ChamberModel {
  kind: ChamberKind;
  floor: string;
  fog: string;
  fogDensity: number;
  light: { color: string; intensity: number };
  props: Prop[];
  /** Specks that drift: bubbles under water, dust elsewhere. */
  particles: number;
  title: string;
  caption: string;
}

const INFO: Record<ChamberKind, { floor: string; fog: string; fogDensity: number; light: { color: string; intensity: number }; title: string; caption: string; particles: number }> = {
  underwater: { floor: '#c9b98a', fog: '#0a4a6e', fogDensity: 0.035, light: { color: '#9fe4ff', intensity: 1.2 }, title: 'Under the water', caption: 'A simulated dive. Nobody has to go near real water: it is only a scene to read the clue in.', particles: 140 },
  underground: { floor: '#4b4038', fog: '#14100e', fogDensity: 0.05, light: { color: '#ffb768', intensity: 1.6 }, title: 'Underground', caption: 'A simulated mine. Nobody has to go underground or dig: it is only a scene to read the clue in.', particles: 80 },
  vault: { floor: '#2b2a35', fog: '#0d0d16', fogDensity: 0.03, light: { color: '#ffe9a8', intensity: 1.4 }, title: 'The vault', caption: 'A simulated vault. A scene to read the clue in.', particles: 60 },
};

export function buildChamberModel(kind: ChamberKind, seed = 'chamber'): ChamberModel {
  const rand = seeded(`${kind}|${seed}`);
  const info = INFO[kind];
  const props: Prop[] = [];
  const ring = (n: number, minR: number, maxR: number, make: (x: number, z: number, i: number) => Prop): void => {
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const r = minR + rand() * (maxR - minR);
      props.push(make(Math.cos(a) * r, Math.sin(a) * r, i));
    }
  };
  if (kind === 'underwater') {
    ring(26, 4, 22, (x, z) => ({ type: 'kelp', x, z, h: 3 + rand() * 5, r: 0.12, color: '#2f8f5a' }));
    ring(16, 5, 24, (x, z) => ({ type: 'rock', x, z, h: 0.6 + rand() * 1.8, r: 0.6 + rand() * 1.2, color: '#5a6b70' }));
  } else if (kind === 'underground') {
    ring(22, 3, 20, (x, z) => ({ type: 'stalactite', x, z, h: 2 + rand() * 4, r: 0.3 + rand() * 0.5, color: '#6b5a4c' }));
    ring(14, 4, 18, (x, z, i) => ({ type: 'crystal', x, z, h: 0.8 + rand() * 1.6, r: 0.25 + rand() * 0.3, color: ['#7fe0ff', '#b48cff', '#7dffb0'][i % 3]! }));
    ring(10, 5, 20, (x, z) => ({ type: 'rock', x, z, h: 0.5 + rand() * 1.4, r: 0.6 + rand(), color: '#4a4038' }));
  } else {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      props.push({ type: 'column', x: Math.cos(a) * 11, z: Math.sin(a) * 11, h: 7, r: 0.7, color: '#6e6a7a' });
    }
    ring(18, 2, 8, (x, z) => ({ type: 'coin', x, z, h: 0.08, r: 0.5 + rand() * 0.3, color: '#e0b43c' }));
  }
  // The thing the scene is about, at its centre.
  props.push({ type: 'coin', x: 0, z: 0, h: 0.25, r: 1.1, color: '#f2c94c' });
  return { kind, floor: info.floor, fog: info.fog, fogDensity: info.fogDensity, light: info.light, props, particles: info.particles, title: info.title, caption: info.caption };
}
