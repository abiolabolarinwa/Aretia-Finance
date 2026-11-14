import { describe, expect, it } from 'vitest';
import * as three from 'three';
import { pickNext, startAgent, stepAgent, type Seg } from './agents.js';
import { makeCar } from './vehicles.js';
import { HAZE, SUN_DIRECTION, skyMaterial } from './atmosphere.js';

const seg = (ax: number, az: number, bx: number, bz: number, width = 8, cls = 'secondary'): Seg => ({ a: [ax, az], b: [bx, bz], width, cls });

describe('agents on streets', () => {
  it('start on their side of the street, facing along it', () => {
    // A street running east: cars keep to the right, which is south (larger z) when facing east.
    const a = startAgent(seg(0, 0, 100, 0), 10, 8, 2);
    expect(a.x).toBeCloseTo(10);
    expect(a.z).toBeCloseTo(2);
    expect(a.heading).toBeCloseTo(Math.PI / 2);
    // Facing north, the right is east.
    const n = startAgent(seg(0, 0, 0, -100), 10, 8, 2);
    expect(n.x).toBeCloseTo(2);
    expect(n.z).toBeCloseTo(-10);
    expect(n.heading).toBeCloseTo(0);
  });

  it('move at their speed and carry on round a corner onto the connecting street', () => {
    const first = seg(0, 0, 20, 0);
    const second = seg(20, 0, 20, 60);
    const a = startAgent(first, 0, 10, 0);
    const pick = (end: [number, number], from: Seg): Seg | null => pickNext([first, second], end, from, () => 0);
    for (let i = 0; i < 60; i++) stepAgent(a, 0.05, pick); // 3 s at 10 m/s: 20 m along, round the corner, 10 m on
    expect(a.seg.b).toEqual([20, 60]);
    expect(a.x).toBeCloseTo(20, 0);
    expect(a.z).toBeCloseTo(10, 0);
    // It has turned to face south, gradually.
    for (let i = 0; i < 40; i++) stepAgent(a, 0.05, pick);
    expect(a.heading).toBeCloseTo(Math.PI, 1);
  });

  it('turns about at a dead end instead of leaving the street', () => {
    const only = seg(0, 0, 30, 0);
    const a = startAgent(only, 28, 10, 0);
    for (let i = 0; i < 20; i++) stepAgent(a, 0.05, () => null);
    expect(a.x).toBeLessThan(30);
    expect(a.x).toBeGreaterThan(20);
    expect(a.seg.b).toEqual([0, 0]); // now heading back the way it came
  });

  it('picks a different street than the one it came from, and only ones that meet at the junction', () => {
    const a = seg(0, 0, 50, 0);
    const b = seg(50, 0, 50, 40);
    const c = seg(50, 0, 90, 0);
    const far = seg(500, 500, 600, 500);
    const seen = new Set<string>();
    for (const r of [0, 0.3, 0.6, 0.99]) {
      const n = pickNext([a, b, c, far], [50, 0], a, () => r)!;
      seen.add(`${n.b[0]},${n.b[1]}`);
      expect(n).not.toBe(a);
      expect(n.a).toEqual([50, 0]); // oriented to leave the junction
    }
    expect(seen).toEqual(new Set(['50,40', '90,0']));
    expect(pickNext([a, far], [50, 0], a, () => 0)).toBeNull(); // nothing connects
    // Given a street that only goes back, it will take it rather than be stuck.
    const back = seg(50, 0, 0, 0, 8, 'minor');
    const turned = pickNext([back], [50, 0], a, () => 0);
    expect(turned).not.toBeNull();
  });
});

describe('cars and the sky', () => {
  it('builds a car about 4.6 m long, 1.9 m wide and under 2 m tall, with wheels on the ground, facing -z', () => {
    for (const kind of ['sedan', 'suv', 'taxi'] as const) {
      const car = makeCar(three, '#aa2222', kind);
      const b = new three.Box3().setFromObject(car.group);
      expect(b.max.z - b.min.z).toBeGreaterThan(4.4);
      expect(b.max.z - b.min.z).toBeLessThan(4.9);
      expect(b.max.x - b.min.x).toBeGreaterThan(1.8);
      expect(b.max.x - b.min.x).toBeLessThan(2.1);
      expect(b.max.y).toBeGreaterThan(1.4);
      expect(b.max.y).toBeLessThan(2.0);
      expect(b.min.y).toBeGreaterThanOrEqual(-0.01);
      expect(b.min.y).toBeLessThan(0.05);
      car.dispose();
    }
  });

  it('has a low sun in the west-north-west and a warm haze, in a sky that can be drawn', () => {
    expect(Math.hypot(...SUN_DIRECTION)).toBeCloseTo(1);
    expect(SUN_DIRECTION[1]).toBeGreaterThan(0.2);
    expect(SUN_DIRECTION[1]).toBeLessThan(0.6);
    expect(HAZE).toMatch(/^#[0-9a-f]{6}$/);
    const m = skyMaterial(three);
    expect(m.fragmentShader).toContain('uSunDir');
    expect(m.uniforms.uSunDir!.value.length()).toBeCloseTo(1);
    m.dispose();
  });
});
