/**
 * People with a real skeleton and recorded animation (idle, walk, run, sit), from a free CC0 model. Each person is a copy of one
 * loaded model with their own colours and their own animation mixer. The animations are blended by speed, so someone setting off
 * eases from standing into a walk and then into a run instead of switching between poses.
 *
 * If the model cannot be loaded the game uses the hand-built figure in human.ts instead; both have the same interface.
 */
import type * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Human, Look } from './human.js';
import { DEFAULT_LOOK } from './human.js';

type Three = typeof import('three');

export type ClipName = 'idle' | 'walk' | 'run' | 'sit' | 'clap' | 'jump';

export interface CharacterTemplate {
  /** The model, not shown; people are copies of it. */
  scene: T.Object3D;
  clips: Partial<Record<ClipName, T.AnimationClip>>;
  /** Turn needed (radians about y) so the model faces -z, as everything in the game does. */
  yaw: number;
  /** Scale that makes the model stand `HEIGHT` metres tall, and the lift that puts its feet on y = 0. */
  scale: number;
  lift: number;
}

export const HEIGHT = 1.75;
/** The speeds (m/s) the recorded walk and run steps were made for; the clips are played faster or slower to match actual speed. */
export const WALK_NOMINAL = 1.5;
export const RUN_NOMINAL = 4.5;

const CLIP_PATTERNS: [ClipName, RegExp][] = [
  ['idle', /(^|[_|])idle$/i],
  ['walk', /(^|[_|])walk$/i],
  ['run', /(^|[_|])run$/i],
  ['sit', /(^|[_|])sitting$/i],
  ['clap', /(^|[_|])clapping$/i],
  ['jump', /(^|[_|])jump$/i],
];

/** Picks the clips we use out of whatever the model calls them ("HumanArmature|Man_Walk" and so on). */
export function pickClips(clips: T.AnimationClip[]): Partial<Record<ClipName, T.AnimationClip>> {
  const out: Partial<Record<ClipName, T.AnimationClip>> = {};
  for (const clip of clips) {
    for (const [name, re] of CLIP_PATTERNS) if (!out[name] && re.test(clip.name)) out[name] = clip;
  }
  return out;
}

/** Works out the turn that makes the model face -z, from which way its left foot points (the toes are forward of the ankle). */
function facingYaw(three: Three, scene: T.Object3D): number {
  scene.updateMatrixWorld(true);
  let ankle: T.Object3D | null = null;
  let toe: T.Object3D | null = null;
  scene.traverse((o) => {
    if (/^foot_?l$/i.test(o.name)) ankle = o;
    else if (/^foot_?l_?end$/i.test(o.name)) toe = o;
  });
  if (!ankle || !toe) return 0;
  const a = new three.Vector3().setFromMatrixPosition((ankle as T.Object3D).matrixWorld);
  const b = new three.Vector3().setFromMatrixPosition((toe as T.Object3D).matrixWorld);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.hypot(dx, dz) < 1e-9) return 0;
  // The foot's forward direction has heading atan2(x, -z); turning the model by that heading puts it at heading 0 (facing -z).
  return Math.atan2(dx, -dz);
}

export async function parseCharacter(three: Three, data: ArrayBuffer): Promise<CharacterTemplate> {
  const gltf = await new Promise<{ scene: T.Group; animations: T.AnimationClip[] }>((resolve, reject) => {
    new GLTFLoader().parse(data, '', (g) => resolve(g as unknown as { scene: T.Group; animations: T.AnimationClip[] }), reject);
  });
  const scene = gltf.scene;
  const yaw = facingYaw(three, scene);
  // Measure the standing model to size it and sit it on the ground.
  const holder = new three.Group();
  holder.add(scene);
  holder.rotation.y = yaw;
  holder.updateMatrixWorld(true);
  const box = new three.Box3().setFromObject(scene);
  const height = box.max.y - box.min.y;
  const scale = height > 1e-6 ? HEIGHT / height : 1;
  holder.remove(scene);
  return { scene, clips: pickClips(gltf.animations), yaw, scale, lift: -box.min.y * scale };
}

