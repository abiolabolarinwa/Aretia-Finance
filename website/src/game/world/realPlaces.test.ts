import { describe, expect, it } from 'vitest';
import { SIGNAL_REACH_M, crosswalksFromFeatures, lampsFromFeatures, mergeProps, nearestStreet, polesFromFeatures, signalsFromFeatures } from './realPlaces.js';
import { paintGround } from './roamDetail.js';
import { junctionsOf } from './junctions.js';
import type { MapFeature } from './mapillaryFeatures.js';
import type { PropPlacement } from './roamProps.js';
import type { Road, TileWorld } from './worldData.js';

const never = (): boolean => false;
const f = (kind: MapFeature['kind'], x: number, z: number): MapFeature => ({ kind, x, z });
const world = (roads: Road[]): TileWorld => ({ buildings: [], roads, named: [], water: [], waterLines: [], areas: [] });
const eastWest = (): Road[] => [{ pts: [[0, 100], [200, 100]], width: 8, cls: 'secondary' }];

describe('finding the street next to a point', () => {
  it('finds the nearest drivable street, its direction and width, and ignores paths and far streets', () => {
    const w = world([...eastWest(), { pts: [[0, 50], [200, 50]], width: 2.4, cls: 'path' }]);
    const s = nearestStreet(w, 80, 90)!;
    expect(s.px).toBeCloseTo(80);
    expect(s.pz).toBeCloseTo(100);
    expect(s.d).toBeCloseTo(10);
    expect([s.tx, s.tz]).toEqual([1, 0]);
    expect(s.width).toBe(8);
    expect(nearestStreet(w, 80, 52)).toBeNull(); // the path is not a street
    expect(nearestStreet(w, 80, 400, 30)).toBeNull(); // too far
  });
});

describe('real lamps and poles', () => {
  it('uses the real street lights when there are at least two, drops any inside a building, and otherwise lets the rule decide', () => {
    expect(lampsFromFeatures([f('street-light', 10, 10)], never)).toBeNull(); // one is not enough to go on
    expect(lampsFromFeatures([], never)).toBeNull();
    const real = lampsFromFeatures([f('street-light', 10, 10), f('street-light', 60, 20), f('bench', 5, 5)], never)!;
    expect(real.map((p) => [p.x, p.z])).toEqual([[10, 10], [60, 20]]);
    const open = lampsFromFeatures([f('street-light', 10, 10), f('street-light', 60, 20)], (x) => x < 20)!;
    expect(open.map((p) => p.x)).toEqual([60]);
  });

  it('puts utility poles only where the data says, turned square to the street, within a cap', () => {
    expect(polesFromFeatures([f('street-light', 1, 1)], never)).toEqual([]);
    const poles = polesFromFeatures([f('utility-pole', 5, 5), f('utility-pole', 30, 40), f('utility-pole', 99, 9)], never);
    expect(poles).toHaveLength(3);
    for (const p of poles) expect([0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]).toContain(p.yaw);
    expect(polesFromFeatures([f('utility-pole', 5, 5), f('utility-pole', 30, 40)], (x) => x < 10)).toHaveLength(1);
    const many = Array.from({ length: 200 }, (_, i) => f('utility-pole', i, i));
    expect(polesFromFeatures(many, never, 50)).toHaveLength(50);
  });
});

describe('real street furniture', () => {
  const rule: PropPlacement[] = [
    { kind: 'bench', x: 1, z: 1, yaw: 0 },
    { kind: 'bin-small', x: 2, z: 2, yaw: 0 },
    { kind: 'bin-large', x: 3, z: 3, yaw: 0 },
    { kind: 'hydrant', x: 4, z: 4, yaw: 0 },
    { kind: 'mailbox', x: 5, z: 5, yaw: 0 },
    { kind: 'market-stand', x: 6, z: 6, yaw: 0 },
  ];

  it('keeps the rule-based furniture when there is no real data', () => {
    expect(mergeProps(rule, [], world(eastWest()), never)).toEqual(rule);
    expect(mergeProps(rule, [f('street-light', 1, 1), f('traffic-light', 2, 2)], world(eastWest()), never)).toEqual(rule);
  });

  it('replaces only the kinds that have real data, keeping the others', () => {
    const out = mergeProps(rule, [f('bench', 50, 92), f('bench', 120, 108)], world(eastWest()), never);
    expect(out.filter((p) => p.kind === 'bench').map((p) => [p.x, p.z])).toEqual([[50, 92], [120, 108]]); // real ones, not the rule's
    for (const kind of ['bin-small', 'bin-large', 'hydrant', 'mailbox', 'market-stand'] as const) expect(out.some((p) => p.kind === kind), kind).toBe(true);
    // Real bins replace both sizes of rule-based bin.
    const bins = mergeProps(rule, [f('bin', 70, 93)], world(eastWest()), never);
    expect(bins.filter((p) => p.kind === 'bin-small' || p.kind === 'bin-large')).toHaveLength(1);
    expect(bins.find((p) => p.kind === 'bin-small' || p.kind === 'bin-large')!.x).toBe(70);
    // Signs and hydrants too; mailboxes and market stands are never replaced.
    const signs = mergeProps(rule, [f('sign', 10, 10), f('hydrant', 20, 20)], world(eastWest()), never);
    expect(signs.filter((p) => p.kind === 'hydrant').map((p) => p.x)).toEqual([20]);
    expect(signs.filter((p) => p.kind === 'sign')).toHaveLength(1);
    expect(signs.some((p) => p.kind === 'mailbox')).toBe(true);
  });

  it('turns real furniture to face the street, and skips any that is inside a building', () => {
    const out = mergeProps([], [f('bench', 50, 92), f('bench', 50, 108)], world(eastWest()), never);
    const north = out.find((p) => p.z === 92)!; // north of the street: the street is to its south (+z)
    const south = out.find((p) => p.z === 108)!;
    expect(Math.cos(north.yaw)).toBeGreaterThan(0.99);
    expect(Math.cos(south.yaw)).toBeLessThan(-0.99);
    expect(mergeProps([], [f('bench', 50, 92)], world(eastWest()), () => true)).toEqual([]);
    // With nothing blocked from replacing, a blocked real bench does not wipe out the rule's benches.
    expect(mergeProps(rule, [f('bench', 50, 92)], world(eastWest()), () => true)).toEqual(rule);
  });
});

