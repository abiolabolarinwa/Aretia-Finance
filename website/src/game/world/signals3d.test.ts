import { describe, expect, it } from 'vitest';
import * as three from 'three';
import { AMBER_S, GREEN_S, crosswalkDistance, junctionsOf } from './junctions.js';
import { HEAD_Y, LAMP_COLOUR, LAMP_DY, buildSignalSet, headsFor, makeSignalShapes } from './signals3d.js';
import type { Road } from './worldData.js';

const road = (pts: [number, number][], width = 10, cls = 'primary'): Road => ({ pts, width, cls });
const cross = (): Road[] => [road([[-100, 0], [0, 0]]), road([[0, 0], [100, 0]]), road([[0, -100], [0, 0]]), road([[0, 0], [0, 100]])];
const junction = () => junctionsOf(cross())[0]!;

describe('where the traffic light posts stand', () => {
  it('gives each road into the junction a post, on the right of the approaching traffic, beside the road and past the crosswalk', () => {
    const j = junction();
    const heads = headsFor(j);
    expect(heads).toHaveLength(4);
    for (const arm of j.arms) {
      // Traffic arrives along this arm heading into the junction; find the head belonging to it by direction.
      const h = heads.find((x) => Math.abs(Math.sin(x.yaw) - arm.dx) < 1e-6 && Math.abs(Math.cos(x.yaw) - arm.dz) < 1e-6)!;
      expect(h).toBeDefined();
      const rel = [h.x - j.x, h.z - j.z];
      const along = rel[0]! * arm.dx + rel[1]! * arm.dz;
      const side = rel[0]! * arm.dz + rel[1]! * -arm.dx; // positive to the right of arriving traffic
      expect(along).toBeGreaterThan(crosswalkDistance(j)); // beyond the crosswalk, on the arriving side
      expect(side).toBeGreaterThan(arm.width / 2); // off the carriageway
      expect(side).toBeLessThan(arm.width / 2 + 2); // but close beside it
    }
  });

  it('makes the roads along one axis one group and the roads across it the other, so they take turns', () => {
    const heads = headsFor(junction());
    expect(heads.filter((h) => h.group === 0)).toHaveLength(2);
    expect(heads.filter((h) => h.group === 1)).toHaveLength(2);
    // The two heads of a group face opposite ways.
    const g0 = heads.filter((h) => h.group === 0);
    expect(Math.round(Math.sin(g0[0]!.yaw) + Math.sin(g0[1]!.yaw))).toBe(0);
    expect(Math.round(Math.cos(g0[0]!.yaw) + Math.cos(g0[1]!.yaw))).toBe(0);
  });

  it('skips a road that is too short or too narrow for a crosswalk', () => {
    const j = junctionsOf([road([[-100, 0], [0, 0]]), road([[0, 0], [100, 0]]), road([[0, -100], [0, 0]]), road([[0, 0], [0, 9]])])[0]!;
    expect(j).toBeDefined();
    expect(headsFor(j)).toHaveLength(3); // the 9 m stub has no room
  });
});

describe('the drawn posts and lamps', () => {
  const colourOf = (lamps: three.InstancedMesh, i: number): three.Color => {
    const c = new three.Color();
    lamps.getColorAt(i, c);
    return c;
  };

  it('draws a post, a head and three lamps for each head', () => {
    const shapes = makeSignalShapes(three);
    const set = buildSignalSet(three, headsFor(junction()), shapes);
    const [poles, boxes, lamps] = set.objects as three.InstancedMesh[];
    expect(poles!.count).toBe(4);
    expect(boxes!.count).toBe(4);
    expect(lamps!.count).toBe(12);
    // The first lamp of the first head is up at head height, in front of the head.
    const m = new three.Matrix4();
    lamps!.getMatrixAt(0, m);
    const p = new three.Vector3().setFromMatrixPosition(m);
    expect(p.y).toBeCloseTo(HEAD_Y + LAMP_DY[0]);
    lamps!.getMatrixAt(2, m);
    expect(new three.Vector3().setFromMatrixPosition(m).y).toBeCloseTo(HEAD_Y + LAMP_DY[2]);
  });

  it('shows green to one group and red to the other, then amber, then swaps', () => {
    const shapes = makeSignalShapes(three);
    const heads = headsFor(junction()).map((h) => ({ ...h, offset: 0 }));
    const set = buildSignalSet(three, heads, shapes);
    const lamps = set.objects[2] as three.InstancedMesh;
    const lit = (head: number, lamp: number): boolean => {
      const c = colourOf(lamps, head * 3 + lamp);
      return Math.max(c.r, c.g, c.b) > 0.45; // bright (in linear light) rather than dark
    };
    const g0 = heads.findIndex((h) => h.group === 0);
    const g1 = heads.findIndex((h) => h.group === 1);
    set.update(1); // group 0 is green, group 1 red
    expect([lit(g0, 0), lit(g0, 1), lit(g0, 2)]).toEqual([false, false, true]);
    expect([lit(g1, 0), lit(g1, 1), lit(g1, 2)]).toEqual([true, false, false]);
    set.update(GREEN_S + AMBER_S / 2); // group 0 amber
    expect([lit(g0, 0), lit(g0, 1), lit(g0, 2)]).toEqual([false, true, false]);
    expect(lit(g1, 0)).toBe(true);
    set.update(GREEN_S + AMBER_S + 4 + 1); // everyone red a little, then group 1's green: by now (about 20 s in) group 1 is green
    set.update(19);
    expect([lit(g0, 0), lit(g0, 1), lit(g0, 2)]).toEqual([true, false, false]);
    expect([lit(g1, 0), lit(g1, 1), lit(g1, 2)]).toEqual([false, false, true]);
  });

  it('only recolours lamps when a light changes', () => {
    const shapes = makeSignalShapes(three);
    const set = buildSignalSet(three, headsFor(junction()), shapes);
    const lamps = set.objects[2] as three.InstancedMesh;
    set.update(1);
    const version = lamps.instanceColor!.version;
    set.update(2); // still the same lights
    expect(lamps.instanceColor!.version).toBe(version);
    set.update(GREEN_S + 0.5); // group 0 turns amber
    expect(lamps.instanceColor!.version).toBeGreaterThan(version);
    // The colours used are the ones declared for each light.
    expect(LAMP_COLOUR.green[2]).toBe('#34ff7a');
  });
});
