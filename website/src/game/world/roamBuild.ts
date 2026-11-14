/**
 * Turns the real city's data (buildings, streets, water, parks) into 3D shapes for the roaming view. The shapes are plain three.js
 * geometry (no screen needed), merged by area so a whole neighbourhood is a handful of draw calls. Also splits a tile into small cells so
 * only the streets around the player are built, and the rest are made as the player gets near.
 */
import type * as T from 'three';
import type { Area, Building, Road, TileWorld, WaterLine } from './worldData.js';
import type { Pt } from './mvt.js';

type Three = typeof import('three');

export const CELL_M = 200;
export const cellKey = (x: number, z: number): string => `${Math.floor(x / CELL_M)},${Math.floor(z / CELL_M)}`;
export const cellCentre = (key: string): [number, number] => {
  const [cx, cz] = key.split(',').map(Number) as [number, number];
  return [(cx + 0.5) * CELL_M, (cz + 0.5) * CELL_M];
};

export interface Cell {
  buildings: Building[];
  /** Streets cut into single segments, each in the cell its middle is in. */
  roads: Road[];
}

/** Sorts a tile's buildings and streets into cells. */
export function bucketTile(world: TileWorld): Map<string, Cell> {
  const cells = new Map<string, Cell>();
  const cell = (key: string): Cell => {
    let c = cells.get(key);
    if (!c) {
      c = { buildings: [], roads: [] };
      cells.set(key, c);
    }
    return c;
  };
  for (const b of world.buildings) {
    const o = b.rings[0]!;
    let x = 0;
    let z = 0;
    for (const p of o) {
      x += p[0];
      z += p[1];
    }
    cell(cellKey(x / o.length, z / o.length)).buildings.push(b);
  }
  for (const r of world.roads) {
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1]!;
      const b = r.pts[i]!;
      cell(cellKey((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)).roads.push({ pts: [a, b], width: r.width, cls: r.cls });
    }
  }
  return cells;
}

const ROAD_COLOUR: Record<string, string> = { motorway: '#2a2a2e', trunk: '#2c2c30', primary: '#2f2f33', secondary: '#34343a', tertiary: '#3a3a40', minor: '#424248', service: '#4c4c52', track: '#6f6a58', path: '#8d877a', pier: '#7a7468' };
export const AREA_COLOUR = { grass: '#3d6a3a', wood: '#2c5530', sand: '#cdb98b', paving: '#8e8e94' } as const;
export const WATER_COLOUR = '#1f5d86';

