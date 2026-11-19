/**
 * Street furniture from free 3D models (CC0): each model is loaded once, its parts baked into plain shapes standing on the ground at the
 * right height, and then drawn as many copies at a time (one instanced mesh per part). The shapes and materials are shared by every
 * copy and every map square, so a hundred benches cost no more memory than one.
 */
import type * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { PropPlacement } from './roamProps.js';

type Three = typeof import('three');

export interface PropTemplate {
  /** The parts of the model: a shape (in metres at the scale of the model, standing on y = 0, centred) and its material. */
  parts: { geometry: T.BufferGeometry; material: T.Material }[];
  /** The scale that makes the model the wanted height. */
  scale: number;
}

export async function parseProp(three: Three, data: ArrayBuffer, height: number): Promise<PropTemplate> {
  const gltf = await new Promise<{ scene: T.Group }>((resolve, reject) => {
    new GLTFLoader().parse(data, '', (g) => resolve(g as unknown as { scene: T.Group }), reject);
  });
  gltf.scene.updateMatrixWorld(true);
  const parts: PropTemplate['parts'] = [];
  const box = new three.Box3();
  gltf.scene.traverse((o) => {
    const m = o as T.Mesh;
    if (!m.isMesh) return;
    const geometry = m.geometry.clone();
    geometry.applyMatrix4(m.matrixWorld); // where the part sits in the model
    geometry.computeBoundingBox();
    box.union(geometry.boundingBox!);
    // A part with several materials is drawn as its first one (the models used here have one material per part).
    parts.push({ geometry, material: Array.isArray(m.material) ? m.material[0]! : m.material });
  });
  const c = box.getCenter(new three.Vector3());
  for (const p of parts) p.geometry.translate(-c.x, -box.min.y, -c.z); // centred, with its base on the ground
  const tall = box.max.y - box.min.y;
  return { parts, scale: tall > 1e-6 ? height / tall : 1 };
}

export async function loadProp(three: Three, url: string, height: number): Promise<PropTemplate | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const t = await parseProp(three, await res.arrayBuffer(), height);
    return t.parts.length ? t : null;
  } catch {
    return null;
  }
}

/** Draws copies of a prop at some places: one instanced mesh for each part of the model. */
export function propInstances(three: Three, t: PropTemplate, at: Pick<PropPlacement, 'x' | 'z' | 'yaw'>[]): T.InstancedMesh[] {
  if (!at.length) return [];
  const m = new three.Matrix4();
  const q = new three.Quaternion();
  const up = new three.Vector3(0, 1, 0);
  const pos = new three.Vector3();
  const sc = new three.Vector3(t.scale, t.scale, t.scale);
  return t.parts.map((part) => {
    const mesh = new three.InstancedMesh(part.geometry, part.material, at.length);
    at.forEach((p, i) => {
      q.setFromAxisAngle(up, p.yaw);
      pos.set(p.x, 0, p.z);
      m.compose(pos, q, sc);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  });
}
