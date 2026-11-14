import { describe, expect, it } from 'vitest';
import { CITIES, SCENES, type City } from './cities.js';
import { buildChamberModel, buildCityModel, CHAMBERS, isChamber, MAX_BOXES, projector, type Rect } from './sceneModel.js';

const inside = (r: Rect, x: number, z: number): boolean => Math.abs(x - r.x) <= r.w / 2 && Math.abs(z - r.z) <= r.d / 2;

describe('the 3D city scene model', () => {
  it('is the same every time for the same city, and different between cities', () => {
    const a = buildCityModel(CITIES[0]!);
    const b = buildCityModel(CITIES[0]!);
    expect(JSON.stringify([a.boxes, a.trees, a.hills, a.water])).toBe(JSON.stringify([b.boxes, b.trees, b.hills, b.water]));
    expect(JSON.stringify(buildCityModel(CITIES[1]!).boxes)).not.toBe(JSON.stringify(a.boxes));
  });

  it('puts every landmark where its coordinates say, inside the scene, and keeps every building out of the water', () => {
    for (const c of CITIES) {
      const m = buildCityModel(c);
      expect(m.marks.length, c.id).toBe(c.landmarks.length);
      for (const mark of m.marks) {
        expect(Math.abs(mark.x), `${c.id} ${mark.name}`).toBeLessThanOrEqual(m.width / 2);
        expect(Math.abs(mark.z), `${c.id} ${mark.name}`).toBeLessThanOrEqual(m.depth / 2);
        expect(mark.h).toBeGreaterThan(0);
      }
      for (const b of m.boxes) for (const w of m.water) expect(inside(w, b.x, b.z), `${c.id} building in water`).toBe(false);
      for (const t of m.trees) for (const w of m.water) expect(inside(w, t.x, t.z), `${c.id} tree in water`).toBe(false);
    }
  });

  it('keeps the model small enough to draw on a phone', () => {
    for (const c of CITIES) {
      const m = buildCityModel(c);
      expect(m.boxes.length, c.id).toBeGreaterThan(30);
      expect(m.boxes.length, c.id).toBeLessThanOrEqual(MAX_BOXES + 64);
      expect(m.trees.length).toBeLessThanOrEqual(200);
      expect(m.width).toBe(120);
      expect(m.depth).toBeGreaterThanOrEqual(120 * 0.6);
      expect(m.depth).toBeLessThanOrEqual(120 * 1.6);
    }
  });

  it('gives each kind of city what makes it that kind of city', () => {
    const by = (id: string) => buildCityModel(CITIES.find((c) => c.id === id)!);
    expect(by('hong-kong').hills.length).toBeGreaterThan(3); // hills round a harbour
    expect(by('dubai').hills.length).toBeGreaterThan(5); // dunes
    expect(by('dubai').ground).not.toBe(by('paris').ground); // desert sand against grey-green
    expect(by('lagos').water.length).toBeGreaterThan(0);
    expect(by('london').water.length).toBeGreaterThan(10); // a winding river
    expect(by('nairobi').water.length).toBe(0);
    expect(by('nairobi').trees.length).toBeGreaterThan(by('new-york').trees.length); // the park edge
    expect(Math.max(...by('new-york').boxes.map((b) => b.h))).toBeGreaterThan(Math.max(...by('paris').boxes.map((b) => b.h))); // towers against boulevards
    expect(by('nicosia').boxes.filter((b) => Math.hypot(b.x, b.z) > 18 && Math.hypot(b.x, b.z) < 21).length).toBeGreaterThanOrEqual(30); // a wall ring
  });

  it('has a preset for every scene name, and a city of unknown kind still draws', () => {
    for (const kind of SCENES) {
      const c: City = { ...CITIES[0]!, scene: kind };
      expect(buildCityModel(c).kind).toBe(kind);
    }
    const odd = { ...CITIES[0]!, scene: 'nonsense' as never };
    expect(buildCityModel(odd).boxes.length).toBeGreaterThan(0);
  });

  it('projects a corner of the city to a corner of the scene and the middle to the middle', () => {
    const c = CITIES.find((x) => x.id === 'paris')!;
    const { width, depth, project } = projector(c);
    const [w, s, e, n] = c.bounds;
    expect(project(w, n)).toEqual([-width / 2, -depth / 2]);
    expect(project(e, s)).toEqual([width / 2, depth / 2]);
    const mid = project((w + e) / 2, (s + n) / 2);
    expect(mid[0]).toBeCloseTo(0);
    expect(mid[1]).toBeCloseTo(0);
  });
});

describe('the chamber scenes', () => {
  it('exist for under water, underground and a vault, and are repeatable', () => {
    expect(CHAMBERS).toEqual(['underwater', 'underground', 'vault']);
    for (const k of CHAMBERS) {
      const a = buildChamberModel(k, 'x');
      expect(JSON.stringify(a)).toBe(JSON.stringify(buildChamberModel(k, 'x')));
      expect(a.props.length).toBeGreaterThan(10);
      expect(a.title.length).toBeGreaterThan(3);
      expect(a.caption).toMatch(/simulated|scene/i);
    }
    expect(buildChamberModel('underwater', 'a').props.map((p) => p.x).join()).not.toBe(buildChamberModel('underwater', 'b').props.map((p) => p.x).join());
  });

  it('look like what they are', () => {
    const types = (k: Parameters<typeof buildChamberModel>[0]) => new Set(buildChamberModel(k).props.map((p) => p.type));
    expect(types('underwater').has('kelp')).toBe(true);
    expect(types('underground').has('stalactite')).toBe(true);
    expect(types('underground').has('crystal')).toBe(true);
    expect(types('vault').has('column')).toBe(true);
    expect(buildChamberModel('underwater').fogDensity).toBeLessThan(buildChamberModel('underground').fogDensity);
  });

  it('recognises only its own names', () => {
    expect(isChamber('vault')).toBe(true);
    for (const bad of ['', 'none', 'cave', 5, null, undefined]) expect(isChamber(bad)).toBe(false);
  });
});
