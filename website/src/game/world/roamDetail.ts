/**
 * The fine detail of the roaming city, drawn from the real map: the ground of each 200 m square painted like a street map seen from
 * above (kerbs and pavements, asphalt, lane lines, parks, sand, water), and where trees and street lamps stand. Pure code, so it can be
 * tested without a screen: the painter takes any 2D drawing context.
 */
import type { Pt } from './mvt.js';
import type { Area, Road, TileWorld } from './worldData.js';
import { insidePolygon } from './colliders.js';
import { CELL_M } from './roamBuild.js';
import { REAL, type Palette } from './style.js';
import { crosswalkDistance, junctionsFor, roomForCrosswalk, stopDistance } from './junctions.js';

export interface Square {
  /** The north-west corner of the square, in metres. */
  x0: number;
  z0: number;
}

export const squareOf = (key: string): Square => {
  const [cx, cz] = key.split(',').map(Number) as [number, number];
  return { x0: cx * CELL_M, z0: cz * CELL_M };
};

const overlaps = (pts: Pt[], s: Square, margin: number): boolean => {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  return maxX >= s.x0 - margin && minX <= s.x0 + CELL_M + margin && maxZ >= s.z0 - margin && minZ <= s.z0 + CELL_M + margin;
};

/** The class of a street that gets pavements either side. */
export const hasPavement = (cls: string): boolean => cls !== 'path' && cls !== 'track' && cls !== 'pier' && cls !== 'service' && cls !== 'motorway' && cls !== 'trunk';

/**
 * Paints one square of the ground. `size` is the picture's side in pixels (it covers CELL_M metres). The background is left clear,
 * so the plain ground colour shows through wherever the map has nothing to say.
 */
