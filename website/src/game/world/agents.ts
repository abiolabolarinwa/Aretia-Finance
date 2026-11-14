/**
 * People and cars that go about the city on their own: each follows a street, turns at junctions onto a connecting street, and keeps to
 * its side (cars to the right of the road's middle, people on the pavement). No screen needed, so this can be tested.
 */
import type { Pt } from './mvt.js';

export interface Seg {
  a: Pt;
  b: Pt;
  width: number;
  cls: string;
}

export interface Agent {
  x: number;
  z: number;
  /** 0 is north, turning towards east (the direction is (sin h, -cos h)). */
  heading: number;
  speed: number;
  /** Sideways distance from the street's middle, positive to the right of the way they face. */
  lane: number;
  seg: Seg;
  /** Metres along the segment, in the direction a to b. */
  s: number;
}

const near = (p: Pt, q: Pt, d: number): boolean => Math.hypot(p[0] - q[0], p[1] - q[1]) <= d;
const length = (s: Seg): number => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
const flip = (s: Seg): Seg => ({ ...s, a: s.b, b: s.a });

/** Chooses the street to turn onto at a junction from those that meet there, not going straight back unless it is a dead end. */
export function pickNext(candidates: Seg[], end: Pt, from: Seg, random: () => number): Seg | null {
  const here = candidates.filter((c) => c !== from && !(near(c.a, from.a, 0.01) && near(c.b, from.b, 0.01)) && (near(c.a, end, 2) || near(c.b, end, 2)));
  const onward = here.filter((c) => !near(near(c.a, end, 2) ? c.b : c.a, from.a, 2));
  const pool = onward.length ? onward : here;
  if (!pool.length) return null;
  const c = pool[Math.floor(random() * pool.length) % pool.length]!;
  return near(c.a, end, 2) ? c : flip(c);
}

export function startAgent(seg: Seg, along: number, speed: number, lane: number): Agent {
  const a: Agent = { x: 0, z: 0, heading: 0, speed, lane, seg, s: along };
  place(a);
  a.heading = headingOf(seg);
  return a;
}

function headingOf(s: Seg): number {
  return Math.atan2(s.b[0] - s.a[0], -(s.b[1] - s.a[1]));
}

function place(a: Agent): void {
  const len = length(a.seg) || 1;
  const dx = (a.seg.b[0] - a.seg.a[0]) / len;
  const dz = (a.seg.b[1] - a.seg.a[1]) / len;
  a.x = a.seg.a[0] + dx * a.s - dz * a.lane;
  a.z = a.seg.a[1] + dz * a.s + dx * a.lane;
}

/** Moves an agent along its street for dt seconds, turning at the end onto whatever `next` chooses (or about face at a dead end). */
export function stepAgent(a: Agent, dt: number, next: (end: Pt, from: Seg) => Seg | null): void {
  a.s += a.speed * dt;
  for (let guard = 0; guard < 4; guard++) {
    const len = length(a.seg);
    if (a.s < len) break;
    const n = next(a.seg.b, a.seg) ?? flip(a.seg);
    a.s -= len;
    a.seg = n;
    if (length(n) < 0.01) {
      a.s = 0;
      break;
    }
  }
  place(a);
  // Turn smoothly rather than snapping at a corner.
  const want = headingOf(a.seg);
  let diff = want - a.heading;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  a.heading += diff * Math.min(1, dt * 5);
}
