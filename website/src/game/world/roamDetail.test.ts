import { describe, expect, it } from 'vitest';
import * as three from 'three';
import { hash2, lampsFor, offsetPolyline, paintGround, squareOf, treesFor } from './roamDetail.js';
import { buildingParts, CELL_M } from './roamBuild.js';
import { makeHuman } from './human.js';
import type { TileWorld } from './worldData.js';

const empty = (): TileWorld => ({ buildings: [], roads: [], named: [], water: [], waterLines: [], areas: [] });
const never = (): boolean => false;

/** A drawing context that only records what is drawn. */
function recorder(): { ctx: CanvasRenderingContext2D; calls: string[]; strokes: { colour: string; width: number }[] } {
  const calls: string[] = [];
  const strokes: { colour: string; width: number }[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get(t, k: string) {
      if (k in t) return t[k];
      return (...a: unknown[]) => {
        calls.push(k);
        if (k === 'stroke') strokes.push({ colour: String(t.strokeStyle), width: Number(t.lineWidth) });
        return a.length ? undefined : undefined;
      };
    },
    set(t, k: string, v) {
      t[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, strokes };
}

describe('the detail of the ground', () => {
  it('finds a square from its key', () => {
    expect(squareOf('2,-3')).toEqual({ x0: 400, z0: -600 });
  });

  it('paints pavement, kerb and asphalt for a street, and a dashed centre line on a wide one', () => {
    const w = empty();
    w.roads.push({ pts: [[10, 100], [190, 100]], width: 8, cls: 'primary' });
    const r = recorder();
    paintGround(r.ctx, 512, '0,0', w);
    const colours = r.strokes.map((s) => s.colour);
    expect(colours).toContain('#c9c6bb'); // pavement
    expect(colours).toContain('#7d7b74'); // kerb
    expect(colours).toContain('#323237'); // primary asphalt
    expect(colours).toContain('#f1f1f1'); // lane line
    // The pavement is wider than the street, the street wider than its kerb line.
    const widest = Math.max(...r.strokes.map((s) => s.width));
    expect(widest).toBeCloseTo((8 + 5) * (512 / CELL_M));
  });

  it('leaves out streets and parks that are not in the square, and paths get no pavement', () => {
    const w = empty();
    w.roads.push({ pts: [[900, 900], [950, 900]], width: 8, cls: 'primary' }, { pts: [[10, 10], [60, 10]], width: 2, cls: 'path' });
    const r = recorder();
    paintGround(r.ctx, 256, '0,0', w);
    expect(r.strokes.map((s) => s.colour)).toEqual(['#b59f78']);
  });

  it('moves a line sideways for lane edges', () => {
    const o = offsetPolyline([[0, 0], [10, 0]], 2);
    expect(o[0]![1]).toBeCloseTo(2);
    expect(o[1]![1]).toBeCloseTo(2);
    expect(o[1]![0]).toBeCloseTo(10);
  });

  it('plants the same trees every time, only inside the park, and never in a building or the water', () => {
    const w = empty();
    w.areas.push({ rings: [[[20, 20], [120, 20], [120, 120], [20, 120]]], kind: 'wood' });
    const a = treesFor('0,0', w, never);
    const b = treesFor('0,0', w, never);
    expect(a.length).toBeGreaterThan(40);
    expect(a).toEqual(b);
    for (const p of a) {
      expect(p.x).toBeGreaterThanOrEqual(20);
      expect(p.x).toBeLessThanOrEqual(120);
      expect(p.z).toBeGreaterThanOrEqual(20);
      expect(p.z).toBeLessThanOrEqual(120);
      expect(p.s).toBeGreaterThanOrEqual(0.7);
      expect(p.s).toBeLessThanOrEqual(1.4);
    }
    expect(treesFor('0,0', w, () => true)).toHaveLength(0);
    expect(treesFor('5,5', w, never)).toHaveLength(0); // a square with no park has none
    expect(treesFor('0,0', w, never, 10)).toHaveLength(10);
  });

  it('lines streets with trees and lamps but not paths or motorways', () => {
    const w = empty();
    w.roads.push({ pts: [[5, 100], [195, 100]], width: 8, cls: 'secondary' });
    expect(treesFor('0,0', w, never).length).toBeGreaterThan(3);
    const lamps = lampsFor('0,0', w, never);
    expect(lamps.length).toBeGreaterThanOrEqual(3);
    expect(new Set(lamps.map((l) => Math.sign(l.z - 100))).size).toBe(2); // both sides
    const p = empty();
    p.roads.push({ pts: [[5, 100], [195, 100]], width: 3, cls: 'path' });
    expect(treesFor('0,0', p, never)).toHaveLength(0);
    expect(lampsFor('0,0', p, never)).toHaveLength(0);
  });

  it('gives a steady number from a place', () => {
    expect(hash2(3, 4)).toBe(hash2(3, 4));
    expect(hash2(3, 4)).not.toBe(hash2(4, 3));
  });
});

describe('buildings with windows', () => {
  it('gives walls picture coordinates, one bay per 3.6 m across and one storey per 3.2 m up, and keeps the roof separate', () => {
    const parts = buildingParts(three, [{ rings: [[[0, 0], [36, 0], [36, 9.6], [0, 9.6]]], h: 9.6, minH: 0 }], '#223355');
    expect(parts.walls).not.toBeNull();
    expect(parts.roofs).not.toBeNull();
    const uv = parts.walls!.getAttribute('uv');
    expect(uv.count).toBe(parts.walls!.getAttribute('position').count);
    let maxU = 0;
    let maxV = 0;
    for (let i = 0; i < uv.count; i++) {
      maxU = Math.max(maxU, uv.getX(i));
      maxV = Math.max(maxV, uv.getY(i));
    }
    expect(maxU).toBe(10); // 36 m of wall is 10 bays
    expect(maxV).toBe(3); // 9.6 m is 3 storeys
    expect(parts.roofs!.getAttribute('position').count).toBe(6);
    // Three storeys on the ground: each of the four walls is a ground-floor quad plus an upper quad (4 x 2 x 6 vertices).
    expect(parts.walls!.getAttribute('position').count).toBe(48);
  });

  it('gives a one-storey building a single wall quad, and a ground floor of a taller one a darker tone', () => {
    const low = buildingParts(three, [{ rings: [[[0, 0], [10, 0], [10, 10], [0, 10]]], h: 3.2, minH: 0 }], '#223355');
    expect(low.walls!.getAttribute('position').count).toBe(24);
    const tall = buildingParts(three, [{ rings: [[[0, 0], [10, 0], [10, 10], [0, 10]]], h: 12.8, minH: 0 }], '#223355');
    const col = tall.walls!.getAttribute('color');
    const pos = tall.walls!.getAttribute('position');
    let ground = 0;
    let upper = 0;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) === 0 && !ground) ground = col.getX(i);
      if (pos.getY(i) > 12.7 && !upper) upper = col.getX(i);
    }
    expect(ground).toBeGreaterThan(0);
    expect(ground).toBeLessThan(upper);
  });

  it('uses the colour the map records for a building, softened, instead of a random neutral', () => {
    const red = buildingParts(three, [{ rings: [[[0, 0], [10, 0], [10, 10], [0, 10]]], h: 3.2, minH: 0, colour: '#b5483c' }], '#000000');
    const neutral = buildingParts(three, [{ rings: [[[0, 0], [10, 0], [10, 10], [0, 10]]], h: 3.2, minH: 0 }], '#000000');
    const c = red.walls!.getAttribute('color');
    const n = neutral.walls!.getAttribute('color');
    expect(c.getX(0)).toBeGreaterThan(c.getZ(0) * 1.15); // reddish: red channel well above blue
    expect(Math.abs(n.getX(0) - n.getZ(0))).toBeLessThan(c.getX(0) - c.getZ(0));
  });

  it('returns nothing for no buildings', () => {
    expect(buildingParts(three, [], '#000000')).toEqual({ walls: null, roofs: null });
  });
});

