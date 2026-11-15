/**
 * How the player moves in the 3D world: on foot (walking and running), in a car, and in a boat. Arcade rules, in metres and seconds.
 * Walls stop everything; cars and people cannot enter water; a boat cannot leave it. Pure, so it is tested without a screen.
 *
 * Heading 0 faces north; the direction of travel is (sin heading, -cos heading) because z points south.
 */
export interface Hazards {
  resolve(x: number, z: number, r: number): { x: number; z: number; hit: boolean };
  inWater(x: number, z: number): boolean;
}

export type Mode = 'walk' | 'run' | 'car' | 'boat';

export const WALK_SPEED = 2.4;
export const RUN_SPEED = 6.2;
export const FOOT_RADIUS = 0.45;

export interface Foot {
  x: number;
  z: number;
  vx: number;
  vz: number;
  heading: number;
}

export interface FootInput {
  /** Wanted direction on the ground, in world axes; its length (0 to 1) is how hard the stick is pushed. */
  dx: number;
  dz: number;
  run: boolean;
}

export function stepFoot(s: Foot, input: FootInput, dt: number, w: Hazards): { moved: boolean } {
  const len = Math.min(1, Math.hypot(input.dx, input.dz));
  const top = input.run ? RUN_SPEED : WALK_SPEED;
  const wantX = len > 0.01 ? (input.dx / Math.hypot(input.dx, input.dz)) * top * len : 0;
  const wantZ = len > 0.01 ? (input.dz / Math.hypot(input.dx, input.dz)) * top * len : 0;
  // A person takes a moment to get going and a moment to stop: a little slower to start than to stop, so it has weight without feeling sluggish.
  const speeding = wantX * wantX + wantZ * wantZ > s.vx * s.vx + s.vz * s.vz;
  const k = 1 - Math.exp(-(speeding ? 9 : 13) * dt);
  s.vx += (wantX - s.vx) * k;
  s.vz += (wantZ - s.vz) * k;
  const fromX = s.x;
  const fromZ = s.z;
  let nx = s.x + s.vx * dt;
  let nz = s.z + s.vz * dt;
  if (w.inWater(nx, nz)) {
    // Slide along the shore rather than stop dead.
    if (!w.inWater(nx, s.z)) nz = s.z;
    else if (!w.inWater(s.x, nz)) nx = s.x;
    else {
      nx = s.x;
      nz = s.z;
    }
    if (nx === s.x) s.vx = 0;
    if (nz === s.z) s.vz = 0;
  }
  const r = w.resolve(nx, nz, FOOT_RADIUS);
  s.x = r.x;
  s.z = r.z;
  // Turn to face the way they are going, over a fraction of a second, by the shorter way round, instead of snapping.
  if (Math.hypot(s.vx, s.vz) > 0.3) {
    const want = Math.atan2(s.vx, -s.vz);
    const diff = Math.atan2(Math.sin(want - s.heading), Math.cos(want - s.heading));
    s.heading += diff * (1 - Math.exp(-14 * dt));
  }
  return { moved: Math.hypot(s.x - fromX, s.z - fromZ) > 1e-4 };
}

export interface Vehicle {
  x: number;
  z: number;
  heading: number;
  speed: number;
}

export interface VehicleSpec {
  maxForward: number;
  maxReverse: number;
  accel: number;
  brake: number;
  drag: number;
  turn: number;
  radius: number;
  /** A car stays out of water; a boat stays in it. */
  water: 'avoid' | 'only';
}

export const CAR: VehicleSpec = { maxForward: 27, maxReverse: 8, accel: 11, brake: 24, drag: 0.35, turn: 1.9, radius: 1.3, water: 'avoid' };
export const BOAT: VehicleSpec = { maxForward: 16, maxReverse: 4, accel: 5.5, brake: 9, drag: 0.3, turn: 1.1, radius: 1.8, water: 'only' };

export interface DriveInput {
  /** Pedal: 1 is full throttle, -1 is full brake and then reverse. */
  throttle: number;
  /** Wheel: -1 is full left, 1 is full right. */
  steer: number;
  handbrake: boolean;
}

export interface DriveResult {
  /** Hit a wall or the shore hard enough to feel it. */
  crashed: boolean;
  blocked: boolean;
}

export function stepVehicle(v: Vehicle, input: DriveInput, spec: VehicleSpec, dt: number, w: Hazards): DriveResult {
  const t = Math.max(-1, Math.min(1, input.throttle));
  if (t > 0) v.speed += (v.speed < 0 ? spec.brake : spec.accel) * t * dt;
  else if (t < 0) v.speed -= (v.speed > 0 ? spec.brake : spec.accel * 0.6) * -t * dt;
  v.speed -= v.speed * spec.drag * dt;
  if (Math.abs(t) < 0.05 && Math.abs(v.speed) < 0.4) v.speed = 0;
  if (input.handbrake) v.speed *= Math.max(0, 1 - 3.2 * dt);
  v.speed = Math.max(-spec.maxReverse, Math.min(spec.maxForward, v.speed));
  // A vehicle only turns while it moves, and turns less sharply the faster it goes.
  const grip = Math.max(-1, Math.min(1, v.speed / 5));
  v.heading += Math.max(-1, Math.min(1, input.steer)) * spec.turn * dt * grip / (1 + Math.abs(v.speed) / 18);
  const nx = v.x + Math.sin(v.heading) * v.speed * dt;
  const nz = v.z - Math.cos(v.heading) * v.speed * dt;
  const wet = w.inWater(nx, nz);
  if ((spec.water === 'avoid' && wet) || (spec.water === 'only' && !wet)) {
    const hard = Math.abs(v.speed) > 8;
    v.speed *= -0.25;
    return { crashed: hard, blocked: true };
  }
  const r = w.resolve(nx, nz, spec.radius);
  v.x = r.x;
  v.z = r.z;
  if (r.hit) {
    const hard = Math.abs(v.speed) > 9;
    v.speed *= 0.4;
    return { crashed: hard, blocked: true };
  }
  return { crashed: false, blocked: false };
}
