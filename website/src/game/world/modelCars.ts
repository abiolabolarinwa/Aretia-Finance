/**
 * Cars made from free 3D models (CC0, Quaternius and Kay Lousberg), so the traffic has more kinds of vehicle than the hand-built ones:
 * a taxi, SUV, saloon, pickup, hatchback and sports car. Each loaded car is rigged to behave like the hand-built cars: the wheels are
 * lifted out of the body and re-centred so they spin about their own axis, the front pair steer, the body rolls and pitches on its own,
 * the headlights brighten in the dark and the brake lights flare. The model's own size and facing are measured and corrected, so every
 * car is the right length, sits on the ground, and faces -z.
 */
import type * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { approach, steerAngle, type CarParts } from './vehicles.js';

type Three = typeof import('three');

export interface CarModelSpec {
  file: string;
  name: string;
  /** How long the car should be in metres (the model is scaled to it). */
  length: number;
  /** Whether its paint can be changed (the models with a plain painted body can; the ones with a picture painted on cannot). */
  recolour: boolean;
}

export const CAR_MODELS: CarModelSpec[] = [
  { file: 'taxi', name: 'Taxi', length: 4.6, recolour: false },
  { file: 'suv', name: 'SUV', length: 4.8, recolour: true },
  { file: 'sedan', name: 'Car', length: 4.5, recolour: true },
  { file: 'pickup', name: 'Pickup', length: 5.2, recolour: false },
  { file: 'hatchback', name: 'Hatchback', length: 3.9, recolour: false },
  { file: 'sports', name: 'Sports car', length: 4.4, recolour: true },
];

/** The material names that are the body paint in the models that have one. */
const PAINT = new Set(['Yellow', 'White', 'LightBlue', 'Orange']);

export interface CarTemplate {
  spec: CarModelSpec;
  /** The body, in the model's own space. */
  body: T.Object3D;
  /** The wheels: a group of pivots (one per wheel mesh) at each wheel's centre, in the model's own space. */
  wheels: T.Object3D;
  /** The turn about the vertical that makes the model face -z, the scale that makes it the right length, and the lift onto the ground. */
  yaw: number;
  scale: number;
  lift: number;
  /** The radius of a wheel in metres after scaling. */
  wheelR: number;
  wheelbase: number;
}

export async function parseCarModel(three: Three, data: ArrayBuffer, spec: CarModelSpec): Promise<CarTemplate> {
  const gltf = await new Promise<{ scene: T.Group }>((resolve, reject) => {
    new GLTFLoader().parse(data, '', (g) => resolve(g as unknown as { scene: T.Group }), reject);
  });
  const body = gltf.scene;
  body.updateMatrixWorld(true);
  // A wheel is a node named for it, and may hold several meshes (a tyre and a rim). Find them without going inside one that is found.
  const wheelNodes: { node: T.Object3D; front: boolean }[] = [];
  const scan = (o: T.Object3D): void => {
    if (o !== body && /wheel|tire|tyre/i.test(o.name)) {
      let hasMesh = false;
      o.traverse((c) => {
        if ((c as T.Mesh).isMesh) hasMesh = true;
      });
      if (hasMesh) {
        wheelNodes.push({ node: o, front: /front/i.test(o.name) });
        return;
      }
    }
    for (const c of [...o.children]) scan(c);
  };
  scan(body);
  // Lift each wheel out of the body: bake where it is into its shape, then re-centre it on its own middle, so it can turn about its axis.
  const wheels = new three.Group();
  const centres: { front: boolean; c: T.Vector3; r: number }[] = [];
  for (const { node, front } of wheelNodes) {
    const meshes: T.Mesh[] = [];
    node.traverse((c) => {
      if ((c as T.Mesh).isMesh) meshes.push(c as T.Mesh);
    });
    const box = new three.Box3();
    for (const mesh of meshes) {
      const geo = mesh.geometry.clone();
      geo.applyMatrix4(mesh.matrixWorld);
      geo.computeBoundingBox();
      box.union(geo.boundingBox!);
      mesh.geometry = geo;
    }
    const c = box.getCenter(new three.Vector3());
    const pivot = new three.Group();
    pivot.position.copy(c);
    pivot.userData.wheel = front ? 'front' : 'rear';
    for (const mesh of meshes) {
      mesh.geometry.translate(-c.x, -c.y, -c.z);
      mesh.removeFromParent();
      mesh.position.set(0, 0, 0);
      mesh.rotation.set(0, 0, 0);
      mesh.scale.set(1, 1, 1);
      mesh.updateMatrix();
      pivot.add(mesh);
    }
    node.removeFromParent();
    wheels.add(pivot);
    centres.push({ front, c, r: (box.max.y - box.min.y) / 2 });
  }
  // Which way the car faces: from the rear wheels towards the front wheels.
  const mean = (list: T.Vector3[]): T.Vector3 => list.reduce((s, v) => s.add(v), new three.Vector3()).multiplyScalar(1 / Math.max(1, list.length));
  const fc = mean(centres.filter((w) => w.front).map((w) => w.c));
  const rc = mean(centres.filter((w) => !w.front).map((w) => w.c));
  const fx = fc.x - rc.x;
  const fz = fc.z - rc.z;
  const yaw = centres.some((w) => w.front) && centres.some((w) => !w.front) && Math.hypot(fx, fz) > 1e-6 ? Math.atan2(fx, -fz) : 0;
  // Measure the whole car turned to face -z, to size it and sit it on the ground.
  const holder = new three.Group();
  holder.add(body, wheels);
  holder.rotation.y = yaw;
  holder.updateMatrixWorld(true);
  const box = new three.Box3().setFromObject(holder);
  const length = box.max.z - box.min.z;
  const scale = length > 1e-6 ? spec.length / length : 1;
  holder.remove(body, wheels);
  const radius = centres.length ? centres.reduce((s, w) => s + w.r, 0) / centres.length : 0.35 / scale;
  return { spec, body, wheels, yaw, scale, lift: -box.min.y * scale, wheelR: radius * scale, wheelbase: Math.max(2, Math.hypot(fx, fz) * scale) };
}

