// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as three from 'three';
import { PROP_SPECS, kindFor, propsFor, type PropKind } from './roamProps.js';
import { parseProp, propInstances } from './propModels.js';
import { crosswalkDistance, junctionsOf } from './junctions.js';
import type { Road, TileWorld } from './worldData.js';

const world = (roads: Road[]): TileWorld => ({ buildings: [], roads, named: [], water: [], waterLines: [], areas: [] });
const street = (): Road[] => [{ pts: [[0, 100], [200, 100]], width: 8, cls: 'secondary' }];
const never = (): boolean => false;
const dist = (x: number, z: number, r: Road): number => {
  const a = r.pts[0]!;
  const b = r.pts[1]!;
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
};

describe('where street furniture stands', () => {
  it('puts things beside the street, on the pavement and never on the road, inside the square, the same every time', () => {
    const w = world(street());
    const a = propsFor('0,0', w, never);
    const b = propsFor('0,0', w, never);
    expect(a.length).toBeGreaterThan(2);
    expect(a).toEqual(b);
    for (const p of a) {
      const d = dist(p.x, p.z, street()[0]!);
      expect(d, p.kind).toBeGreaterThan(4); // clear of the 8 m carriageway
      expect(d, p.kind).toBeLessThan(8); // but close beside it
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(200);
      expect(p.z).toBeGreaterThanOrEqual(0);
      expect(p.z).toBeLessThan(200);
      expect(Object.keys(PROP_SPECS)).toContain(p.kind);
    }
  });

  it('faces each thing towards the street', () => {
    const w = world(street());
    for (const p of propsFor('0,0', w, never)) {
      // Front is +z turned by yaw: (sin yaw, cos yaw). It should point from the prop towards the street's middle (z = 100).
      const fz = Math.cos(p.yaw);
      const toStreet = Math.sign(100 - p.z);
      expect(Math.sign(fz), p.kind).toBe(toStreet);
      expect(Math.abs(Math.sin(p.yaw)), p.kind).toBeLessThan(0.05);
    }
  });

  it('keeps off buildings and water, away from junctions, and within its cap', () => {
    const w = world(street());
    expect(propsFor('0,0', w, () => true)).toHaveLength(0);
    expect(propsFor('0,0', w, never, 3).length).toBeLessThanOrEqual(3);
    // A crossing at (100,100): nothing within the crosswalk zone of it.
    const roads: Road[] = [
      { pts: [[0, 100], [100, 100]], width: 10, cls: 'primary' },
      { pts: [[100, 100], [200, 100]], width: 10, cls: 'primary' },
      { pts: [[100, 0], [100, 100]], width: 10, cls: 'primary' },
      { pts: [[100, 100], [100, 200]], width: 10, cls: 'primary' },
    ];
    const j = junctionsOf(roads)[0]!;
    const quiet = crosswalkDistance(j) + 8;
    for (const p of propsFor('0,0', world(roads), never)) expect(Math.hypot(p.x - 100, p.z - 100), p.kind).toBeGreaterThanOrEqual(quiet - 12); // allowing for the offset from the street's middle
  });

  it('puts dumpsters (only) beside back lanes, and nothing on footpaths or tracks', () => {
    const lane = propsFor('0,0', world([{ pts: [[0, 100], [200, 100]], width: 4, cls: 'service' }]), never);
    expect(lane.length).toBeGreaterThan(0);
    for (const p of lane) expect(p.kind).toBe('dumpster');
    expect(propsFor('0,0', world([{ pts: [[0, 100], [200, 100]], width: 2.4, cls: 'path' }]), never)).toHaveLength(0);
    expect(propsFor('0,0', world([{ pts: [[0, 100], [200, 100]], width: 3, cls: 'track' }]), never)).toHaveLength(0);
  });

  it('chooses kinds sensibly: benches and bins are the common ones, market stands only on smaller shopping streets', () => {
    const kinds = new Set<PropKind>();
    for (let r = 0; r < 0.25; r += 0.005) for (const h of [0.2, 0.8]) {
      const k = kindFor(r, h, 8, 'tertiary');
      if (k) kinds.add(k);
    }
    expect([...kinds].sort()).toEqual(['bench', 'bin-large', 'bin-small', 'hydrant', 'mailbox', 'market-stand', 'sign']);
    expect(kindFor(0.18, 0.5, 10, 'primary')).toBeNull(); // no market stand on a main road
    expect(kindFor(0.18, 0.5, 4, 'minor')).toBeNull(); // nor on a very narrow street
    expect(kindFor(0.5, 0.5, 8, 'tertiary')).toBeNull(); // most spots get nothing
  });
});

describe('prop models (real files)', () => {
  const load = async (file: string, height: number) => {
    const b = readFileSync(new URL(`../../../public/game/models/props/${file}.glb`, import.meta.url));
    return parseProp(three, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, height);
  };
  // The models that have no painted-on picture can be read without a browser.
  const PLAIN: PropKind[] = ['bench', 'bin-small', 'bin-large', 'dumpster', 'market-stand', 'sign'];

  for (const kind of PLAIN) {
    it(`${kind}: stands on the ground, centred, at the wanted height`, async () => {
      const spec = PROP_SPECS[kind];
      const t = await load(spec.file, spec.height);
      expect(t.parts.length).toBeGreaterThan(0);
      const box = new three.Box3();
      for (const p of t.parts) {
        p.geometry.computeBoundingBox();
        box.union(p.geometry.boundingBox!);
      }
      expect(box.min.y).toBeCloseTo(0, 3); // base on the ground
      expect((box.min.x + box.max.x) / 2).toBeCloseTo(0, 3); // centred
      expect((box.min.z + box.max.z) / 2).toBeCloseTo(0, 3);
      expect((box.max.y - box.min.y) * t.scale).toBeCloseTo(spec.height, 2); // scaled to the height
    });
  }

  it('draws many copies as one instanced mesh per part, in the right places and turned the right way', async () => {
    const t = await load('bench', 0.9);
    const at = [{ x: 10, z: 20, yaw: 0 }, { x: -5, z: 7, yaw: Math.PI / 2 }, { x: 0, z: 0, yaw: Math.PI }];
    const meshes = propInstances(three, t, at);
    expect(meshes).toHaveLength(t.parts.length);
    for (const m of meshes) {
      expect(m.count).toBe(3);
      expect(m.geometry).toBe(t.parts[meshes.indexOf(m)]!.geometry); // the shape is shared, not copied
    }
    const mat = new three.Matrix4();
    meshes[0]!.getMatrixAt(1, mat);
    const p = new three.Vector3();
    const q = new three.Quaternion();
    const s = new three.Vector3();
    mat.decompose(p, q, s);
    expect([p.x, p.y, p.z]).toEqual([-5, 0, 7]);
    expect(s.x).toBeCloseTo(t.scale);
    // A quarter turn about the vertical: the model's front (+z) now points along +x.
    const front = new three.Vector3(0, 0, 1).applyQuaternion(q);
    expect(front.x).toBeCloseTo(1);
    expect(propInstances(three, t, [])).toEqual([]);
  });
});
