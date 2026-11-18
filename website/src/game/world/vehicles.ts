/**
 * Car bodies with a real side silhouette (bonnet, windscreen, roof, boot), a hollow cabin you can see into through clear glass (seats, a
 * dashboard and a steering wheel that turns), rimmed wheels and lights. Faces -z, wheels on y = 0. Paint and glass are reflective, so
 * they pick up the sky when the scene has an environment map.
 *
 * The solid parts are the engine bay and the boot, the doors (thin panels), the floor and the roof on pillars. Everything between the
 * windows is open, so a person seated inside is seen through the glass.
 */
import type * as T from 'three';

type Three = typeof import('three');
type Pt = [number, number];

export type CarKind = 'sedan' | 'suv' | 'taxi';

/** Side outlines as [along the car, height] points; the front is at negative x. Each is closed by the drawing code. */
interface Layout {
  /** The whole lower body in side view, up to the line of the windows. Used for the door panels. */
  side: Pt[];
  /** The solid engine bay and boot, full width. */
  front: Pt[];
  rear: Pt[];
  /** The windows, from the base of the windscreen over the roof to the back window. */
  glass: Pt[];
  /** The roof as a thin band, and the pillars that hold it up. */
  roof: Pt[];
  pillars: Pt[][];
  /** Where the driver's hips go: [across (negative is left), height, along]. */
  hips: [number, number, number];
  /** How far forward the cabin starts and where the boot starts, along the car; and the roof's height. */
  cabinFrom: number;
  cabinTo: number;
  roofY: number;
  beltY: number;
}

const LAYOUT: Record<'sedan' | 'suv', Layout> = {
  sedan: {
    side: [[-2.25, 0.36], [-2.28, 0.72], [-2.0, 0.88], [-0.95, 0.98], [1.5, 1.04], [2.15, 0.98], [2.28, 0.74], [2.25, 0.36]],
    front: [[-2.25, 0.36], [-2.28, 0.72], [-2.0, 0.88], [-0.95, 0.98], [-0.9, 0.98], [-0.9, 0.36]],
    rear: [[1.45, 0.36], [1.45, 1.03], [1.5, 1.04], [2.15, 0.98], [2.28, 0.74], [2.25, 0.36]],
    glass: [[-0.9, 1.0], [-0.44, 1.33], [0.25, 1.44], [0.98, 1.42], [1.45, 1.05]],
    roof: [[-0.44, 1.33], [0.25, 1.46], [1.0, 1.44], [1.05, 1.37], [0.25, 1.39], [-0.4, 1.27]],
    pillars: [
      [[-0.93, 0.98], [-0.47, 1.34], [-0.4, 1.3], [-0.86, 0.96]],
      [[1.42, 1.04], [1.0, 1.44], [0.93, 1.4], [1.35, 1.0]],
    ],
    hips: [-0.45, 0.44, 0.5],
    cabinFrom: -0.9,
    cabinTo: 1.45,
    roofY: 1.46,
    beltY: 0.98,
  },
  suv: {
    side: [[-2.3, 0.4], [-2.33, 0.88], [-2.05, 1.06], [-1.0, 1.14], [2.0, 1.14], [2.33, 0.9], [2.3, 0.4]],
    front: [[-2.3, 0.4], [-2.33, 0.88], [-2.05, 1.06], [-1.0, 1.14], [-0.98, 1.14], [-0.98, 0.4]],
    rear: [[2.1, 0.4], [2.1, 1.16], [2.2, 1.4], [2.33, 0.9], [2.3, 0.4]],
    glass: [[-0.98, 1.16], [-0.55, 1.6], [0.2, 1.72], [1.9, 1.7], [2.16, 1.56], [2.1, 1.16]],
    roof: [[-0.55, 1.62], [0.2, 1.74], [1.9, 1.72], [1.92, 1.65], [0.2, 1.67], [-0.5, 1.56]],
    pillars: [
      [[-1.0, 1.14], [-0.57, 1.62], [-0.5, 1.58], [-0.93, 1.12]],
      [[2.1, 1.2], [1.9, 1.72], [1.83, 1.68], [2.03, 1.18]],
    ],
    hips: [-0.45, 0.58, 0.45],
    cabinFrom: -0.98,
    cabinTo: 2.1,
    roofY: 1.74,
    beltY: 1.14,
  },
};

const WIDTH = 1.84;

