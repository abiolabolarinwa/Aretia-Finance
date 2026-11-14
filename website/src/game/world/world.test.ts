import { describe, expect, it } from 'vitest';
import { decodeTile, type VFeature, type VLayer, type Pt } from './mvt.js';
import { buildTileWorld, buildingHeight, fromLocal, tileOf, tilePoint, tileUrl, toLocal, ROAD_WIDTH } from './worldData.js';
import { Colliders, TileColliders, insidePolygon, nearestOnSegment } from './colliders.js';
import { BOAT, CAR, RUN_SPEED, WALK_SPEED, stepFoot, stepVehicle, type Foot, type Hazards, type Vehicle } from './physics.js';
import { allowedMetres, isRoamMode, roamAllowed, MAX_GAP_MS, MAX_SPEED_MS, SLACK_M } from '../roamRules.js';

// ---------------------------------------------------------------- a tiny tile writer, so the decoder is tested on real protobuf bytes
const varint = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  while (v >= 128) {
    out.push((v % 128) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
};
const zig = (n: number): number => (n < 0 ? -n * 2 - 1 : n * 2);
const field = (no: number, wire: number): number[] => varint(no * 8 + wire);
const lenField = (no: number, bytes: number[]): number[] => [...field(no, 2), ...varint(bytes.length), ...bytes];
const str = (no: number, s: string): number[] => lenField(no, [...new TextEncoder().encode(s)]);
// Drawing commands are relative to where the pen last was, across rings too, so rings are written one after another with a cursor.
const rings = (all: Pt[][]): number[] => {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  for (const pts of all) {
    out.push((1 << 3) | 1, ...varint(zig(pts[0]![0] - cx)), ...varint(zig(pts[0]![1] - cy)), ((pts.length - 1) << 3) | 2);
    for (let i = 1; i < pts.length; i++) out.push(...varint(zig(pts[i]![0] - pts[i - 1]![0])), ...varint(zig(pts[i]![1] - pts[i - 1]![1])));
    cx = pts[pts.length - 1]![0];
    cy = pts[pts.length - 1]![1];
    out.push((1 << 3) | 7);
  }
  return out;
};
const feature = (tags: number[], type: number, geometry: number[]): number[] => lenField(2, [...lenField(2, tags.flatMap(varint)), ...field(3, 0), ...varint(type), ...lenField(4, geometry)]);

function tile(): Uint8Array {
  const square = (x: number, y: number, s: number, hole: boolean): Pt[] => (hole ? [[x, y], [x + s, y], [x + s, y + s], [x, y + s]] : [[x, y], [x, y + s], [x + s, y + s], [x + s, y]]);
  const buildings = feature([0, 0, 1, 1], 3, rings([square(100, 100, 400, false), square(200, 200, 100, true), square(1000, 1000, 200, false)]));
  const road = feature([0, 0], 2, [(1 << 3) | 1, ...varint(zig(0)), ...varint(zig(2000)), (2 << 3) | 2, ...varint(zig(4000)), ...varint(zig(0)), ...varint(zig(0)), ...varint(zig(100))]);
  const poi = feature([], 1, [(1 << 3) | 1, ...varint(zig(50)), ...varint(zig(60))]);
  const layer1 = [...str(1, 'building'), ...buildings, ...str(3, 'render_height'), ...str(3, 'name'), ...lenField(4, [...field(4, 0), ...varint(30)]), ...lenField(4, [...str(1, 'Tower')]), ...field(5, 0), ...varint(4096), ...field(15, 0), 2];
  const layer2 = [...str(1, 'transportation'), ...road, ...str(3, 'class'), ...lenField(4, str(1, 'primary')), ...field(5, 0), ...varint(4096)];
  const layer3 = [...str(1, 'poi'), ...poi, ...field(5, 0), ...varint(4096)];
  return Uint8Array.from([...lenField(3, layer1), ...lenField(3, layer2), ...field(9, 0), 5, ...lenField(3, layer3)]);
}

describe('the map tile decoder', () => {
  it('reads layers, properties, lines, points and polygons with their courtyards from real protobuf bytes', () => {
    const layers = decodeTile(tile());
    expect(layers.map((l) => l.name)).toEqual(['building', 'transportation', 'poi']);
    const b = layers[0]!;
    expect(b.extent).toBe(4096);
    expect(b.features).toHaveLength(1);
    expect(b.features[0]!.props).toEqual({ render_height: 30, name: 'Tower' });
    // Two polygons: the first has a courtyard (the ring that winds the other way), the second stands alone.
    const polys = b.features[0]!.polygons;
    expect(polys).toHaveLength(2);
    expect(polys[0]).toHaveLength(2);
    expect(polys[1]).toHaveLength(1);
    expect(polys[0]![0]![0]).toEqual([100, 100]);
    const road = layers[1]!.features[0]!;
    expect(road.kind).toBe('line');
    expect(road.lines).toEqual([[[0, 2000], [4000, 2000], [4000, 2100]]]);
    expect(road.props.class).toBe('primary');
    expect(layers[2]!.features[0]!.points).toEqual([[50, 60]]);
  });

  it('refuses a tile that is cut short, and skips fields it does not know', () => {
    const bytes = tile();
    expect(() => decodeTile(bytes.subarray(0, 40))).toThrow(/Truncated|Bad|Unknown/);
    expect(decodeTile(new Uint8Array())).toEqual([]);
  });
});

// ---------------------------------------------------------------- the world built from a tile
const origin = { lng: 2.3522, lat: 48.8566 };
const feat = (over: Partial<VFeature>): VFeature => ({ props: {}, kind: 'polygon', points: [], lines: [], polygons: [], ...over });
const sq = (x: number, y: number, s: number): Pt[] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];