class Buf {
  pos: number[] = [];
  col: number[] = [];
  tri(a: number[], b: number[], c: number[], colour: [number, number, number]): void {
    this.pos.push(...a, ...b, ...c);
    this.col.push(...colour, ...colour, ...colour);
  }
  quad(a: number[], b: number[], c: number[], d: number[], colour: [number, number, number]): void {
    this.tri(a, b, c, colour);
    this.tri(a, c, d, colour);
  }
  get empty(): boolean {
    return this.pos.length === 0;
  }
  geometry(three: Three): T.BufferGeometry {
    const g = new three.BufferGeometry();
    g.setAttribute('position', new three.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new three.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
}

const rgb = (three: Three, hex: string, scale = 1): [number, number, number] => {
  const c = new three.Color(hex);
  return [c.r * scale, c.g * scale, c.b * scale];
};

/** Flat triangles for a polygon with courtyards, at a height. */
function fill(three: Three, buf: Buf, rings: Pt[][], y: number, colour: [number, number, number]): void {
  const contour = rings[0]!.map((p) => new three.Vector2(p[0], p[1]));
  const holes = rings.slice(1).map((r) => r.map((p) => new three.Vector2(p[0], p[1])));
  let faces: number[][];
  try {
    faces = three.ShapeUtils.triangulateShape(contour, holes);
  } catch {
    return;
  }
  const all = [...contour, ...holes.flat()];
  for (const [a, b, c] of faces) {
    const A = all[a!]!;
    const B = all[b!]!;
    const C = all[c!]!;
    buf.tri([A.x, y, A.y], [B.x, y, B.y], [C.x, y, C.y], colour);
  }
}

const ringsFor = (b: Building): Pt[][] => b.rings.map((r) => (r.length > 1 && r[0]![0] === r[r.length - 1]![0] && r[0]![1] === r[r.length - 1]![1] ? r.slice(0, -1) : r));

/** Walls and roofs for a set of buildings, tinted by the city's colour with a little variety from building to building. */
export function buildingsGeometry(three: Three, buildings: Building[], tint: string): T.BufferGeometry | null {
  const buf = new Buf();
  const base = new three.Color(tint);
  const palette = ['#d9d4c7', '#c9c3b5', '#b9b2a4', '#e3ded2', '#a9a498', '#cfc6b8'];
  for (const b of buildings) {
    const rings = ringsFor(b);
    if (rings[0]!.length < 3) continue;
    const seed = Math.abs(Math.sin(rings[0]![0]![0] * 12.9898 + rings[0]![0]![1] * 78.233) * 43758.5453) % 1;
    const wall = new three.Color(palette[Math.floor(seed * palette.length)]!).lerp(base, 0.12 + seed * 0.1);
    const w: [number, number, number] = [wall.r, wall.g, wall.b];
    const roof: [number, number, number] = [wall.r * 0.72, wall.g * 0.72, wall.b * 0.72];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j]!;
        const c = ring[i]!;
        const shade = 0.82 + 0.18 * Math.abs(Math.sin(Math.atan2(c[1] - a[1], c[0] - a[0])));
        buf.quad([a[0], b.minH, a[1]], [c[0], b.minH, c[1]], [c[0], b.h, c[1]], [a[0], b.h, a[1]], [w[0] * shade, w[1] * shade, w[2] * shade]);
      }
    }
    fill(three, buf, rings, b.h, roof);
  }
  return buf.empty ? null : buf.geometry(three);
}

/** Metres per window bay, and per storey, for wrapping a window picture round a wall. */
export const BAY_M = 3.6;
export const STOREY_M = 3.2;

/**
 * The same buildings as buildingsGeometry, but in two pieces: walls with picture coordinates (so a window texture can wrap round them,
 * one bay across and one storey up per repeat) and plain roofs. The wall colours are tints that multiply with the picture.
 */
export function buildingParts(three: Three, buildings: Building[], tint: string): { walls: T.BufferGeometry | null; roofs: T.BufferGeometry | null } {
  const walls = new Buf();
  const roofs = new Buf();
  const uv: number[] = [];
  const base = new three.Color(tint);
  const palette = ['#e6e1d4', '#d6d0c0', '#c6bfae', '#efe9dc', '#b8b2a3', '#dcd2c2', '#cdb9a3', '#d9d9d6'];
  for (const b of buildings) {
    const rings = ringsFor(b);
    if (rings[0]!.length < 3) continue;
    const seed = Math.abs(Math.sin(rings[0]![0]![0] * 12.9898 + rings[0]![0]![1] * 78.233) * 43758.5453) % 1;
    // The map's own colour when it has one (softened so a vivid tag does not glare), otherwise a varied neutral.
    const wall = b.colour ? new three.Color(b.colour).lerp(new three.Color('#cfc9bc'), 0.25) : new three.Color(palette[Math.floor(seed * palette.length)]!).lerp(base, 0.1 + seed * 0.1);
    const roof: [number, number, number] = [wall.r * 0.62, wall.g * 0.6, wall.b * 0.58];
    const floors = Math.max(1, Math.round((b.h - b.minH) / STOREY_M));
    const v0 = b.minH / STOREY_M;
    const v1 = v0 + floors;
    // A building of two storeys or more standing on the ground gets a darker, warmer ground floor, like shop fronts.
    const shopFront = b.minH === 0 && floors >= 2;
    const splitY = b.minH + STOREY_M;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j]!;
        const c = ring[i]!;
        const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
        if (len < 0.05) continue;
        const shade = 0.84 + 0.16 * Math.abs(Math.sin(Math.atan2(c[1] - a[1], c[0] - a[0])));
        const bays = Math.max(1, Math.round(len / BAY_M));
        const upper: [number, number, number] = [wall.r * shade, wall.g * shade, wall.b * shade];
        if (shopFront) {
          const lower: [number, number, number] = [wall.r * shade * 0.78, wall.g * shade * 0.72, wall.b * shade * 0.66];
          walls.quad([a[0], b.minH, a[1]], [c[0], b.minH, c[1]], [c[0], splitY, c[1]], [a[0], splitY, a[1]], lower);
          uv.push(0, v0, bays, v0, bays, v0 + 1, 0, v0, bays, v0 + 1, 0, v0 + 1);
          walls.quad([a[0], splitY, a[1]], [c[0], splitY, c[1]], [c[0], b.h, c[1]], [a[0], b.h, a[1]], upper);
          uv.push(0, v0 + 1, bays, v0 + 1, bays, v1, 0, v0 + 1, bays, v1, 0, v1);
        } else {
          walls.quad([a[0], b.minH, a[1]], [c[0], b.minH, c[1]], [c[0], b.h, c[1]], [a[0], b.h, a[1]], upper);
          uv.push(0, v0, bays, v0, bays, v1, 0, v0, bays, v1, 0, v1);
        }
      }
    }
    fill(three, roofs, rings, b.h, roof);
  }
  const wg = walls.empty ? null : walls.geometry(three);
  if (wg) wg.setAttribute('uv', new three.Float32BufferAttribute(uv, 2));
  return { walls: wg, roofs: roofs.empty ? null : roofs.geometry(three) };
}