/** A side outline pushed out into a solid of a given width, centred at x (across the car). */
function extrude(three: Three, pts: Pt[], width: number, bevel: number, x = 0): T.BufferGeometry {
  const shape = new three.Shape();
  pts.forEach(([px, py], i) => (i === 0 ? shape.moveTo(px, py) : shape.lineTo(px, py)));
  shape.closePath();
  const depth = Math.max(0.01, width - bevel * 2);
  const g = new three.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 4 });
  g.translate(0, 0, -depth / 2);
  g.rotateY(-Math.PI / 2); // length along z, width along x
  if (x !== 0) g.translate(x, 0, 0);
  return g;
}

export interface DriverLook {
  skin: string;
  hair: string;
  top: string;
}

export interface CarParts {
  group: T.Group;
  /** The body, which rolls and pitches on its suspension. Put people who sit in the car in here so they move with it. */
  cabin: T.Group;
  /** Where the driver's hips go, in the car's own frame (x across, y up, z along; the front is negative z). */
  seat: [number, number, number];
  /**
   * Moves the wheels and body for this moment: the car's speed (m/s, negative in reverse), how fast it is turning (rad/s, positive to
   * the right) and how fast its speed is changing (m/s², negative when braking).
   */
  animate(dt: number, speed: number, yawRate: number, accel: number): void;
  /** How dark it is, 0 to 1: the headlights shine brighter as it gets dark. */
  setNight(night: number): void;
  /** Seats a simple, cheap figure at the wheel (for traffic); does nothing if there is one already. */
  addDummyDriver(look: DriverLook): void;
  dispose(): void;
}

/** Eases a value towards a target; the same at any frame rate. */
export const approach = (value: number, target: number, rate: number, dt: number): number => value + (target - value) * (1 - Math.exp(-rate * dt));

/** How far the front wheels turn for a given turn rate and speed (a bicycle model, wheelbase in metres), limited to what a car can do. */
export function steerAngle(yawRate: number, speed: number, wheelbase = 2.8): number {
  const v = Math.max(Math.abs(speed), 1.5);
  const raw = Math.atan((yawRate * wheelbase) / v) * (speed < 0 ? -1 : 1);
  return Math.max(-0.55, Math.min(0.55, raw));
}