describe('the real-city world data', () => {
  it('converts between tiles, longitude and latitude, and metres around the starting point', () => {
    const t = tileOf(origin.lng, origin.lat);
    expect(t).toEqual({ x: 8299, y: 5636 });
    const [w, n] = tilePoint(14, t.x, t.y, 0, 0, 4096);
    const [e, s] = tilePoint(14, t.x, t.y, 4096, 4096, 4096);
    expect(w).toBeLessThan(origin.lng);
    expect(e).toBeGreaterThan(origin.lng);
    expect(n).toBeGreaterThan(origin.lat);
    expect(s).toBeLessThan(origin.lat);
    expect(toLocal(origin, origin.lng, origin.lat)).toEqual([0, -0]);
    const [x, z] = toLocal(origin, origin.lng + 0.01, origin.lat + 0.01);
    expect(x).toBeGreaterThan(700);
    expect(x).toBeLessThan(760);
    expect(z).toBeCloseTo(-1105.4, 1); // north is negative z
    const back = fromLocal(origin, x, z);
    expect(back[0]).toBeCloseTo(origin.lng + 0.01, 8);
    expect(back[1]).toBeCloseTo(origin.lat + 0.01, 8);
    expect(tileUrl('https://t.example/p/{z}/{x}/{y}.pbf', 14, 8299, 5636)).toBe('https://t.example/p/14/8299/5636.pbf');
  });

  it('keeps real building heights, falls back on floors and then on a steady guess, and drops tiny sheds', () => {
    expect(buildingHeight(feat({ props: { render_height: 42 } }), [1, 2]).h).toBe(42);
    expect(buildingHeight(feat({ props: { render_height: 0, 'building:levels': 4 } }), [1, 2]).h).toBeCloseTo(13.2);
    const guess = buildingHeight(feat({}), [10, 20]);
    expect(guess).toEqual(buildingHeight(feat({}), [10, 20]));
    expect(guess.h).toBeGreaterThanOrEqual(8);
    expect(guess.h).toBeLessThanOrEqual(18);
    expect(buildingHeight(feat({ props: { render_height: 9999 } }), [0, 0]).h).toBe(450);
    expect(buildingHeight(feat({ props: { render_height: 20, render_min_height: 15 } }), [0, 0])).toEqual({ h: 20, minH: 15 });
    const layers: VLayer[] = [{ name: 'building', extent: 4096, features: [feat({ polygons: [[sq(2000, 2000, 8)], [sq(2100, 2100, 300)]], props: { render_height: 20 } })] }];
    const w = buildTileWorld(layers, 14, 8299, 5636, origin);
    expect(w.buildings).toHaveLength(1); // the 8-unit square is a shed, well under 14 square metres
    expect(w.buildings[0]!.h).toBe(20);
  });

  it('draws streets by class, leaves out rail and tunnels, and keeps street names for the HUD', () => {
    const line = (cls: string, extra: Record<string, string> = {}): VFeature => feat({ kind: 'line', props: { class: cls, ...extra }, lines: [[[0, 0], [1000, 0]]] });
    const layers: VLayer[] = [
      { name: 'transportation', extent: 4096, features: [line('primary'), line('minor'), line('path'), line('rail'), line('service', { brunnel: 'tunnel' }), line('unknown_kind')] },
      { name: 'transportation_name', extent: 4096, features: [feat({ kind: 'line', props: { name: 'Rue de Rivoli' }, lines: [[[0, 0], [1000, 0]]] })] },
    ];
    const w = buildTileWorld(layers, 14, 8299, 5636, origin);
    expect(w.roads.map((r) => [r.cls, r.width])).toEqual([['primary', ROAD_WIDTH.primary], ['minor', ROAD_WIDTH.minor], ['path', ROAD_WIDTH.path], ['unknown_kind', 5]]);
    expect(w.named.map((n) => n.name)).toEqual(['Rue de Rivoli']);
  });

  it('keeps water, rivers and canals as water, and grass, woods and sand as ground, and ignores the rest', () => {
    const layers: VLayer[] = [
      { name: 'water', extent: 4096, features: [feat({ polygons: [[sq(0, 0, 500)]] })] },
      { name: 'waterway', extent: 4096, features: [feat({ kind: 'line', props: { class: 'canal' }, lines: [[[0, 0], [900, 900]]] }), feat({ kind: 'line', props: { class: 'weird' }, lines: [[[0, 0], [9, 9]]] })] },
      { name: 'landcover', extent: 4096, features: [feat({ props: { class: 'grass' }, polygons: [[sq(0, 0, 100)]] }), feat({ props: { class: 'wood' }, polygons: [[sq(0, 0, 100)]] }), feat({ props: { class: 'sand' }, polygons: [[sq(0, 0, 100)]] }), feat({ props: { class: 'ice' }, polygons: [[sq(0, 0, 100)]] })] },
      { name: 'landuse', extent: 4096, features: [feat({ props: { class: 'park' }, polygons: [[sq(0, 0, 100)]] }), feat({ props: { class: 'industrial' }, polygons: [[sq(0, 0, 100)]] })] },
    ];
    const w = buildTileWorld(layers, 14, 8299, 5636, origin);
    expect(w.water).toHaveLength(1);
    expect(w.waterLines).toHaveLength(1);
    expect(w.waterLines[0]!.width).toBe(10);
    expect(w.areas.map((a) => a.kind)).toEqual(['grass', 'wood', 'sand', 'grass']);
  });
});

