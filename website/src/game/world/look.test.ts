// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as three from 'three';
import { BRIGHT, PALETTES, REAL, otherLook, saveLook, savedLook } from './style.js';
import { paintGround } from './roamDetail.js';
import { buildingParts } from './roamBuild.js';
import { skyMaterial } from './atmosphere.js';
import type { TileWorld } from './worldData.js';

const empty = (): TileWorld => ({ buildings: [], roads: [], named: [], water: [], waterLines: [], areas: [] });
const sq = [[[0, 0], [10, 0], [10, 10], [0, 10]]] as [number, number][][];

function recorder(): { ctx: CanvasRenderingContext2D; fills: string[]; strokes: string[] } {
  const fills: string[] = [];
  const strokes: string[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get(t, k: string) {
      if (k in t) return t[k];
      return () => {
        if (k === 'fill') fills.push(String(t.fillStyle));
        if (k === 'stroke') strokes.push(String(t.strokeStyle));
      };
    },
    set(t, k: string, v) {
      t[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, fills, strokes };
}

describe('the bright and realistic looks', () => {
  it('start bright, remember a choice, and ignore anything unreadable', () => {
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(savedLook(s)).toBe('bright');
    saveLook('real', s);
    expect(savedLook(s)).toBe('real');
    store.set('ucs-look', 'neon');
    expect(savedLook(s)).toBe('bright');
    expect(savedLook({ getItem: () => { throw new Error('blocked'); } })).toBe('bright');
    expect(() => saveLook('real', { setItem: () => { throw new Error('blocked'); } })).not.toThrow();
    expect(otherLook('bright')).toBe('real');
    expect(otherLook('real')).toBe('bright');
    expect(PALETTES.bright).toBe(BRIGHT);
    expect(PALETTES.real).toBe(REAL);
  });

  it('the bright look is flat-coloured with coloured roofs and no photographed texture, the realistic one the opposite', () => {
    expect(BRIGHT.photoDetail).toBe(false);
    expect(REAL.photoDetail).toBe(true);
    expect(BRIGHT.buildings.roofs!.length).toBeGreaterThan(4);
    expect(REAL.buildings.roofs).toBeNull();
    expect(BRIGHT.camera.pitch).toBeGreaterThan(REAL.camera.pitch); // looks down from higher up
    expect(BRIGHT.camera.foot).toBeGreaterThan(REAL.camera.foot);
    for (const p of [BRIGHT, REAL]) {
      for (const c of [p.ground, p.water, p.sky.haze, p.sky.zenith, ...Object.values(p.area), ...p.buildings.walls]) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('paints the ground in the chosen look: pastel green, blue water and light pavements for bright', () => {
    const w = empty();
    w.areas.push({ rings: sq, kind: 'grass' });
    w.water.push({ rings: sq, kind: 'grass' });
    w.roads.push({ pts: [[0, 100], [190, 100]], width: 8, cls: 'primary' });
    const bright = recorder();
    paintGround(bright.ctx, 256, '0,0', w, BRIGHT);
    expect(bright.fills).toContain(BRIGHT.area.grass);
    expect(bright.fills).toContain(BRIGHT.water);
    expect(bright.strokes).toContain(BRIGHT.road.pavement);
    expect(bright.strokes).toContain(BRIGHT.road.asphalt.primary);
    // Without a look it is the realistic one, as before.
    const real = recorder();
    paintGround(real.ctx, 256, '0,0', w);
    expect(real.fills).toContain(REAL.area.grass);
    expect(real.strokes).toContain(REAL.road.asphalt.primary);
    expect(real.strokes).not.toContain(BRIGHT.road.asphalt.primary);
  });

  it('gives bright buildings a coloured roof from the palette and ignores the map colour, while realistic ones darken the wall', () => {
    const b = { rings: [[[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][]], h: 3.2, minH: 0, colour: '#b5483c' };
    const hex = (c: three.Color): string => `#${c.getHexString()}`;
    const roofColour = (g: three.BufferGeometry | null): string => {
      const a = g!.getAttribute('color');
      return hex(new three.Color().setRGB(a.getX(0), a.getY(0), a.getZ(0)));
    };
    const bright = buildingParts(three, [b], '#223355', BRIGHT);
    expect(BRIGHT.buildings.roofs!.map((c) => hex(new three.Color(c)))).toContain(roofColour(bright.roofs));
    // Wall is a light pastel (every channel high), not the map's strong red.
    const wc = bright.walls!.getAttribute('color');
    expect(Math.min(wc.getX(0), wc.getY(0), wc.getZ(0))).toBeGreaterThan(0.55);
    const real = buildingParts(three, [b], '#223355');
    const rc = real.roofs!.getAttribute('color');
    const rw = real.walls!.getAttribute('color');
    expect(rc.getX(0)).toBeLessThan(rw.getX(0)); // roof darker than the wall
    expect(rw.getX(0)).toBeGreaterThan(rw.getZ(0) * 1.1); // the map's red still shows in the realistic look
  });

  it('draws the sky in the look\'s colours, with softer glare in the bright one', () => {
    const b = skyMaterial(three, BRIGHT);
    const r = skyMaterial(three, REAL);
    expect(b.uniforms.uHaze!.value.getHexString()).toBe(new three.Color(BRIGHT.sky.haze).getHexString());
    expect(r.uniforms.uHaze!.value.getHexString()).toBe(new three.Color(REAL.sky.haze).getHexString());
    expect(b.uniforms.uGlow!.value).toBeLessThan(r.uniforms.uGlow!.value);
    expect(b.fragmentShader).toContain('uCloudLit');
    b.dispose();
    r.dispose();
  });
});
