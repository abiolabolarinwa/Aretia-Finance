/**
 * Car bodies with a real side silhouette (bonnet, windscreen, roof, boot), tinted glass, rimmed wheels and lights. Faces -z, wheels on y = 0.
 * Paint and glass are reflective, so they pick up the sky when the scene has an environment map.
 */
import type * as T from 'three';

type Three = typeof import('three');

export type CarKind = 'sedan' | 'suv' | 'taxi';

/** Side profiles as [along the car, height] points; the front is at negative x. */
const BODY: Record<'sedan' | 'suv', [number, number][]> = {
  sedan: [[-2.25, 0.36], [-2.28, 0.72], [-2.0, 0.88], [-0.95, 0.98], [-0.45, 1.34], [0.25, 1.46], [1.0, 1.44], [1.5, 1.04], [2.15, 0.98], [2.28, 0.74], [2.25, 0.36]],
  suv: [[-2.3, 0.4], [-2.33, 0.88], [-2.05, 1.06], [-1.0, 1.14], [-0.55, 1.62], [0.2, 1.74], [1.9, 1.72], [2.2, 1.55], [2.33, 0.9], [2.3, 0.4]],
};
const GLASS: Record<'sedan' | 'suv', [number, number][]> = {
  sedan: [[-0.9, 1.0], [-0.44, 1.33], [0.25, 1.44], [0.98, 1.42], [1.45, 1.05]],
  suv: [[-0.98, 1.16], [-0.55, 1.6], [0.2, 1.72], [1.9, 1.7], [2.16, 1.56], [2.1, 1.16]],
};

const WIDTH = 1.84;

function extrude(three: Three, pts: [number, number][], width: number, bevel: number): T.BufferGeometry {
  const shape = new three.Shape();
  pts.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  shape.closePath();
  const g = new three.ExtrudeGeometry(shape, { depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 4 });
  g.translate(0, 0, -(width - bevel * 2) / 2);
  g.rotateY(-Math.PI / 2); // length along z, width along x
  return g;
}

export interface CarParts {
  group: T.Group;
  /**
   * Moves the wheels and body for this moment: the car's speed (m/s, negative in reverse), how fast it is turning (rad/s, positive to
   * the right) and how fast its speed is changing (m/s², negative when braking).
   */
  animate(dt: number, speed: number, yawRate: number, accel: number): void;
  /** How dark it is, 0 to 1: the headlights shine brighter as it gets dark. */
  setNight(night: number): void;
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
  const paint = new three.MeshStandardMaterial({ color: kind === 'taxi' ? '#f1b900' : colour, metalness: 0.55, roughness: 0.28 });
  const glass = new three.MeshStandardMaterial({ color: '#10161d', metalness: 0.9, roughness: 0.08 });
  const rubber = new three.MeshStandardMaterial({ color: '#141414', roughness: 0.9 });
  const rim = new three.MeshStandardMaterial({ color: '#c9ccd1', metalness: 0.9, roughness: 0.25 });
  const trim = new three.MeshStandardMaterial({ color: '#1b1b1d', roughness: 0.7 });
  const head = new three.MeshStandardMaterial({ color: '#fff4cf', emissive: '#fff0b8', emissiveIntensity: 1.4 });
  const tail = new three.MeshStandardMaterial({ color: '#8a0d0d', emissive: '#ff1a1a', emissiveIntensity: 1.1 });

  const g = new three.Group();
  // The body rolls and pitches on its suspension; the wheels stay on the ground and turn and spin.
  const shell = new three.Group();
  g.add(shell);
  shell.add(mesh(extrude(three, BODY[shape], WIDTH, 0.05), paint));
  shell.add(mesh(extrude(three, GLASS[shape], WIDTH + 0.02, 0.03), glass));
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
    sign.position.set(0, 1.55, 0.2);
    shell.add(sign);
  }

  const s = { steer: 0, roll: 0, pitch: 0, spin: 0, bounce: 0, t: Math.random() * 10 };
  const animate = (dt: number, speed: number, yawRate: number, accel: number): void => {
    s.t += dt;
    s.spin -= (speed * dt) / wheelR; // forward is -z, so a rolling wheel turns negatively about x
    for (const w of spinning) w.rotation.x = s.spin;
    s.steer = approach(s.steer, steerAngle(yawRate, speed, wheelbase), 14, dt);
    for (const w of steering) w.rotation.y = -s.steer; // a right turn (positive yaw) turns the wheels to the right, which is negative about y
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
    animate,
    setNight(night) {
      head.emissiveIntensity = 1.4 + Math.max(0, Math.min(1, night)) * 3.4;
    },
    dispose() {
      for (const x of geos) x.dispose();
      for (const m of mats) m.dispose();
    },
  };
}

export const TRAFFIC_COLOURS = ['#d8d8dc', '#1c1c20', '#8c1d1d', '#27456e', '#5c6670', '#e9e4d6', '#2f5a3c', '#b0b4ba'];
