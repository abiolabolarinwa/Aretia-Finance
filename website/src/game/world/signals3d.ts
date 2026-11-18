/**
 * Traffic light posts. Each road leading into a signalised junction gets a post on the right-hand side of the approach, just past the
 * crosswalk, with a signal head facing the traffic that arrives. Posts, heads and lamps are drawn as instances of one shape each, and
 * the lamps are recoloured as the lights change. Where posts stand and which way they face is worked out by plain code (and tested);
 * only the last part touches the graphics.
 */
import type * as T from 'three';
import { armGroup, crosswalkDistance, lightFor, roomForCrosswalk, type Junction, type Light } from './junctions.js';

type Three = typeof import('three');

export interface Head {
  x: number;
  z: number;
  /** Turn about the vertical (radians) that makes the head's front face the traffic arriving along this road. */
  yaw: number;
  group: 0 | 1;
  /** The junction's own beat, in seconds. */
  offset: number;
}

export const POLE_HEIGHT = 5.6;
export const HEAD_Y = 4.95;
/** The height of each lamp above the middle of the head: red on top, then amber, then green. */
export const LAMP_DY = [0.36, 0, -0.36] as const;

/** One head for each road into the junction that is wide and long enough for a crosswalk. */
export function headsFor(j: Junction): Head[] {
  const out: Head[] = [];
  for (const arm of j.arms) {
    if (arm.width < 5 || !roomForCrosswalk(j, arm)) continue;
    const along = crosswalkDistance(j) + 1.8; // a little past the crosswalk, on the side traffic comes from
    const lateral = arm.width / 2 + 1.1; // on the right as they drive towards the junction
    const rx = arm.dz;
    const rz = -arm.dx;
    out.push({
      x: j.x + arm.dx * along + rx * lateral,
      z: j.z + arm.dz * along + rz * lateral,
      yaw: Math.atan2(arm.dx, arm.dz),
      group: armGroup(j, arm.dx, arm.dz),
      offset: j.offset,
    });
  }
  return out;
}

export const LAMP_COLOUR: Record<Light, [string, string, string]> = {
  // [red lamp, amber lamp, green lamp] while the light is this: the lit one bright, the others dark.
  red: ['#ff2f2f', '#2b2a22', '#1d2a22'],
  amber: ['#3a1a1a', '#ffb52e', '#1d2a22'],
  green: ['#3a1a1a', '#2b2a22', '#34ff7a'],
};

export interface SignalShapes {
  pole: T.BufferGeometry;
  head: T.BufferGeometry;
  /** A flat disc facing +z. */
  lamp: T.BufferGeometry;
  poleMat: T.Material;
  headMat: T.Material;
  lampMat: T.Material;
}

export function makeSignalShapes(three: Three): SignalShapes {
  const pole = new three.CylinderGeometry(0.07, 0.09, POLE_HEIGHT, 8);
  pole.translate(0, POLE_HEIGHT / 2, 0);
  const head = new three.BoxGeometry(0.42, 1.3, 0.32);
  const lamp = new three.CylinderGeometry(0.15, 0.15, 0.06, 14);
  lamp.rotateX(Math.PI / 2); // the flat face points along +z
  return {
    pole,
    head,
    lamp,
    poleMat: new three.MeshLambertMaterial({ color: '#4a4d52' }),
    headMat: new three.MeshLambertMaterial({ color: '#1d1f23' }),
    // Lit by their own colour rather than by the sun, so a green lamp is green at noon and glows at night.
    lampMat: new three.MeshBasicMaterial({ color: '#ffffff' }),
  };
}

export interface SignalSet {
  objects: T.Object3D[];
  /** Sets every lamp for the time (seconds); only lamps that need to change are touched. */
  update(seconds: number): void;
  heads: Head[];
}

/** Draws the posts, heads and lamps for some heads, as three instanced meshes (plus the poles). */
export function buildSignalSet(three: Three, heads: Head[], shapes: SignalShapes): SignalSet {
  const n = heads.length;
  const poles = new three.InstancedMesh(shapes.pole, shapes.poleMat, n);
  const boxes = new three.InstancedMesh(shapes.head, shapes.headMat, n);
  const lamps = new three.InstancedMesh(shapes.lamp, shapes.lampMat, n * 3);
  const m = new three.Matrix4();
  const rot = new three.Matrix4();
  const colour = new three.Color();
  heads.forEach((h, i) => {
    m.makeRotationY(h.yaw);
    m.setPosition(h.x, 0, h.z);
    poles.setMatrixAt(i, m);
    // The head sits on the post, turned to face the traffic, and a little towards it.
    rot.makeRotationY(h.yaw);
    m.copy(rot).setPosition(h.x + Math.sin(h.yaw) * 0.2, HEAD_Y, h.z + Math.cos(h.yaw) * 0.2);
    boxes.setMatrixAt(i, m);
    LAMP_DY.forEach((dy, k) => {
      m.copy(rot).setPosition(h.x + Math.sin(h.yaw) * 0.37, HEAD_Y + dy, h.z + Math.cos(h.yaw) * 0.37);
      lamps.setMatrixAt(i * 3 + k, m);
      lamps.setColorAt(i * 3 + k, colour.set(LAMP_COLOUR.red[k]!));
    });
  });
  for (const o of [poles, boxes, lamps]) {
    o.instanceMatrix.needsUpdate = true;
    o.frustumCulled = false;
    o.castShadow = o !== lamps;
  }
  const shown: (Light | null)[] = heads.map(() => null);
  return {
    objects: [poles, boxes, lamps],
    heads,
    update(seconds) {
      let changed = false;
      heads.forEach((h, i) => {
        const light = lightFor(h.group, seconds, h.offset);
        if (shown[i] === light) return;
        shown[i] = light;
        changed = true;
        LAMP_COLOUR[light].forEach((c, k) => lamps.setColorAt(i * 3 + k, colour.set(c)));
      });
      if (changed && lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
    },
  };
}