describe('real crosswalks and traffic lights', () => {
  it('places a crosswalk on the street beside where one was seen, once, and skips ones off any street or on a narrow lane', () => {
    const w = world(eastWest());
    const cws = crosswalksFromFeatures([f('crosswalk', 80, 96), f('crosswalk', 82, 97), f('crosswalk', 150, 104), f('crosswalk', 80, 300), f('bench', 1, 1)], w);
    expect(cws).toHaveLength(2); // the first two are one crossing
    expect(cws[0]!.x).toBeCloseTo(80, 0);
    expect(cws[0]!.z).toBeCloseTo(100);
    expect([cws[0]!.tx, cws[0]!.tz]).toEqual([1, 0]);
    expect(cws[0]!.width).toBe(8);
    expect(crosswalksFromFeatures([f('crosswalk', 80, 100)], world([{ pts: [[0, 100], [200, 100]], width: 4, cls: 'minor' }]))).toEqual([]);
  });

  it('paints a real crosswalk onto the ground, but not on top of a junction\'s own', () => {
    const calls = (extra: { x: number; z: number; tx: number; tz: number; width: number }[], roads: Road[]): number => {
      let moves = 0;
      const state: Record<string, unknown> = {};
      const ctx = new Proxy(state, {
        get(t, k: string) {
          if (k in t) return t[k];
          return () => {
            if (k === 'moveTo') moves++;
          };
        },
        set(t, k: string, v) {
          t[k] = v;
          return true;
        },
      }) as unknown as CanvasRenderingContext2D;
      paintGround(ctx, 512, '0,0', world(roads), undefined, { crosswalks: extra });
      return moves;
    };
    const cw = [{ x: 80, z: 100, tx: 1, tz: 0, width: 8 }];
    const without = calls([], eastWest());
    const withOne = calls(cw, eastWest());
    expect(withOne - without).toBe(7); // seven stripes across an 8 m street
    // The same crossing beside a signalised junction is not painted twice.
    const cross: Road[] = [
      { pts: [[0, 100], [100, 100]], width: 10, cls: 'primary' },
      { pts: [[100, 100], [200, 100]], width: 10, cls: 'primary' },
      { pts: [[100, 0], [100, 100]], width: 10, cls: 'primary' },
      { pts: [[100, 100], [100, 200]], width: 10, cls: 'primary' },
    ];
    expect(calls([{ x: 90, z: 100, tx: 1, tz: 0, width: 10 }], cross)).toBe(calls([], cross));
    expect(calls([{ x: 900, z: 900, tx: 1, tz: 0, width: 10 }], eastWest())).toBe(without); // outside the square
  });

  it('gives signals to a junction with a real traffic light near it, and only adds, never removes', () => {
    const minor: Road[] = [
      { pts: [[-60, 0], [0, 0]], width: 6, cls: 'minor' },
      { pts: [[0, 0], [60, 0]], width: 6, cls: 'minor' },
      { pts: [[0, 0], [0, 60]], width: 6, cls: 'minor' },
    ];
    const js = junctionsOf(minor);
    expect(js[0]!.signalised).toBe(false); // small streets: the rule says no
    expect(signalsFromFeatures(js, [f('traffic-light', 400, 400)])).toEqual([]); // a light far away changes nothing
    expect(js[0]!.signalised).toBe(false);
    expect(signalsFromFeatures(js, [])).toEqual([]);
    const added = signalsFromFeatures(js, [f('traffic-light', 8, 6)]);
    expect(added).toHaveLength(1);
    expect(js[0]!.signalised).toBe(true);
    expect(Math.hypot(8, 6)).toBeLessThanOrEqual(SIGNAL_REACH_M);
    expect(signalsFromFeatures(js, [f('traffic-light', 8, 6)])).toEqual([]); // already done: not added twice
    // A junction the rule already signalised stays signalised even with no real light.
    const main = junctionsOf([{ pts: [[-60, 0], [0, 0]], width: 10, cls: 'primary' }, { pts: [[0, 0], [60, 0]], width: 10, cls: 'primary' }, { pts: [[0, 0], [0, 60]], width: 6, cls: 'minor' }]);
    expect(main[0]!.signalised).toBe(true);
    signalsFromFeatures(main, [f('street-light', 1, 1)]);
    expect(main[0]!.signalised).toBe(true);
  });
});
