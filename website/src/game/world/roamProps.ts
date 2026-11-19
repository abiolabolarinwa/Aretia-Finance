/**
 * Where street furniture goes: benches, bins, fire hydrants, mailboxes, signs and market stands on the pavement beside streets, and
 * dumpsters beside back lanes. Placed by a steady rule from the map (the same place always gets the same things), never on the road,
 * never inside a building or water, and kept clear of junctions where the crosswalks and traffic lights are. Pure, so it is tested without
 * a screen; the drawing is in propModels.ts.
 */
import type { Pt } from './mvt.js';
import type { TileWorld } from './worldData.js';
import { CELL_M } from './roamBuild.js';
import { hash2, hasPavement, squareOf } from './roamDetail.js';
import { crosswalkDistance, junctionsFor } from './junctions.js';

export type PropKind = 'bench' | 'bin-small' | 'bin-large' | 'hydrant' | 'mailbox' | 'dumpster' | 'market-stand' | 'sign';

export interface PropSpec {
  /** The file in public/game/models/props/ (without .glb). */
  file: string;
  /** How tall it should stand in metres (the model is scaled to it). */
  height: number;
}

export const PROP_SPECS: Record<PropKind, PropSpec> = {
  bench: { file: 'bench', height: 0.9 },
  'bin-small': { file: 'bin-small', height: 0.95 },
  'bin-large': { file: 'bin-large', height: 1.15 },
  hydrant: { file: 'hydrant', height: 0.8 },
  mailbox: { file: 'mailbox', height: 1.2 },
  dumpster: { file: 'dumpster', height: 1.5 },
  'market-stand': { file: 'market-stand', height: 2.5 },
  sign: { file: 'sign', height: 2.4 },
};

export interface PropPlacement {
  kind: PropKind;
  x: number;
  z: number;
  /** Turn about the vertical (radians) so the front of the model faces the street. */
  yaw: number;
}

/** How far from the middle of the street each kind stands, beyond half its width. Pavement runs about 2.5 m out from the kerb. */
const OFFSET: Record<PropKind, number> = { bench: 2.0, 'bin-small': 1.9, 'bin-large': 1.9, hydrant: 1.6, mailbox: 1.8, dumpster: 1.6, 'market-stand': 3.4, sign: 1.4 };

const STEP_M = 14;
const inSquare = (x: number, z: number, key: string): boolean => {
  const s = squareOf(key);
  return x >= s.x0 && x < s.x0 + CELL_M && z >= s.z0 && z < s.z0 + CELL_M;
};

/** Which kind (if any) a spot on a street gets, from a steady number for that spot. */
export function kindFor(r: number, h2: number, width: number, cls: string): PropKind | null {
  if (r < 0.05) return 'bench';
  if (r < 0.12) return h2 < 0.5 ? 'bin-small' : 'bin-large';
  if (r < 0.15) return 'hydrant';
  if (r < 0.17) return 'mailbox';
  if (r < 0.2) return width >= 6 && (cls === 'minor' || cls === 'tertiary') ? 'market-stand' : null;
  if (r < 0.225) return 'sign';
  return null;
}

export function propsFor(key: string, world: TileWorld, blocked: (x: number, z: number) => boolean, cap = 70): PropPlacement[] {
  const s = squareOf(key);
  const out: PropPlacement[] = [];
  const clear = junctionsFor(world).map((j) => ({ x: j.x, z: j.z, r: crosswalkDistance(j) + 8 }));
  const nearJunction = (x: number, z: number): boolean => clear.some((c) => Math.hypot(c.x - x, c.z - z) < c.r);
  const place = (kind: PropKind, p: Pt, tx: number, tz: number, width: number, side: number): void => {
    if (out.length >= cap) return;
    const nx = -tz;
    const nz = tx;
    const off = width / 2 + OFFSET[kind];
    const x = p[0] + nx * side * off;
    const z = p[1] + nz * side * off;
    if (!inSquare(x, z, key) || blocked(x, z) || nearJunction(p[0], p[1])) return;
    // The front of the model faces the street: from the prop back towards the road's middle.
    out.push({ kind, x, z, yaw: Math.atan2(-nx * side, -nz * side) });
  };
  for (const r of world.roads) {
    const back = r.cls === 'service';
    if (!back && (!hasPavement(r.cls) || r.width < 5)) continue;
    // Skip roads that do not come near this square.
    let near = false;
    for (const p of r.pts) if (p[0] > s.x0 - 15 && p[0] < s.x0 + CELL_M + 15 && p[1] > s.z0 - 15 && p[1] < s.z0 + CELL_M + 15) near = true;
    if (!near) continue;
    let carry = 0;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1]!;
      const b = r.pts[i]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.01) continue;
      const tx = (b[0] - a[0]) / len;
      const tz = (b[1] - a[1]) / len;
      for (let d = carry; d < len; d += STEP_M) {
        const p: Pt = [a[0] + tx * d, a[1] + tz * d];
        const h = hash2(p[0], p[1], 21);
        const side = hash2(p[0], p[1], 22) < 0.5 ? -1 : 1;
        if (back) {
          if (h < 0.18) place('dumpster', p, tx, tz, r.width, side);
        } else {
          const kind = kindFor(h, hash2(p[0], p[1], 23), r.width, r.cls);
          if (kind) place(kind, p, tx, tz, r.width, side);
        }
      }
      carry = carry + Math.ceil((len - carry) / STEP_M) * STEP_M - len;
    }
  }
  return out;
}