// ---------------------------------------------------------------- walls and water
const wall = (cx: number, cz: number, size: number): Pt[][] => [[[cx - size / 2, cz - size / 2], [cx + size / 2, cz - size / 2], [cx + size / 2, cz + size / 2], [cx - size / 2, cz + size / 2]]];

function world(build: (t: TileColliders) => void): Colliders & Hazards {
  const c = new Colliders();
  const t = new TileColliders();
  build(t);
  c.set('t', t);
  return c;
}

describe('walls and water', () => {
  it('knows what is inside a polygon and its courtyards, and the nearest point on a wall', () => {
    const outer: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const hole: Pt[] = [[4, 4], [6, 4], [6, 6], [4, 6]];
    expect(insidePolygon(2, 2, [outer, hole])).toBe(true);
    expect(insidePolygon(5, 5, [outer, hole])).toBe(false);
    expect(insidePolygon(20, 5, [outer, hole])).toBe(false);
    const n = nearestOnSegment(5, 3, 0, 0, 10, 0);
    expect(n).toEqual({ px: 5, pz: 0, d: 3 });
    expect(nearestOnSegment(15, 0, 0, 0, 10, 0).px).toBe(10);
  });

  it('pushes a circle out of a wall, and out of a building it started inside', () => {
    const w = world((t) => t.addBuilding(wall(0, 0, 10)));
    const near = w.resolve(-5.2, 0, 0.5);
    expect(near.hit).toBe(true);
    expect(near.x).toBeCloseTo(-5.5, 1);
    expect(w.resolve(-9, 0, 0.5).hit).toBe(false);
    const inside = w.resolve(1, 0.5, 0.5);
    expect(inside.hit).toBe(true);
    expect(Math.abs(inside.x) > 5.4 || Math.abs(inside.z) > 5.4).toBe(true);
    expect(w.insideBuilding(0, 0)).toBe(true);
    expect(w.insideBuilding(8, 0)).toBe(false);
  });

  it('leaves a courtyard open, and treats ponds, rivers and canals as water', () => {
    const w = world((t) => {
      t.addBuilding([wall(0, 0, 20)[0]!, [[-3, -3], [-3, 3], [3, 3], [3, -3]]]);
      t.addWater([[[100, 100], [140, 100], [140, 140], [100, 140]]]);
      t.addWaterLine([[200, 0], [200, 100]], 12);
    });
    expect(w.insideBuilding(0, 0)).toBe(false); // the courtyard
    expect(w.insideBuilding(8, 0)).toBe(true);
    expect(w.inWater(120, 120)).toBe(true);
    expect(w.inWater(95, 120)).toBe(false);
    expect(w.inWater(204, 50)).toBe(true);
    expect(w.inWater(210, 50)).toBe(false);
  });

  it('forgets a tile when it is unloaded', () => {
    const w = world((t) => t.addBuilding(wall(0, 0, 10)));
    expect(w.resolve(-5.2, 0, 0.5).hit).toBe(true);
    w.remove('t');
    expect(w.size).toBe(0);
    expect(w.resolve(-5.2, 0, 0.5).hit).toBe(false);
  });
});