export async function loadCarModel(three: Three, url: string, spec: CarModelSpec): Promise<CarTemplate | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const t = await parseCarModel(three, await res.arrayBuffer(), spec);
    return t.wheels.children.length >= 3 ? t : null;
  } catch {
    return null;
  }
}

/** One car of a loaded model, in the body paint `colour` if the model allows it. Behaves like the hand-built cars. */
export function makeModelCar(three: Three, t: CarTemplate, colour?: string): CarParts {
  const g = new three.Group();
  const shell = new three.Group(); // rolls and pitches
  g.add(shell);
  const place = (): T.Group => {
    const inner = new three.Group();
    inner.rotation.y = t.yaw;
    inner.scale.setScalar(t.scale);
    inner.position.y = t.lift;
    return inner;
  };
  const bodyInner = place();
  const body = t.body.clone(true);
  bodyInner.add(body);
  shell.add(bodyInner);
  const wheelInner = place();
  const wheels = t.wheels.clone(true);
  wheelInner.add(wheels);
  g.add(wheelInner);

  // Each car has its own copy of the materials, so one car's paint or lights never change another's.
  const mats: T.Material[] = [];
  const headlights: T.MeshStandardMaterial[] = [];
  const brakelights: T.MeshStandardMaterial[] = [];
  const own = (root: T.Object3D): void => {
    root.traverse((o) => {
      const m = o as T.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      const list = Array.isArray(m.material) ? m.material : [m.material];
      const copies = list.map((src) => {
        const c = src.clone() as T.MeshStandardMaterial;
        if (colour && t.spec.recolour && PAINT.has(src.name)) c.color.set(colour);
        if (/headlight/i.test(src.name)) headlights.push(c);
        if (/taillight|brakelight/i.test(src.name)) brakelights.push(c);
        mats.push(c);
        return c;
      });
      m.material = Array.isArray(m.material) ? copies : copies[0]!;
    });
  };
  own(body);
  own(wheels);
  for (const h of headlights) {
    h.emissive = new three.Color('#fff0b8');
    h.emissiveIntensity = 0.6;
  }
  for (const b of brakelights) {
    b.emissive = new three.Color('#ff1a1a');
    b.emissiveIntensity = 0.5;
  }

  const front: T.Object3D[] = [];
  const spinning: T.Object3D[] = [];
  wheels.traverse((o) => {
    if (o.userData.wheel) {
      spinning.push(...o.children); // the tyre and the rim turn together
      if (o.userData.wheel === 'front') front.push(o);
    }
  });
  // The model is turned half a turn when its front was the other way round, which flips which way a wheel's turn about its axle looks.
  const spinSign = Math.cos(t.yaw) >= 0 ? 1 : -1;
  const s = { steer: 0, roll: 0, pitch: 0, spin: 0, bounce: 0, t: Math.random() * 10 };
  const animate = (dt: number, speed: number, yawRate: number, accel: number): void => {
    s.t += dt;
    s.spin -= (speed * dt) / Math.max(0.2, t.wheelR);
    for (const w of spinning) w.rotation.x = spinSign * s.spin;
    s.steer = approach(s.steer, steerAngle(yawRate, speed, t.wheelbase), 14, dt);
    for (const w of front) w.rotation.y = -s.steer;
    const lateral = yawRate * speed;
    s.roll = approach(s.roll, Math.max(-0.07, Math.min(0.07, lateral * 0.006)), 7, dt);
    s.pitch = approach(s.pitch, Math.max(-0.06, Math.min(0.06, accel * 0.004)), 6, dt);
    shell.rotation.z = s.roll;
    shell.rotation.x = s.pitch;
    s.bounce = Math.sin(s.t * 23) * 0.006 * Math.min(1, Math.abs(speed) / 15);
    shell.position.y = s.bounce - Math.abs(s.pitch) * 0.2;
    const braking = accel < -2.5 && speed > 0.5;
    for (const b of brakelights) b.emissiveIntensity = approach(b.emissiveIntensity, braking ? 2.6 : 0.5, 20, dt);
  };

  return {
    group: g,
    cabin: shell,
    seat: [-0.45, 0.5, 0.3],
    interior: false,
    animate,
    setNight(night) {
      const n = Math.max(0, Math.min(1, night));
      for (const h of headlights) h.emissiveIntensity = 0.6 + n * 3;
    },
    addDummyDriver() {
      // The windows of these models are dark and solid, so there is nobody to see.
    },
    dispose() {
      for (const m of mats) m.dispose();
    },
  };
}
