/**
 * Turns Mapillary's real feature positions into what the game draws. Wherever real data exists for a map square it replaces the game's
 * own rule for that kind of thing; wherever it does not, the rules stay, so a city with thin data looks as it did before. All plain
 * maths, tested without a screen.
 */
import type { MapFeature } from './mapillaryFeatures.js';
import type { PropKind, PropPlacement } from './roamProps.js';
import type { Plant } from './roamDetail.js';
import type { TileWorld } from './worldData.js';
import type { Junction } from './junctions.js';
import { nearestOnSegment } from './colliders.js';
import { hash2 } from './roamDetail.js';

const DRIVABLE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor']);

export const ofKind = (features: MapFeature[], kind: MapFeature['kind']): MapFeature[] => features.filter((f) => f.kind === kind);

/** The nearest street to a point (within `within` metres): where it is, which way it runs (unit), and how wide it is. */
export function nearestStreet(world: TileWorld, x: number, z: number, within = 30): { px: number; pz: number; tx: number; tz: number; width: number; d: number } | null {
  let best: { px: number; pz: number; tx: number; tz: number; width: number; d: number } | null = null;
  for (const r of world.roads) {
    if (!DRIVABLE.has(r.cls)) continue;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1]!;
      const b = r.pts[i]!;
      const n = nearestOnSegment(x, z, a[0], a[1], b[0], b[1]);
      if (n.d <= within && (!best || n.d < best.d)) {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        best = { px: n.px, pz: n.pz, tx: (b[0] - a[0]) / len, tz: (b[1] - a[1]) / len, width: r.width, d: n.d };
      }
    }
  }
  return best;
}

/** Street lights: the real ones when there are at least two in the square, otherwise null so the game's own rule is used. */
export function lampsFromFeatures(features: MapFeature[], blocked: (x: number, z: number) => boolean): Plant[] | null {
  const real = ofKind(features, 'street-light');
  if (real.length < 2) return null;
  return real.filter((f) => !blocked(f.x, f.z)).map((f) => ({ x: f.x, z: f.z, s: 1, v: 0 }));
}

/** Utility poles (the wooden or concrete poles that carry power lines): real positions only, there is no rule for them. */
export function polesFromFeatures(features: MapFeature[], blocked: (x: number, z: number) => boolean, cap = 90): { x: number; z: number; yaw: number }[] {
  return ofKind(features, 'utility-pole')
    .filter((f) => !blocked(f.x, f.z))
    .slice(0, cap)
    .map((f) => ({ x: f.x, z: f.z, yaw: Math.floor(hash2(f.x, f.z, 31) * 4) * (Math.PI / 2) }));
}

const REAL_KINDS: Record<string, PropKind | null> = { bench: 'bench', hydrant: 'hydrant', sign: 'sign', bin: null };

/**
 * Street furniture for a square: the game's rule-based benches, bins, hydrants and signs are replaced by the real ones for each kind that
 * has real data in this square; kinds with none keep the rule-based ones. Other kinds (mailboxes, market stands, dumpsters) are unchanged.
 */
export function mergeProps(rule: PropPlacement[], features: MapFeature[], world: TileWorld, blocked: (x: number, z: number) => boolean): PropPlacement[] {
  const replaced = new Set<PropKind>();
  const real: PropPlacement[] = [];
  for (const f of features) {
    if (!(f.kind in REAL_KINDS) || blocked(f.x, f.z)) continue;
    const kind: PropKind = f.kind === 'bin' ? (hash2(f.x, f.z, 41) < 0.5 ? 'bin-small' : 'bin-large') : REAL_KINDS[f.kind]!;
    if (f.kind === 'bin') {
      replaced.add('bin-small');
      replaced.add('bin-large');
    } else replaced.add(kind);
    // Turn it to face the street if there is one close by.
    const st = nearestStreet(world, f.x, f.z, 25);
    const yaw = st ? Math.atan2(st.px - f.x, st.pz - f.z) : hash2(f.x, f.z, 42) * Math.PI * 2;
    real.push({ kind, x: f.x, z: f.z, yaw });
  }
  return [...rule.filter((p) => !replaced.has(p.kind)), ...real];
}

/** Real crosswalk markings, as places on a street where a zebra crossing should be painted, and which way the street runs there. */
export function crosswalksFromFeatures(features: MapFeature[], world: TileWorld): { x: number; z: number; tx: number; tz: number; width: number }[] {
  const out: { x: number; z: number; tx: number; tz: number; width: number }[] = [];
  for (const f of ofKind(features, 'crosswalk')) {
    const st = nearestStreet(world, f.x, f.z, 14);
    if (!st || st.width < 5) continue;
    if (out.some((o) => Math.hypot(o.x - st.px, o.z - st.pz) < 5)) continue; // one painted crossing, however many photos saw it
    out.push({ x: st.px, z: st.pz, tx: st.tx, tz: st.tz, width: st.width });
  }
  return out;
}

/** How near a real traffic light must be to a junction for the junction to have signals. */
export const SIGNAL_REACH_M = 30;

/**
 * Gives signals to every junction that has a real traffic light close to it. Returns the junctions that did not have them before, so
 * the caller can add them to its list. (Junctions the rule already signalised are left as they are: real data only adds.)
 */
export function signalsFromFeatures(junctions: Junction[], features: MapFeature[]): Junction[] {
  const lights = ofKind(features, 'traffic-light');
  if (!lights.length) return [];
  const added: Junction[] = [];
  for (const j of junctions) {
    if (j.signalised || j.arms.length < 3) continue;
    if (lights.some((l) => Math.hypot(l.x - j.x, l.z - j.z) <= SIGNAL_REACH_M)) {
      j.signalised = true;
      added.push(j);
    }
  }
  return added;
}