// ---------------------------------------------------------------- movement
const open = (): Hazards => ({ resolve: (x, z) => ({ x, z, hit: false }), inWater: () => false });
const run = (n: number, f: () => void): void => {
  for (let i = 0; i < n; i++) f();
};

describe('on foot', () => {
  const foot = (): Foot => ({ x: 0, z: 0, vx: 0, vz: 0, heading: 0 });

  it('walks at walking pace, runs faster, and stops quickly when let go', () => {
    const w = open();
    const a = foot();
    run(120, () => stepFoot(a, { dx: 1, dz: 0, run: false }, 1 / 60, w));
    expect(Math.hypot(a.vx, a.vz)).toBeCloseTo(WALK_SPEED, 1);
    const b = foot();
    run(120, () => stepFoot(b, { dx: 1, dz: 0, run: true }, 1 / 60, w));
    expect(Math.hypot(b.vx, b.vz)).toBeCloseTo(RUN_SPEED, 1);
    run(30, () => stepFoot(b, { dx: 0, dz: 0, run: false }, 1 / 60, w));
    expect(Math.hypot(b.vx, b.vz)).toBeLessThan(0.1);
    expect(b.heading).toBeCloseTo(Math.PI / 2, 1); // facing east
  });

  it('never goes faster than the pace allows, however hard the stick is pushed or whichever way', () => {
    const w = open();
    const a = foot();
    run(300, () => stepFoot(a, { dx: 5, dz: 5, run: true }, 1 / 60, w));
    expect(Math.hypot(a.vx, a.vz)).toBeLessThanOrEqual(RUN_SPEED + 1e-6);
  });

  it('is stopped by a wall, and slides along the shore instead of walking into water', () => {
    const walls = world((t) => t.addBuilding(wall(10, 0, 6)));
    const a = foot();
    run(600, () => stepFoot(a, { dx: 1, dz: 0, run: true }, 1 / 60, walls));
    expect(a.x).toBeLessThan(7);
    expect(a.x).toBeGreaterThan(6);
    const lake = world((t) => t.addWater([[[5, -50], [100, -50], [100, 50], [5, 50]]]));
    const b = foot();
    run(600, () => stepFoot(b, { dx: 1, dz: 0.2, run: true }, 1 / 60, lake));
    expect(b.x).toBeLessThanOrEqual(5);
    expect(lake.inWater(b.x, b.z)).toBe(false);
    expect(b.z).toBeGreaterThan(0); // slid along the shore
  });
});