export function paintGround(ctx: CanvasRenderingContext2D, size: number, key: string, world: TileWorld, palette: Palette = REAL, extras: { crosswalks?: { x: number; z: number; tx: number; tz: number; width: number }[] } = {}): void {
  const AREA_PAINT = palette.area;
  const WATER_PAINT = palette.water;
  const R = palette.road;
  const s = squareOf(key);
  const k = size / CELL_M;
  const px = (x: number): number => (x - s.x0) * k;
  const pz = (z: number): number => (z - s.z0) * k;
  ctx.clearRect(0, 0, size, size);
  ctx.lineJoin = 'round';

  const fillArea = (a: Area, colour: string): void => {
    if (!a.rings.some((r) => overlaps(r, s, 2))) return;
    ctx.fillStyle = colour;
    ctx.beginPath();
    for (const ring of a.rings) {
      ring.forEach((p, i) => (i === 0 ? ctx.moveTo(px(p[0]), pz(p[1])) : ctx.lineTo(px(p[0]), pz(p[1]))));
      ctx.closePath();
    }
    ctx.fill('evenodd');
  };
  for (const a of world.areas) fillArea(a, AREA_PAINT[a.kind] ?? AREA_PAINT.grass);
  for (const a of world.water) fillArea(a, WATER_PAINT);
  ctx.lineCap = 'round';
  for (const l of world.waterLines) {
    if (!overlaps(l.pts, s, l.width)) continue;
    ctx.strokeStyle = WATER_PAINT;
    ctx.lineWidth = l.width * k;
    ctx.beginPath();
    l.pts.forEach((p, i) => (i === 0 ? ctx.moveTo(px(p[0]), pz(p[1])) : ctx.lineTo(px(p[0]), pz(p[1]))));
    ctx.stroke();
  }

  const roads = world.roads.filter((r) => overlaps(r.pts, s, r.width + 6));
  const trace = (r: Road): void => {
    ctx.beginPath();
    r.pts.forEach((p, i) => (i === 0 ? ctx.moveTo(px(p[0]), pz(p[1])) : ctx.lineTo(px(p[0]), pz(p[1]))));
  };
  // Smallest streets first, so a bigger street runs over a smaller one at a junction.
  const order = (r: Road): number => r.width;
  roads.sort((a, b) => order(a) - order(b));
  ctx.lineCap = 'butt';
  // 1. pavements, 2. kerb, 3. asphalt, 4. markings
  for (const r of roads) {
    if (!hasPavement(r.cls)) continue;
    ctx.strokeStyle = R.pavement;
    ctx.lineWidth = (r.width + 5) * k;
    trace(r);
    ctx.stroke();
  }
  for (const r of roads) {
    if (r.cls === 'path' || r.cls === 'track' || r.cls === 'pier') {
      ctx.strokeStyle = r.cls === 'pier' ? R.pier : R.path;
      ctx.lineWidth = Math.max(r.width, 1.4) * k;
      ctx.lineCap = 'round';
      trace(r);
      ctx.stroke();
      ctx.lineCap = 'butt';
      continue;
    }
    ctx.strokeStyle = R.kerb;
    ctx.lineWidth = (r.width + 0.6) * k;
    trace(r);
    ctx.stroke();
    ctx.strokeStyle = R.asphalt[r.cls] ?? R.fallback;
    ctx.lineWidth = r.width * k;
    trace(r);
    ctx.stroke();
  }
  for (const r of roads) {
    if (r.width < 6 || r.cls === 'path' || r.cls === 'track' || r.cls === 'pier') continue;
    // Edge lines on the bigger streets, and a dashed line down the middle.
    if (r.width >= 8) {
      ctx.strokeStyle = R.edge;
      ctx.lineWidth = Math.max(0.12 * k, 0.6);
      ctx.setLineDash([]);
      for (const side of [-1, 1]) {
        ctx.beginPath();
        offsetPolyline(r.pts, (r.width / 2 - 0.45) * side).forEach((p, i) => (i === 0 ? ctx.moveTo(px(p[0]), pz(p[1])) : ctx.lineTo(px(p[0]), pz(p[1]))));
        ctx.stroke();
      }
    }
    ctx.strokeStyle = r.cls === 'motorway' || r.cls === 'trunk' ? R.centreHighway : R.centre;
    ctx.lineWidth = Math.max(0.16 * k, 0.8);
    ctx.setLineDash([3 * k, 6 * k]);
    trace(r);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Crosswalks (zebra stripes running along the road, side by side across it) and a stop line, on each road of a signalised junction.
  ctx.lineCap = 'butt';
  ctx.setLineDash([]);
  for (const j of junctionsFor(world)) {
    if (!j.signalised || j.x < s.x0 - 12 || j.x > s.x0 + CELL_M + 12 || j.z < s.z0 - 12 || j.z > s.z0 + CELL_M + 12) continue;
    for (const arm of j.arms) {
      if (arm.width < 5 || !roomForCrosswalk(j, arm)) continue;
      const cd = crosswalkDistance(j);
      const cx = j.x + arm.dx * cd;
      const cz = j.z + arm.dz * cd;
      const px2 = -arm.dz; // across the road
      const pz2 = arm.dx;
      const half = arm.width / 2 - 0.4;
      ctx.strokeStyle = R.centre;
      ctx.lineWidth = 0.55 * k;
      ctx.beginPath();
      for (let off = -half; off <= half + 0.01; off += 1.1) {
        ctx.moveTo(px(cx + px2 * off - arm.dx * 1.5), pz(cz + pz2 * off - arm.dz * 1.5));
        ctx.lineTo(px(cx + px2 * off + arm.dx * 1.5), pz(cz + pz2 * off + arm.dz * 1.5));
      }
      ctx.stroke();
      // The stop line, on the side of the road traffic arrives on (their right as they drive towards the junction).
      const sd = stopDistance(j);
      const sx = j.x + arm.dx * sd;
      const sz = j.z + arm.dz * sd;
      const rx = arm.dz;
      const rz = -arm.dx;
      ctx.lineWidth = 0.45 * k;
      ctx.beginPath();
      ctx.moveTo(px(sx + rx * 0.2), pz(sz + rz * 0.2));
      ctx.lineTo(px(sx + rx * (arm.width / 2 - 0.3)), pz(sz + rz * (arm.width / 2 - 0.3)));
      ctx.stroke();
    }
  }

  // Real crosswalks found in street photos (zebra stripes along the street, side by side across it), except where a junction's own
  // crossings are already painted close by.
  const painted = junctionsFor(world).filter((j) => j.signalised);
  for (const cw of extras.crosswalks ?? []) {
    if (cw.x < s.x0 - 8 || cw.x > s.x0 + CELL_M + 8 || cw.z < s.z0 - 8 || cw.z > s.z0 + CELL_M + 8) continue;
    if (painted.some((j) => Math.hypot(j.x - cw.x, j.z - cw.z) < crosswalkDistance(j) + 10)) continue;
    const across: Pt = [-cw.tz, cw.tx];
    const half = cw.width / 2 - 0.4;
    ctx.strokeStyle = R.centre;
    ctx.lineWidth = 0.55 * k;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    for (let off = -half; off <= half + 0.01; off += 1.1) {
      ctx.moveTo(px(cw.x + across[0] * off - cw.tx * 1.5), pz(cw.z + across[1] * off - cw.tz * 1.5));
      ctx.lineTo(px(cw.x + across[0] * off + cw.tx * 1.5), pz(cw.z + across[1] * off + cw.tz * 1.5));
    }
    ctx.stroke();
  }
}

/** A line moved sideways by a distance (left of its direction when positive), for lane edges. */
export function offsetPolyline(pts: Pt[], d: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    out.push([pts[i]![0] + (-dz / len) * d, pts[i]![1] + (dx / len) * d]);
  }
  return out;
}