export function makeCar(three: Three, colour: string, kind: CarKind = 'sedan'): CarParts {
  const geos: T.BufferGeometry[] = [];
  const mats: T.Material[] = [];
  const mesh = (g: T.BufferGeometry, m: T.Material): T.Mesh => {
    geos.push(g);
    if (!mats.includes(m)) mats.push(m);
    const o = new three.Mesh(g, m);
    o.castShadow = true;
    return o;
  };
  const shape = kind === 'suv' ? 'suv' : 'sedan';
  const L = LAYOUT[shape];
  const paint = new three.MeshStandardMaterial({ color: kind === 'taxi' ? '#f1b900' : colour, metalness: 0.55, roughness: 0.28 });
  // Clear glass: dark and glossy but see-through, so the inside shows. It does not hide what is behind it from the depth buffer.
  const glass = new three.MeshStandardMaterial({ color: '#0f1720', metalness: 0.5, roughness: 0.06, transparent: true, opacity: 0.3, side: three.DoubleSide, depthWrite: false });
  const rubber = new three.MeshStandardMaterial({ color: '#141414', roughness: 0.9 });
  const rim = new three.MeshStandardMaterial({ color: '#c9ccd1', metalness: 0.9, roughness: 0.25 });
  const trim = new three.MeshStandardMaterial({ color: '#1b1b1d', roughness: 0.7 });
  const interior = new three.MeshStandardMaterial({ color: '#2d2f34', roughness: 0.9 });
  const head = new three.MeshStandardMaterial({ color: '#fff4cf', emissive: '#fff0b8', emissiveIntensity: 1.4 });
  const tail = new three.MeshStandardMaterial({ color: '#8a0d0d', emissive: '#ff1a1a', emissiveIntensity: 1.1 });

  const g = new three.Group();
  // The body rolls and pitches on its suspension; the wheels stay on the ground and turn and spin.
  const shell = new three.Group();
  g.add(shell);
  // Solid engine bay and boot, thin door panels down each side, and a floor: the cabin between is open.
  shell.add(mesh(extrude(three, L.front, WIDTH, 0.05), paint));
  shell.add(mesh(extrude(three, L.rear, WIDTH, 0.05), paint));
  for (const side of [-1, 1]) shell.add(mesh(extrude(three, L.side, 0.1, 0.02, side * (WIDTH / 2 - 0.06)), paint));
  const cabinLen = L.cabinTo - L.cabinFrom;
  const floor = mesh(new three.BoxGeometry(WIDTH - 0.16, 0.08, cabinLen), interior);
  floor.position.set(0, L.hips[1] - 0.1, (L.cabinFrom + L.cabinTo) / 2);
  shell.add(floor);
  // The roof on its pillars, and the windows between.
  shell.add(mesh(extrude(three, L.roof, WIDTH - 0.04, 0.02), paint));
  for (const p of L.pillars) for (const side of [-1, 1]) shell.add(mesh(extrude(three, p, 0.07, 0.015, side * (WIDTH / 2 - 0.1)), paint));
  const bPillar = (side: number): T.Mesh => {
    const h = L.roofY - L.beltY - 0.1;
    const m = mesh(new three.BoxGeometry(0.07, h, 0.1), paint);
    m.position.set(side * (WIDTH / 2 - 0.1), L.beltY + h / 2, L.hips[2] + 0.45);
    return m;
  };
  shell.add(bPillar(-1), bPillar(1));
  const windows = mesh(extrude(three, L.glass, WIDTH - 0.02, 0.01), glass);
  windows.castShadow = false;
  windows.renderOrder = 4; // after the inside, so the inside shows through
  shell.add(windows);

  // Seats, a dashboard and a steering wheel.
  const [hx, hy, hz] = L.hips;
  const seatAt = (x: number, z: number, wide: number): void => {
    const cushion = mesh(new three.BoxGeometry(wide, 0.12, 0.5), interior);
    cushion.position.set(x, hy - 0.07, z);
    const back = mesh(new three.BoxGeometry(wide, 0.55, 0.09), interior);
    back.position.set(x, hy + 0.25, z + 0.3);
    back.rotation.x = -0.15;
    shell.add(cushion, back);
  };
  seatAt(hx, hz, 0.5);
  seatAt(-hx, hz, 0.5);
  seatAt(0, hz + 0.85, WIDTH - 0.3);
  const dash = mesh(new three.BoxGeometry(WIDTH - 0.24, 0.22, 0.4), interior);
  dash.position.set(0, L.beltY - 0.11, L.cabinFrom + 0.3);
  shell.add(dash);
  const column = new three.Group(); // tilted a little towards the driver
  column.position.set(hx, hy + 0.5, hz - 0.62);
  column.rotation.x = 0.55;
  const wheelMesh = mesh(new three.TorusGeometry(0.17, 0.022, 8, 24), trim);
  column.add(wheelMesh);
  shell.add(column);

  const wheelR = kind === 'suv' ? 0.42 : 0.36;
  const front = kind === 'suv' ? -1.45 : -1.4;
  const back = kind === 'suv' ? 1.45 : 1.4;
  const wheelbase = back - front;
  const steering: T.Group[] = [];
  const spinning: T.Group[] = [];
  for (const [x, z] of [[-0.8, front], [0.8, front], [-0.8, back], [0.8, back]] as const) {
    const pivot = new three.Group(); // turns with the steering (front wheels only)
    pivot.position.set(x, wheelR, z);
    const spin = new three.Group(); // rolls with the road
    const tyre = mesh(new three.CylinderGeometry(wheelR, wheelR, 0.28, 20), rubber);
    tyre.rotation.z = Math.PI / 2;
    const disc = mesh(new three.CylinderGeometry(wheelR * 0.62, wheelR * 0.62, 0.3, 14), rim);
    disc.rotation.z = Math.PI / 2;
    // Spokes, so the spin can be seen.
    for (let i = 0; i < 5; i++) {
      const spoke = mesh(new three.BoxGeometry(0.31, wheelR * 1.1, 0.06), trim);
      spoke.rotation.x = (i / 5) * Math.PI;
      spin.add(spoke);
    }
    spin.add(tyre, disc);
    pivot.add(spin);
    g.add(pivot);
    spinning.push(spin);
    if (z === front) steering.push(pivot);
  }
  const frontZ = -2.3;
  const rearZ = 2.3;
  for (const x of [-0.62, 0.62]) {
    const h = mesh(new three.BoxGeometry(0.4, 0.14, 0.06), head);
    h.position.set(x, kind === 'suv' ? 0.92 : 0.78, frontZ);
    const t = mesh(new three.BoxGeometry(0.42, 0.13, 0.06), tail);
    t.position.set(x, kind === 'suv' ? 1.0 : 0.82, rearZ);
    shell.add(h, t);
  }
  const bumperF = mesh(new three.BoxGeometry(1.8, 0.2, 0.18), trim);
  bumperF.position.set(0, 0.42, frontZ + 0.02);
  const bumperR = mesh(new three.BoxGeometry(1.8, 0.2, 0.18), trim);
  bumperR.position.set(0, 0.42, rearZ - 0.02);
  shell.add(bumperF, bumperR);
  if (kind === 'taxi') {
    const sign = mesh(new three.BoxGeometry(0.55, 0.16, 0.22), new three.MeshStandardMaterial({ color: '#fff6c8', emissive: '#ffe58a', emissiveIntensity: 0.9 }));
    sign.position.set(0, L.roofY + 0.09, 0.2);
    shell.add(sign);
  }

  let dummy: { group: T.Group; dispose(): void } | null = null;
  const s = { steer: 0, roll: 0, pitch: 0, spin: 0, bounce: 0, t: Math.random() * 10 };
  const animate = (dt: number, speed: number, yawRate: number, accel: number): void => {
    s.t += dt;
    s.spin -= (speed * dt) / wheelR; // forward is -z, so a rolling wheel turns negatively about x
    for (const w of spinning) w.rotation.x = s.spin;
    s.steer = approach(s.steer, steerAngle(yawRate, speed, wheelbase), 14, dt);
    for (const w of steering) w.rotation.y = -s.steer; // a right turn (positive yaw) turns the wheels to the right, which is negative about y
    wheelMesh.rotation.z = -s.steer * 4; // the steering wheel turns about four times as far as the road wheels
    // Leans outward in a turn and dips on braking, lifts on acceleration; settles smoothly.
    const lateral = yawRate * speed;
    s.roll = approach(s.roll, Math.max(-0.07, Math.min(0.07, lateral * 0.006)), 7, dt);
    s.pitch = approach(s.pitch, Math.max(-0.06, Math.min(0.06, accel * 0.004)), 6, dt);
    shell.rotation.z = s.roll;
    shell.rotation.x = s.pitch;
    // A little road bounce that grows with speed.
    s.bounce = Math.sin(s.t * 23) * 0.006 * Math.min(1, Math.abs(speed) / 15);
    shell.position.y = s.bounce - Math.abs(s.pitch) * 0.2;
    // Brake lights shine brighter when slowing.
    tail.emissiveIntensity = approach(tail.emissiveIntensity, accel < -2.5 && speed > 0.5 ? 3.2 : 1.1, 20, dt);
  };

  return {
    group: g,
    cabin: shell,
    seat: [hx, hy, hz],
    animate,
    setNight(night) {
      head.emissiveIntensity = 1.4 + Math.max(0, Math.min(1, night)) * 3.4;
    },
    addDummyDriver(look) {
      if (dummy) return;
      dummy = dummyDriver(three, look, [hx, hy, hz]);
      shell.add(dummy.group);
    },
    dispose() {
      dummy?.dispose();
      for (const x of geos) x.dispose();
      for (const m of mats) m.dispose();
    },
  };
}