describe('in a car and a boat', () => {
  const car = (): Vehicle => ({ x: 0, z: 0, heading: 0, speed: 0 });

  it('speeds up to its top speed and no more, brakes, and reverses slowly', () => {
    const w = open();
    const v = car();
    run(60 * 20, () => stepVehicle(v, { throttle: 1, steer: 0, handbrake: false }, CAR, 1 / 60, w));
    expect(v.speed).toBeLessThanOrEqual(CAR.maxForward);
    expect(v.speed).toBeGreaterThan(CAR.maxForward * 0.9);
    expect(v.z).toBeLessThan(-100); // heading north is towards negative z
    run(60 * 6, () => stepVehicle(v, { throttle: -1, steer: 0, handbrake: false }, CAR, 1 / 60, w));
    expect(v.speed).toBeLessThan(0);
    expect(v.speed).toBeGreaterThanOrEqual(-CAR.maxReverse);
  });

  it('turns only while it moves, and a handbrake slows it', () => {
    const w = open();
    const still = car();
    run(60, () => stepVehicle(still, { throttle: 0, steer: 1, handbrake: false }, CAR, 1 / 60, w));
    expect(still.heading).toBe(0);
    const v = car();
    run(60 * 3, () => stepVehicle(v, { throttle: 1, steer: 1, handbrake: false }, CAR, 1 / 60, w));
    expect(v.heading).toBeGreaterThan(0.5);
    const s = v.speed;
    run(30, () => stepVehicle(v, { throttle: 0, steer: 0, handbrake: true }, CAR, 1 / 60, w));
    expect(v.speed).toBeLessThan(s * 0.5);
  });

  it('crashes into a wall without passing through it, losing speed', () => {
    const w = world((t) => t.addBuilding(wall(0, -60, 10)));
    const v = car();
    let crashed = false;
    run(60 * 10, () => {
      crashed = stepVehicle(v, { throttle: 1, steer: 0, handbrake: false }, CAR, 1 / 60, w).crashed || crashed;
    });
    expect(crashed).toBe(true);
    expect(v.z).toBeGreaterThan(-60 + 5 + CAR.radius - 0.5);
    expect(Math.abs(v.speed)).toBeLessThan(CAR.maxForward);
  });

  it('keeps a car out of the water, and a boat in it', () => {
    const lake = world((t) => t.addWater([[[-100, -200], [100, -200], [100, -50], [-100, -50]]]));
    const v = car();
    run(60 * 15, () => stepVehicle(v, { throttle: 1, steer: 0, handbrake: false }, CAR, 1 / 60, lake));
    expect(lake.inWater(v.x, v.z)).toBe(false);
    expect(v.z).toBeGreaterThanOrEqual(-50);
    const boat: Vehicle = { x: 0, z: -100, heading: 0, speed: 0 };
    run(60 * 30, () => stepVehicle(boat, { throttle: 1, steer: 0, handbrake: false }, BOAT, 1 / 60, lake));
    expect(lake.inWater(boat.x, boat.z)).toBe(true);
    expect(boat.z).toBeGreaterThanOrEqual(-200);
    expect(boat.speed).toBeLessThanOrEqual(BOAT.maxForward);
  });
});

// ---------------------------------------------------------------- the server's rule for roaming
describe('the roaming speed limit', () => {
  it('allows what each way of travelling can really cover, plus a little slack, and no more', () => {
    expect(allowedMetres('walk', 10_000)).toBe(MAX_SPEED_MS.walk * 10 + SLACK_M);
    expect(allowedMetres('car', 2_000)).toBe(MAX_SPEED_MS.car * 2 + SLACK_M);
    expect(allowedMetres('walk', -5000)).toBe(SLACK_M);
    expect(allowedMetres('run', 10 * 60_000)).toBe(allowedMetres('run', MAX_GAP_MS)); // a long silence earns no long jump
  });

  it('accepts a believable move and refuses a jump', () => {
    const from: [number, number] = [2.3522, 48.8566];
    const near: [number, number] = [2.3522, 48.8566 + 0.0004]; // about 44 m
    expect(roamAllowed(from, near, 'run', 5_000).ok).toBe(true);
    const far: [number, number] = [2.3522, 48.8566 + 0.01]; // about 1.1 km
    expect(roamAllowed(from, far, 'run', 5_000).ok).toBe(false);
    expect(roamAllowed(from, far, 'car', 60_000).ok).toBe(true);
    expect(roamAllowed(from, [2.45, 48.9], 'car', 60_000).ok).toBe(false); // across the city is still too far
    expect(isRoamMode('car')).toBe(true);
    expect(isRoamMode('rocket')).toBe(false);
  });

  it('is slower on foot than in a car, and the page physics never exceed the server limit', () => {
    expect(MAX_SPEED_MS.walk).toBeLessThan(MAX_SPEED_MS.run);
    expect(MAX_SPEED_MS.run).toBeLessThan(MAX_SPEED_MS.car);
    expect(WALK_SPEED).toBeLessThan(MAX_SPEED_MS.walk);
    expect(RUN_SPEED).toBeLessThan(MAX_SPEED_MS.run);
    expect(CAR.maxForward).toBeLessThan(MAX_SPEED_MS.car);
    expect(BOAT.maxForward).toBeLessThan(MAX_SPEED_MS.boat);
  });
});