/** Streets as flat strips laid on the ground. Each strip is a little above the one under it, so the bigger road shows at a crossing. */
export function roadsGeometry(three: Three, roads: Road[]): T.BufferGeometry | null {
  const buf = new Buf();
  const colours = new Map<string, [number, number, number]>();
  for (const r of roads) {
    let colour = colours.get(r.cls);
    if (!colour) {
      colour = rgb(three, ROAD_COLOUR[r.cls] ?? '#47474d');
      colours.set(r.cls, colour);
    }
    const y = 0.05 + Math.min(r.width, 14) * 0.002;
    for (let i = 1; i < r.pts.length; i++) strip(buf, r.pts[i - 1]!, r.pts[i]!, r.width / 2, y, colour);
  }
  return buf.empty ? null : buf.geometry(three);
}

function strip(buf: Buf, a: Pt, b: Pt, half: number, y: number, colour: [number, number, number]): void {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  if (len < 0.01) return;
  const nx = (-dz / len) * half;
  const nz = (dx / len) * half;
  buf.quad([a[0] + nx, y, a[1] + nz], [a[0] - nx, y, a[1] - nz], [b[0] - nx, y, b[1] - nz], [b[0] + nx, y, b[1] + nz], colour);
}

/** Water, parks, sand and squares as flat polygons. */
export function areasGeometry(three: Three, areas: Area[], y: number, colour: (a: Area) => string): T.BufferGeometry | null {
  const buf = new Buf();
  for (const a of areas) {
    const rings = a.rings.filter((r) => r.length >= 3).map((r) => (r[0]![0] === r[r.length - 1]![0] && r[0]![1] === r[r.length - 1]![1] ? r.slice(0, -1) : r));
    if (rings.length === 0) continue;
    fill(three, buf, rings, y, rgb(three, colour(a)));
  }
  return buf.empty ? null : buf.geometry(three);
}

/** Rivers and canals as strips of water. */
export function waterLinesGeometry(three: Three, lines: WaterLine[], y: number): T.BufferGeometry | null {
  const buf = new Buf();
  const colour = rgb(three, WATER_COLOUR);
  for (const l of lines) for (let i = 1; i < l.pts.length; i++) strip(buf, l.pts[i - 1]!, l.pts[i]!, l.width / 2, y, colour);
  return buf.empty ? null : buf.geometry(three);
}