/** A cheap seated person for traffic cars: a torso, a head with hair, and two arms reaching for the wheel. Hips at `at`. */
function dummyDriver(three: Three, look: DriverLook, at: [number, number, number]): { group: T.Group; dispose(): void } {
  const group = new three.Group();
  group.position.set(...at);
  const geos: T.BufferGeometry[] = [];
  const mats = [
    new three.MeshStandardMaterial({ color: look.skin, roughness: 0.75 }),
    new three.MeshStandardMaterial({ color: look.top, roughness: 0.85 }),
    new three.MeshStandardMaterial({ color: look.hair, roughness: 0.9 }),
  ] as const;
  const part = (g: T.BufferGeometry, m: T.Material, x: number, y: number, z: number): T.Mesh => {
    geos.push(g);
    const o = new three.Mesh(g, m);
    o.position.set(x, y, z);
    return o;
  };
  const torso = part(new three.CapsuleGeometry(0.16, 0.3, 4, 10), mats[1], 0, 0.36, 0.02);
  torso.scale.set(1.15, 1, 0.75);
  const headMesh = part(new three.SphereGeometry(0.105, 14, 10), mats[0], 0, 0.84, 0);
  headMesh.scale.set(0.92, 1.12, 1.02);
  const hair = part(new three.SphereGeometry(0.11, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), mats[2], 0, 0.855, 0.01);
  hair.scale.set(0.95, 1.1, 1.05);
  group.add(torso, headMesh, hair);
  for (const side of [-1, 1]) {
    // From the shoulder, forward and down towards the wheel.
    const shoulder = new three.Group();
    shoulder.position.set(side * 0.2, 0.56, 0);
    shoulder.rotation.x = 1.15;
    shoulder.add(part(new three.CapsuleGeometry(0.045, 0.34, 4, 8), mats[1], 0, -0.22, 0));
    group.add(shoulder);
  }
  return {
    group,
    dispose() {
      for (const x of geos) x.dispose();
      for (const m of mats) m.dispose();
    },
  };
}

export const TRAFFIC_COLOURS = ['#d8d8dc', '#1c1c20', '#8c1d1d', '#27456e', '#5c6670', '#e9e4d6', '#2f5a3c', '#b0b4ba'];
