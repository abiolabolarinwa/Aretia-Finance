/**
 * Junctions, traffic lights and crosswalks. The map data says where roads meet but not where signals are, so signals go at busy
 * junctions: where at least two main roads cross (not on motorways). Each signalised junction has two groups of roads, the one along the
 * widest road and the one across it; they take turns to go, with an amber warning and a moment when everyone waits. Everything here is
 * plain maths (no screen), shared by the ground painter, the signal posts and the traffic.
 */
import type { Pt } from './mvt.js';
import type { Road, TileWorld } from './worldData.js';

/** One road leaving a junction: its direction away from the junction (unit), width, class and how far it runs before the next vertex. */
export interface Arm {
  dx: number;
  dz: number;
  width: number;
  cls: string;
  len: number;
}

export interface Junction {
  /** A name that is the same wherever the junction is found, so it is counted once. */
  id: string;
  x: number;
  z: number;
  arms: Arm[];
  /** The direction (unit) of the widest road: group 0 runs along it, group 1 across it. */
  axis: [number, number];
  signalised: boolean;
  /** Seconds added to the clock for this junction, so they are not all on the same beat. */
  offset: number;
}

const DRIVABLE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor']);
/** A road this wide or more counts as a main road. */
export const MAIN_ROAD_M = 8;

const hash = (x: number, z: number): number => {
  const v = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

/** Finds the junctions among some roads: places where three or more drivable roads meet. */
export function junctionsOf(roads: Road[]): Junction[] {
  const nodes = new Map<string, { x: number; z: number; arms: Arm[] }>();
  const add = (p: Pt, q: Pt, r: Road): void => {
    const dx = q[0] - p[0];
    const dz = q[1] - p[1];
    const len = Math.hypot(dx, dz);
    if (len < 1) return;
    const key = `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`; // to the nearest half metre
    let n = nodes.get(key);
    if (!n) {
      n = { x: p[0], z: p[1], arms: [] };
      nodes.set(key, n);
    }
    n.arms.push({ dx: dx / len, dz: dz / len, width: r.width, cls: r.cls, len });
  };
  for (const r of roads) {
    if (!DRIVABLE.has(r.cls)) continue;
    for (let i = 1; i < r.pts.length; i++) {
      add(r.pts[i - 1]!, r.pts[i]!, r);
      add(r.pts[i]!, r.pts[i - 1]!, r);
    }
  }
  // Busiest first, and skip any that sit within a few metres of one already taken (one real junction drawn as two or three nodes).
  const candidates = [...nodes.values()].filter((n) => n.arms.length >= 3).sort((a, b) => b.arms.length - a.arms.length);
  const out: Junction[] = [];
  for (const n of candidates) {
    if (out.some((j) => Math.hypot(j.x - n.x, j.z - n.z) < 7)) continue;
    let widest = n.arms[0]!;
    for (const a of n.arms) if (a.width > widest.width) widest = a;
    const mains = n.arms.filter((a) => a.width >= MAIN_ROAD_M).length;
    const motorway = n.arms.some((a) => a.cls === 'motorway' || a.cls === 'trunk');
    out.push({
      id: `${Math.round(n.x)},${Math.round(n.z)}`,
      x: n.x,
      z: n.z,
      arms: n.arms,
      axis: [widest.dx, widest.dz],
      signalised: mains >= 2 && !motorway,
      offset: hash(n.x, n.z) * CYCLE_S,
    });
  }
  return out;
}

const memo = new WeakMap<TileWorld, Junction[]>();
/** The junctions of a tile, worked out once. */
export function junctionsFor(world: TileWorld): Junction[] {
  let j = memo.get(world);
  if (!j) {
    j = junctionsOf(world.roads);
    memo.set(world, j);
  }
  return j;
}

// ---------------------------------------------------------------- the lights

export type Light = 'green' | 'amber' | 'red';
export const GREEN_S = 12;
export const AMBER_S = 2.5;
export const ALL_RED_S = 1.5;
/** One full round: group 0 goes, then group 1 goes. */
export const CYCLE_S = 2 * (GREEN_S + AMBER_S + ALL_RED_S);

/** Which group a road belongs to: 0 if it runs along the junction's main axis (either way), 1 if it runs across it. */
export const armGroup = (j: Pick<Junction, 'axis'>, dx: number, dz: number): 0 | 1 => (Math.abs(dx * j.axis[0] + dz * j.axis[1]) > 0.7071 ? 0 : 1);

/** The light a group sees at a time (seconds). Group 1 runs half a round behind group 0, so they are never green together. */
export function lightFor(group: 0 | 1, seconds: number, offset = 0): Light {
  const round = (((seconds + offset) % CYCLE_S) + CYCLE_S) % CYCLE_S;
  const c = group === 0 ? round : (round + CYCLE_S / 2) % CYCLE_S;
  if (c < GREEN_S) return 'green';
  if (c < GREEN_S + AMBER_S) return 'amber';
  return 'red';
}

// ---------------------------------------------------------------- crosswalks and stop lines

/** The widest road at a junction: the crosswalks and stop lines sit clear of it. */
export const junctionHalfWidth = (j: Pick<Junction, 'arms'>): number => Math.max(...j.arms.map((a) => a.width)) / 2;
/** How far from the junction's middle the crosswalk lies (its centre), along each road. */
export const crosswalkDistance = (j: Pick<Junction, 'arms'>): number => junctionHalfWidth(j) + 3;
/** How far from the middle the stop line is: just before the crosswalk, on the approaching side. */
export const stopDistance = (j: Pick<Junction, 'arms'>): number => crosswalkDistance(j) + 3.2;
/** A road needs this much length for a crosswalk to fit on it. */
export const roomForCrosswalk = (j: Pick<Junction, 'arms'>, arm: Arm): boolean => arm.len >= crosswalkDistance(j) + 4;

// ---------------------------------------------------------------- driving up to a light

export const COMFORT_BRAKE = 3.5;

/** The speed to aim for with `gap` metres left to the stop line, so a car slows evenly and arrives stopped. */
export function speedToStopIn(gap: number): number {
  return gap <= 0.4 ? 0 : Math.sqrt(2 * COMFORT_BRAKE * gap);
}

/**
 * What speed a car should aim for approaching a junction: its cruising speed on green or once it is past the line, a smooth stop for red,
 * and for amber a stop only if it can still do so comfortably (otherwise it carries on through, as people do).
 */
export function targetAtLight(light: Light, gap: number, speed: number, cruise: number): number {
  if (light === 'green' || gap < -3) return cruise; // green, or well into the junction: carry on through
  if (gap < 0) return speed > 2.5 ? cruise : 0; // just over the line: committed if still moving fast, otherwise it stays put
  const canStop = gap > (speed * speed) / (2 * 5.5);
  if (light === 'amber' && !canStop) return cruise;
  return Math.min(cruise, speedToStopIn(gap));
}