describe('the person', () => {
  const box = (o: three.Object3D): three.Box3 => new three.Box3().setFromObject(o);

  it('stands about 1.75 m tall with feet on the ground, facing forward (-z)', () => {
    const h = makeHuman(three);
    h.update(0.016, 0, false);
    const b = box(h.group);
    expect(b.min.y).toBeGreaterThan(-0.05);
    expect(b.min.y).toBeLessThan(0.05);
    expect(b.max.y).toBeGreaterThan(1.65);
    expect(b.max.y).toBeLessThan(1.85);
    // Wider than deep at the shoulders, and the shoes point forward so the person reaches further towards -z than +z.
    expect(b.max.x - b.min.x).toBeGreaterThan(0.4);
    expect(b.min.z).toBeLessThan(-0.15);
    h.dispose();
  });

  it('walks: legs swing in opposite directions, and a run swings further and leans forward', () => {
    const walk = makeHuman(three);
    const run = makeHuman(three);
    let wl = 0;
    let rl = 0;
    for (let i = 0; i < 90; i++) {
      walk.update(0.016, 2.2, false);
      run.update(0.016, 6, true);
      const wb = box(walk.group);
      const rb = box(run.group);
      wl = Math.max(wl, wb.max.z - wb.min.z);
      rl = Math.max(rl, rb.max.z - rb.min.z);
    }
    expect(wl).toBeGreaterThan(0.5); // feet apart front to back
    expect(rl).toBeGreaterThan(wl);
    // Standing again, the person settles back upright.
    for (let i = 0; i < 200; i++) walk.update(0.016, 0, false);
    const rest = box(walk.group);
    expect(rest.max.y).toBeGreaterThan(1.65);
    walk.dispose();
    run.dispose();
  });
});
