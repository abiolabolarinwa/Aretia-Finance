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
  dispose(): void;
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
  g.add(mesh(extrude(three, BODY[shape], WIDTH, 0.05), paint));
  g.add(mesh(extrude(three, GLASS[shape], WIDTH + 0.02, 0.03), glass));
  const wheelR = kind === 'suv' ? 0.42 : 0.36;
  const front = kind === 'suv' ? -1.45 : -1.4;
  const back = kind === 'suv' ? 1.45 : 1.4;
  for (const [x, z] of [[-0.8, front], [0.8, front], [-0.8, back], [0.8, back]] as const) {
    const tyre = mesh(new three.CylinderGeometry(wheelR, wheelR, 0.28, 20), rubber);
    tyre.rotation.z = Math.PI / 2;
    tyre.position.set(x, wheelR, z);
    const disc = mesh(new three.CylinderGeometry(wheelR * 0.62, wheelR * 0.62, 0.3, 14), rim);
    disc.rotation.z = Math.PI / 2;
    disc.position.set(x, wheelR, z);
    g.add(tyre, disc);
  }
  const frontZ = -2.3;
  const rearZ = 2.3;
  for (const x of [-0.62, 0.62]) {
    const h = mesh(new three.BoxGeometry(0.4, 0.14, 0.06), head);
    h.position.set(x, kind === 'suv' ? 0.92 : 0.78, frontZ);
    const t = mesh(new three.BoxGeometry(0.42, 0.13, 0.06), tail);
    t.position.set(x, kind === 'suv' ? 1.0 : 0.82, rearZ);
    g.add(h, t);
  }
  const bumperF = mesh(new three.BoxGeometry(1.8, 0.2, 0.18), trim);
  bumperF.position.set(0, 0.42, frontZ + 0.02);
  const bumperR = mesh(new three.BoxGeometry(1.8, 0.2, 0.18), trim);
  bumperR.position.set(0, 0.42, rearZ - 0.02);
  g.add(bumperF, bumperR);
  if (kind === 'taxi') {
    const sign = mesh(new three.BoxGeometry(0.55, 0.16, 0.22), new three.MeshStandardMaterial({ color: '#fff6c8', emissive: '#ffe58a', emissiveIntensity: 0.9 }));
    sign.position.set(0, 1.55, 0.2);
    g.add(sign);
  }
  return {
    group: g,
    dispose() {
      for (const x of geos) x.dispose();
      for (const m of mats) m.dispose();
    },
  };
}

export const TRAFFIC_COLOURS = ['#d8d8dc', '#1c1c20', '#8c1d1d', '#27456e', '#5c6670', '#e9e4d6', '#2f5a3c', '#b0b4ba'];
