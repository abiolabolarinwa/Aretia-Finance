// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as three from 'three';
import { HEIGHT, SIT_HIPS, makeAnimatedHuman, parseCharacter, pickClips, seatOffset, type CharacterTemplate } from './characters.js';

const file = new URL('../../../public/game/models/man.glb', import.meta.url);
const load = async (): Promise<CharacterTemplate> => {
  const b = readFileSync(file);
  return parseCharacter(three, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
};

describe('the animated person (real model file)', () => {
  it('finds the idle, walk, run and sitting animations among the model\'s clips', async () => {
    const t = await load();
    expect(t.clips.idle).toBeDefined();
    expect(t.clips.walk).toBeDefined();
    expect(t.clips.run).toBeDefined();
    expect(t.clips.sit).toBeDefined();
    expect(t.clips.walk!.duration).toBeGreaterThan(0.3);
  });

  it('matches clip names by their last word, so Idle does not pick up other idle variants', () => {
    const mk = (n: string): three.AnimationClip => new three.AnimationClip(n, 1, []);
    const picked = pickClips([mk('A|Idle_Gun'), mk('A|Walk_Back'), mk('A|Idle'), mk('A|Walk'), mk('A|Run_Shoot'), mk('A|Run')]);
    expect(picked.idle!.name).toBe('A|Idle');
    expect(picked.walk!.name).toBe('A|Walk');
    expect(picked.run!.name).toBe('A|Run');
  });

  it('is sized to 1.75 m with its feet on the ground and faces forward (-z)', async () => {
    const t = await load();
    const p = makeAnimatedHuman(three, t);
    p.update(0.016, 0, false);
    p.group.updateMatrixWorld(true);
    const box = new three.Box3().setFromObject(p.group);
    expect(box.max.y - box.min.y).toBeGreaterThan(HEIGHT - 0.1);
    expect(box.max.y - box.min.y).toBeLessThan(HEIGHT + 0.1);
    expect(Math.abs(box.min.y)).toBeLessThan(0.08);
    // The toes point towards -z: the left foot's tip is further to -z than its ankle.
    let ankle: three.Object3D | null = null;
    let toe: three.Object3D | null = null;
    p.group.traverse((o) => {
      if (/^foot_?l$/i.test(o.name)) ankle = o;
      else if (/^foot_?l_?end$/i.test(o.name)) toe = o;
    });
    expect(ankle).not.toBeNull();
    expect(toe).not.toBeNull();
    const a = new three.Vector3().setFromMatrixPosition((ankle as unknown as three.Object3D).matrixWorld);
    const b = new three.Vector3().setFromMatrixPosition((toe as unknown as three.Object3D).matrixWorld);
    expect(b.z - a.z).toBeLessThan(0);
    expect(Math.abs(b.x - a.x)).toBeLessThan(Math.abs(b.z - a.z));
    p.dispose();
  });

  it('eases from standing to walking to running, never switching abruptly', async () => {
    const t = await load();
    const p = makeAnimatedHuman(three, t);
    for (let i = 0; i < 60; i++) p.update(0.016, 0, false);
    expect(p.weights().idle).toBeGreaterThan(0.95);
    // Start walking: the first frame is mostly still idle, and it settles into walk.
    p.update(0.016, 1.5, false);
    expect(p.weights().idle).toBeGreaterThan(0.7);
    for (let i = 0; i < 80; i++) p.update(0.016, 1.5, false);
    expect(p.weights().walk).toBeGreaterThan(0.9);
    expect(p.weights().run).toBeLessThan(0.05);
    for (let i = 0; i < 120; i++) p.update(0.016, 6, true);
    expect(p.weights().run).toBeGreaterThan(0.9);
    // The weights always add up to one: a blend, not a pop.
    const w = p.weights();
    expect(w.idle + w.walk + w.run).toBeCloseTo(1, 1);
    p.dispose();
  });

  it('colours each person from their look, without changing anyone else', async () => {
    const t = await load();
    const red = makeAnimatedHuman(three, t, { skin: '#8d5a3b', hair: '#161210', top: '#ff0000', trousers: '#0000ff', shoes: '#ffffff' });
    const green = makeAnimatedHuman(three, t, { skin: '#8d5a3b', hair: '#161210', top: '#00ff00', trousers: '#0000ff', shoes: '#ffffff' });
    const shirt = (g: three.Object3D): three.Color | null => {
      let c: three.Color | null = null;
      g.traverse((o) => {
        const m = o as three.Mesh;
        if (!m.isMesh) return;
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (mat.name === 'Shirt') c = (mat as three.MeshStandardMaterial).color;
      });
      return c;
    };
    const r = shirt(red.group)!;
    const g = shirt(green.group)!;
    expect(r.r).toBeGreaterThan(0.9);
    expect(g.g).toBeGreaterThan(0.9);
    expect(g.r).toBeLessThan(0.1);
    red.dispose();
    green.dispose();
  });

  it('sits with its hips where the seat constants say, so it can be placed on a car seat', async () => {
    const t = await load();
    const p = makeAnimatedHuman(three, t);
    p.sit!(true);
    for (let i = 0; i < 120; i++) p.update(0.05, 0, false);
    p.group.updateMatrixWorld(true);
    let hips: three.Object3D | null = null;
    let head: three.Object3D | null = null;
    p.group.traverse((o) => {
      if (/^hips$/i.test(o.name)) hips = o;
      if (/^head$/i.test(o.name)) head = o;
    });
    const h = new three.Vector3().setFromMatrixPosition((hips as unknown as three.Object3D).matrixWorld);
    expect(h.x).toBeCloseTo(SIT_HIPS[0], 1);
    expect(h.y).toBeCloseTo(SIT_HIPS[1], 1);
    expect(h.z).toBeCloseTo(SIT_HIPS[2], 1);
    // Seated, the head is well below standing height and about 0.8 m above the hips.
    const hd = new three.Vector3().setFromMatrixPosition((head as unknown as three.Object3D).matrixWorld);
    expect(hd.y - h.y).toBeGreaterThan(0.7);
    expect(hd.y - h.y).toBeLessThan(0.95);
    expect(seatOffset([-0.45, 0.44, 0.5])).toEqual([-0.45 - SIT_HIPS[0], 0.44 - SIT_HIPS[1], 0.5 - SIT_HIPS[2]]);
    p.dispose();
  });

  it('can sit down and stand up again', async () => {
    const t = await load();
    const p = makeAnimatedHuman(three, t);
    p.sit!(true);
    for (let i = 0; i < 80; i++) p.update(0.016, 0, false);
    expect(p.weights().idle).toBeLessThan(0.05);
    p.sit!(false);
    for (let i = 0; i < 80; i++) p.update(0.016, 0, false);
    expect(p.weights().idle).toBeGreaterThan(0.9);
    p.dispose();
  });
});
