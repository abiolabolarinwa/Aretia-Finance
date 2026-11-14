/**
 * A person, built from rounded shapes at real proportions (1.75 m tall, about 7.5 heads high), with hips, knees, shoulders and elbows
 * that bend, so walking and running look like walking and running. Faces -z, feet on y = 0.
 */
import type * as T from 'three';

type Three = typeof import('three');

export interface Look {
  skin: string;
  hair: string;
  top: string;
  trousers: string;
  shoes: string;
}
export const DEFAULT_LOOK: Look = { skin: '#9c6a48', hair: '#17120f', top: '#2d4a73', trousers: '#34373f', shoes: '#f0f0f0' };

export interface Human {
  group: T.Group;
  /** Moves the limbs for this moment: how fast the person is going (m/s), whether running, and the time step in seconds. */
  update(dt: number, speed: number, running: boolean): void;
  dispose(): void;
}

export function makeHuman(three: Three, look: Look = DEFAULT_LOOK): Human {
  const mats = {
    skin: new three.MeshStandardMaterial({ color: look.skin, roughness: 0.75, metalness: 0 }),
    hair: new three.MeshStandardMaterial({ color: look.hair, roughness: 0.9 }),
    top: new three.MeshStandardMaterial({ color: look.top, roughness: 0.85 }),
    trousers: new three.MeshStandardMaterial({ color: look.trousers, roughness: 0.9 }),
    shoes: new three.MeshStandardMaterial({ color: look.shoes, roughness: 0.6 }),
    sole: new three.MeshStandardMaterial({ color: '#222222', roughness: 0.9 }),
    eye: new three.MeshBasicMaterial({ color: '#0d0d0d' }),
    white: new three.MeshBasicMaterial({ color: '#f4f4f4' }),
  };
  const geos: T.BufferGeometry[] = [];
  const part = (g: T.BufferGeometry, m: T.Material, x = 0, y = 0, z = 0): T.Mesh => {
    geos.push(g);
    const mesh = new three.Mesh(g, m);
    mesh.position.set(x, y, z);
    return mesh;
  };
  const capsule = (r: number, len: number, m: T.Material, sx = 1, sz = 1): T.Mesh => {
    const mesh = part(new three.CapsuleGeometry(r, len, 6, 12), m);
    mesh.scale.set(sx, 1, sz);
    return mesh;
  };

  const group = new three.Group();
  const body = new three.Group(); // bobs and leans
  group.add(body);

  // Torso: chest and belly, a little wider than deep.
  const torso = new three.Group();
  torso.position.set(0, 1.0, 0);
  body.add(torso);
  const chest = capsule(0.15, 0.2, mats.top, 1.3, 0.78);
  chest.position.set(0, 0.3, 0);
  const belly = capsule(0.135, 0.12, mats.top, 1.2, 0.8);
  belly.position.set(0, 0.1, 0);
  torso.add(chest, belly);
  const hips = capsule(0.14, 0.04, mats.trousers, 1.25, 0.85);
  hips.position.set(0, -0.02, 0);
  body.add(hips);
  hips.position.y = 0.97;

  // Neck and head. The face has eyes, brows and a nose so it reads as a face from behind and the side.
  const neck = part(new three.CylinderGeometry(0.052, 0.058, 0.1, 12), mats.skin, 0, 0.5, 0);
  torso.add(neck);
  const head = new three.Group();
  head.position.set(0, 0.62, 0);
  torso.add(head);
  const skull = part(new three.SphereGeometry(0.1, 20, 16), mats.skin);
  skull.scale.set(0.92, 1.12, 1.02);
  const hair = part(new three.SphereGeometry(0.105, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.52), mats.hair, 0, 0.012, 0.012);
  hair.scale.set(0.95, 1.12, 1.06);
  const back = part(new three.SphereGeometry(0.1, 16, 10, 0, Math.PI * 2, Math.PI * 0.35, Math.PI * 0.3), mats.hair, 0, -0.01, 0.025);
  back.scale.set(0.98, 1.1, 1.05);
  const nose = part(new three.SphereGeometry(0.018, 8, 6), mats.skin, 0, -0.012, -0.105);
  const eyeL = part(new three.SphereGeometry(0.011, 8, 6), mats.eye, -0.036, 0.018, -0.092);
  const eyeR = part(new three.SphereGeometry(0.011, 8, 6), mats.eye, 0.036, 0.018, -0.092);
  const browL = part(new three.BoxGeometry(0.04, 0.007, 0.01), mats.hair, -0.036, 0.04, -0.095);
  const browR = part(new three.BoxGeometry(0.04, 0.007, 0.01), mats.hair, 0.036, 0.04, -0.095);
  head.add(skull, hair, back, nose, eyeL, eyeR, browL, browR);

  // Arms: shoulder, upper arm, elbow, forearm, hand.
  const arm = (side: number): { shoulder: T.Group; elbow: T.Group } => {
    const shoulder = new three.Group();
    shoulder.position.set(0.215 * side, 0.43, 0);
    const upper = capsule(0.043, 0.2, mats.top);
    upper.position.y = -0.15;
    const elbow = new three.Group();
    elbow.position.y = -0.3;
    const fore = capsule(0.036, 0.2, mats.skin);
    fore.position.y = -0.14;
    const hand = part(new three.SphereGeometry(0.04, 10, 8), mats.skin, 0, -0.3, 0);
    hand.scale.set(0.85, 1.15, 0.6);
    elbow.add(fore, hand);
    shoulder.add(upper, elbow);
    torso.add(shoulder);
    return { shoulder, elbow };
  };
  const armL = arm(-1);
  const armR = arm(1);

  // Legs: hip, thigh, knee, shin, shoe.
  const leg = (side: number): { hip: T.Group; knee: T.Group } => {
    const hip = new three.Group();
    hip.position.set(0.085 * side, 0.95, 0);
    const thigh = capsule(0.07, 0.3, mats.trousers);
    thigh.position.y = -0.22;
    const knee = new three.Group();
    knee.position.y = -0.46;
    const shin = capsule(0.054, 0.3, mats.trousers);
    shin.position.y = -0.22;
    const shoe = part(new three.BoxGeometry(0.095, 0.07, 0.25), mats.shoes, 0, -0.45, -0.05);
    const sole = part(new three.BoxGeometry(0.1, 0.02, 0.26), mats.sole, 0, -0.485, -0.05);
    knee.add(shin, shoe, sole);
    hip.add(thigh, knee);
    body.add(hip);
    return { hip, knee };
  };
  const legL = leg(-1);
  const legR = leg(1);

  let phase = 0;
  let t = 0;
  let amount = 0; // how much of a stride the person is in, eased so they settle into standing
  const update = (dt: number, speed: number, running: boolean): void => {
    t += dt;
    const target = Math.min(1, speed / (running ? 5 : 2));
    amount += (target - amount) * Math.min(1, dt * 10);
    phase += dt * speed * (running ? 1.55 : 2.35); // a longer stride the faster they go
    const swing = running ? 0.95 : 0.55;
    const s = Math.sin(phase);
    const c = Math.cos(phase);
    legL.hip.rotation.x = s * swing * amount;
    legR.hip.rotation.x = -s * swing * amount;
    // The knee bends as the leg swings forward off the ground and straightens as the foot lands.
    legL.knee.rotation.x = -(Math.max(0, c) * (running ? 1.35 : 0.7)) * amount - 0.04;
    legR.knee.rotation.x = -(Math.max(0, -c) * (running ? 1.35 : 0.7)) * amount - 0.04;
    const armSwing = running ? 0.9 : 0.45;
    armL.shoulder.rotation.x = -s * armSwing * amount;
    armR.shoulder.rotation.x = s * armSwing * amount;
    armL.shoulder.rotation.z = 0.06;
    armR.shoulder.rotation.z = -0.06;
    armL.elbow.rotation.x = -(running ? 1.5 : 0.25) * amount - 0.12;
    armR.elbow.rotation.x = -(running ? 1.5 : 0.25) * amount - 0.12;
    body.position.y = Math.abs(Math.sin(phase)) * (running ? 0.045 : 0.02) * amount;
    body.rotation.x = (running ? -0.2 : -0.04) * amount;
    torso.rotation.y = s * (running ? 0.18 : 0.08) * amount;
    // Breathing, and a slow look about when standing still.
    const idle = 1 - amount;
    torso.scale.setScalar(1 + Math.sin(t * 1.9) * 0.006 * idle);
    head.rotation.y = Math.sin(t * 0.6) * 0.25 * idle;
  };

  return {
    group,
    update,
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of Object.values(mats)) m.dispose();
    },
  };
}
