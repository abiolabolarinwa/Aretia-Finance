/**
 * What a player, a car or a boat cannot pass through in the 3D world: the walls of every building (including courtyards) and the edges
 * of water. Held per map tile so a tile's walls go away when its streets are unloaded. Everything is in metres around the city's
 * starting point (x east, z south). Pure geometry, no drawing.
 */
import type { Pt } from './mvt.js';

const CELL = 40;

interface Box {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

function boxOf(pts: Pt[]): Box {
  const b = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const [x, z] of pts) {
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (z < b.minZ) b.minZ = z;
    if (z > b.maxZ) b.maxZ = z;
  }
  return b;
}

/** True when the point is inside the outline and outside every hole. */
export function insidePolygon(x: number, z: number, rings: Pt[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i]!;
      const [xj, zj] = ring[j]!;
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** The nearest point on the segment a to b, and how far it is from (x, z). */
export function nearestOnSegment(x: number, z: number, ax: number, az: number, bx: number, bz: number): { px: number; pz: number; d: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
  const px = ax + dx * t;
  const pz = az + dz * t;
  return { px, pz, d: Math.hypot(x - px, z - pz) };
}

interface Solid {
  rings: Pt[][];
  box: Box;
}

export class TileColliders {
  readonly box: Box = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  private readonly solids: Solid[] = [];
  private readonly segs: number[] = [];
  private readonly grid = new Map<string, number[]>();
  private readonly solidGrid = new Map<string, number[]>();
  private readonly water: Solid[] = [];
  private readonly lines: { pts: Pt[]; half: number; box: Box }[] = [];

  private grow(b: Box): void {
    this.box.minX = Math.min(this.box.minX, b.minX);
    this.box.minZ = Math.min(this.box.minZ, b.minZ);
    this.box.maxX = Math.max(this.box.maxX, b.maxX);
    this.box.maxZ = Math.max(this.box.maxZ, b.maxZ);
  }

  private bucket(map: Map<string, number[]>, b: Box, index: number): void {
    for (let cx = Math.floor(b.minX / CELL); cx <= Math.floor(b.maxX / CELL); cx++) {
      for (let cz = Math.floor(b.minZ / CELL); cz <= Math.floor(b.maxZ / CELL); cz++) {
        const key = `${cx},${cz}`;
        const list = map.get(key);
        if (list) list.push(index);
        else map.set(key, [index]);
      }
    }
  }

  /** A building: its walls stop anything, and so does being inside it. */
  addBuilding(rings: Pt[][]): void {
    if (rings.length === 0 || rings[0]!.length < 3) return;
    const box = boxOf(rings[0]!);
    const solid = this.solids.length;
    this.solids.push({ rings, box });
    this.grow(box);
    this.bucket(this.solidGrid, box, solid);
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j]!;
        const b = ring[i]!;
        const index = this.segs.length / 5;
        this.segs.push(a[0], a[1], b[0], b[1], solid);
        this.bucket(this.grid, { minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minZ: Math.min(a[1], b[1]), maxZ: Math.max(a[1], b[1]) }, index);
      }
    }
  }

  addWater(rings: Pt[][]): void {
    if (rings.length === 0 || rings[0]!.length < 3) return;
    const box = boxOf(rings[0]!);
    this.water.push({ rings, box });
    this.grow(box);
  }

  addWaterLine(pts: Pt[], width: number): void {
    const box = boxOf(pts);
    const pad = width / 2;
    const padded = { minX: box.minX - pad, minZ: box.minZ - pad, maxX: box.maxX + pad, maxZ: box.maxZ + pad };
    this.lines.push({ pts, half: pad, box: padded });
    this.grow(padded);
  }

  covers(x: number, z: number, pad: number): boolean {
    return x >= this.box.minX - pad && x <= this.box.maxX + pad && z >= this.box.minZ - pad && z <= this.box.maxZ + pad;
  }

  /** Moves a circle out of any wall it overlaps. */
  resolve(x: number, z: number, r: number): { x: number; z: number; hit: boolean } {
    let hit = false;
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      const seen = new Set<number>();
      for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
        for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
          for (const i of this.grid.get(`${cx},${cz}`) ?? []) {
            if (seen.has(i)) continue;
            seen.add(i);
            const o = i * 5;
            const n = nearestOnSegment(x, z, this.segs[o]!, this.segs[o + 1]!, this.segs[o + 2]!, this.segs[o + 3]!);
            if (n.d < r && n.d > 1e-6) {
              const k = (r - n.d) / n.d;
              x += (x - n.px) * k;
              z += (z - n.pz) * k;
              moved = true;
              hit = true;
            }
          }
        }
      }
      // A centre that is inside a building (a spawn, or a very fast push) is moved out through the nearest wall.
      const inside = this.insideSolid(x, z);
      if (inside !== null) {
        let best = { px: x, pz: z, d: Infinity };
        for (const ring of this.solids[inside]!.rings) {
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const n = nearestOnSegment(x, z, ring[j]![0], ring[j]![1], ring[i]![0], ring[i]![1]);
            if (n.d < best.d) best = n;
          }
        }
        const dx = best.px - x;
        const dz = best.pz - z;
        const len = Math.hypot(dx, dz) || 1;
        x = best.px + (dx / len) * (r + 0.05);
        z = best.pz + (dz / len) * (r + 0.05);
        moved = true;
        hit = true;
      }
      if (!moved) break;
    }
    return { x, z, hit };
  }

  private insideSolid(x: number, z: number): number | null {
    for (const i of this.solidGrid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? []) {
      const s = this.solids[i]!;
      if (x >= s.box.minX && x <= s.box.maxX && z >= s.box.minZ && z <= s.box.maxZ && insidePolygon(x, z, s.rings)) return i;
    }
    return null;
  }

  insideBuilding(x: number, z: number): boolean {
    return this.insideSolid(x, z) !== null;
  }

  inWater(x: number, z: number): boolean {
    for (const w of this.water) if (x >= w.box.minX && x <= w.box.maxX && z >= w.box.minZ && z <= w.box.maxZ && insidePolygon(x, z, w.rings)) return true;
    for (const l of this.lines) {
      if (x < l.box.minX || x > l.box.maxX || z < l.box.minZ || z > l.box.maxZ) continue;
      for (let i = 1; i < l.pts.length; i++) if (nearestOnSegment(x, z, l.pts[i - 1]![0], l.pts[i - 1]![1], l.pts[i]![0], l.pts[i]![1]).d < l.half) return true;
    }
    return false;
  }
}

/** All the tiles' walls and water together. */
export class Colliders {
  private readonly tiles = new Map<string, TileColliders>();

  set(id: string, tile: TileColliders): void {
    this.tiles.set(id, tile);
  }

  remove(id: string): void {
    this.tiles.delete(id);
  }

  get size(): number {
    return this.tiles.size;
  }

  resolve(x: number, z: number, r: number): { x: number; z: number; hit: boolean } {
    let hit = false;
    for (const t of this.tiles.values()) {
      if (!t.covers(x, z, r + 1)) continue;
      const out = t.resolve(x, z, r);
      if (out.hit) {
        x = out.x;
        z = out.z;
        hit = true;
      }
    }
    return { x, z, hit };
  }

  inWater(x: number, z: number): boolean {
    for (const t of this.tiles.values()) if (t.covers(x, z, 0) && t.inWater(x, z)) return true;
    return false;
  }

  insideBuilding(x: number, z: number): boolean {
    for (const t of this.tiles.values()) if (t.covers(x, z, 0) && t.insideBuilding(x, z)) return true;
    return false;
  }
}