export async function loadCharacter(three: Three, url: string): Promise<CharacterTemplate | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const t = await parseCharacter(three, await res.arrayBuffer());
    return t.clips.idle && t.clips.walk && t.clips.run ? t : null;
  } catch {
    return null;
  }
}

/** The material names in the model, and which part of a Look colours each. */
const MATERIAL_PART: Record<string, keyof Look> = { Shirt: 'top', Pants: 'trousers', Skin: 'skin', Hair: 'hair', Socks: 'shoes' };

export interface AnimatedHuman extends Human {
  /** Weights of idle, walk and run right now, for tests and debugging. */
  weights(): { idle: number; walk: number; run: number };
}

export function makeAnimatedHuman(three: Three, t: CharacterTemplate, look: Look = DEFAULT_LOOK): AnimatedHuman {
  const body = cloneSkinned(t.scene);
  const inner = new three.Group();
  inner.rotation.y = t.yaw;
  inner.scale.setScalar(t.scale);
  inner.position.y = t.lift;
  inner.add(body);
  const group = new three.Group();
  group.add(inner);

  // Each person gets their own colours.
  const mats: T.Material[] = [];
  body.traverse((o) => {
    const m = o as T.Mesh;
    if (!m.isMesh) return;
    const own = (Array.isArray(m.material) ? m.material : [m.material]).map((src) => {
      const c = src.clone() as T.MeshStandardMaterial;
      const part = MATERIAL_PART[src.name];
      if (part && c.color) c.color.set(look[part]);
      mats.push(c);
      return c;
    });
    m.material = Array.isArray(m.material) ? own : own[0]!;
    m.castShadow = true;
    m.frustumCulled = false; // a skinned mesh's box is for the pose it was made in
  });

  const mixer = new three.AnimationMixer(body);
  const act = (clip: T.AnimationClip | undefined): T.AnimationAction | null => {
    if (!clip) return null;
    const a = mixer.clipAction(clip);
    a.setEffectiveWeight(0);
    a.play();
    return a;
  };
  const idle = act(t.clips.idle)!;
  const walk = act(t.clips.walk)!;
  const run = act(t.clips.run)!;
  const sitting = act(t.clips.sit);
  // People do not all start in step.
  idle.time = Math.random() * idle.getClip().duration;
  walk.time = Math.random() * walk.getClip().duration;
  run.time = Math.random() * run.getClip().duration;
  const w = { idle: 1, walk: 0, run: 0, sit: 0 };
  let seated = false;

  const update = (dt: number, speed: number, running: boolean): void => {
    // How far into a walk, and how far into a run, for this speed. They overlap, so there is always a blend, never a jump.
    const move = Math.min(1, Math.max(0, (speed - 0.15) / 0.9));
    const runAmt = running || speed > 3.4 ? Math.min(1, Math.max(0, (speed - 3.2) / 1.6)) : 0;
    const target = seated
      ? { idle: 0, walk: 0, run: 0, sit: 1 }
      : { idle: 1 - move, walk: move * (1 - runAmt), run: move * runAmt, sit: 0 };
    const k = Math.min(1, dt * 9);
    for (const key of ['idle', 'walk', 'run', 'sit'] as const) w[key] += (target[key] - w[key]) * k;
    idle.setEffectiveWeight(w.idle);
    walk.setEffectiveWeight(w.walk);
    run.setEffectiveWeight(w.run);
    sitting?.setEffectiveWeight(w.sit);
    // Steps match the ground speed, so feet do not skate.
    walk.setEffectiveTimeScale(Math.max(0.5, Math.min(2.2, speed / WALK_NOMINAL)));
    run.setEffectiveTimeScale(Math.max(0.6, Math.min(1.8, speed / RUN_NOMINAL)));
    mixer.update(dt);
  };

  return {
    group,
    update,
    weights: () => ({ idle: w.idle, walk: w.walk, run: w.run }),
    sit(on: boolean) {
      if (sitting) seated = on;
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(body);
      for (const m of mats) m.dispose();
    },
  };
}