/** A steady pseudo-random number in [0, 1) from two coordinates, so the same place always grows the same trees. */
export const hash2 = (x: number, z: number, salt = 0): number => {
  const v = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453;
  return v - Math.floor(v);
};

export interface Plant {
  x: number;
  z: number;
  /** Size, 0.7 to 1.4. */
  s: number;
  /** Shade, 0 to 1. */
  v: number;
}

const inSquare = (x: number, z: number, s: Square): boolean => x >= s.x0 && x < s.x0 + CELL_M && z >= s.z0 && z < s.z0 + CELL_M;

/** Where trees stand in one square: thick in woods, scattered in parks, and in a line along streets that have pavements. */
export function treesFor(key: string, world: TileWorld, blocked: (x: number, z: number) => boolean, cap = 260): Plant[] {
  const s = squareOf(key);
  const out: Plant[] = [];
  const add = (x: number, z: number, salt: number): void => {
    if (out.length >= cap || !inSquare(x, z, s) || blocked(x, z)) return;
    out.push({ x, z, s: 0.7 + hash2(x, z, salt) * 0.7, v: hash2(z, x, salt + 3) });
  };
  for (const a of world.areas) {
    if (a.kind !== 'wood' && a.kind !== 'grass') continue;
    if (!a.rings.some((r) => overlaps(r, s, 0))) continue;
    const step = a.kind === 'wood' ? 7 : 19;
    for (let x = s.x0; x < s.x0 + CELL_M; x += step) {
      for (let z = s.z0; z < s.z0 + CELL_M; z += step) {
        const jx = x + (hash2(x, z, 1) - 0.5) * step * 0.9;
        const jz = z + (hash2(x, z, 2) - 0.5) * step * 0.9;
        if (hash2(jx, jz, 5) < (a.kind === 'wood' ? 0.8 : 0.45) && insidePolygon(jx, jz, a.rings)) add(jx, jz, 7);
      }
    }
  }
  for (const r of world.roads) {
    if (!hasPavement(r.cls) || r.width < 5 || !overlaps(r.pts, s, 12)) continue;
    let carry = 0;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1]!;
      const b = r.pts[i]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.01) continue;
      const nx = -(b[1] - a[1]) / len;
      const nz = (b[0] - a[0]) / len;
      for (let d = carry; d < len; d += 24) {
        const x = a[0] + ((b[0] - a[0]) * d) / len;
        const z = a[1] + ((b[1] - a[1]) * d) / len;
        const off = r.width / 2 + 3.2;
        for (const side of [-1, 1]) if (hash2(x + side, z, 9) < 0.55) add(x + nx * off * side, z + nz * off * side, 11);
      }
      carry = (carry + Math.ceil((len - carry) / 24) * 24) - len;
    }
  }
  return out;
}

/** Street lamps along the bigger streets, on alternate sides. */
export function lampsFor(key: string, world: TileWorld, blocked: (x: number, z: number) => boolean, cap = 60): Plant[] {
  const s = squareOf(key);
  const out: Plant[] = [];
  for (const r of world.roads) {
    if (r.width < 6 || !hasPavement(r.cls) || !overlaps(r.pts, s, 12)) continue;
    let n = 0;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1]!;
      const b = r.pts[i]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.01) continue;
      const nx = -(b[1] - a[1]) / len;
      const nz = (b[0] - a[0]) / len;
      for (let d = 10; d < len; d += 38) {
        const side = n++ % 2 ? 1 : -1;
        const x = a[0] + ((b[0] - a[0]) * d) / len + nx * (r.width / 2 + 1.6) * side;
        const z = a[1] + ((b[1] - a[1]) * d) / len + nz * (r.width / 2 + 1.6) * side;
        if (out.length < cap && inSquare(x, z, s) && !blocked(x, z)) out.push({ x, z, s: 1, v: 0 });
      }
    }
  }
  return out;
}
