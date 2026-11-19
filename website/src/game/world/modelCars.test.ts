// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as three from 'three';
import { CAR_MODELS, makeModelCar, parseCarModel, type CarTemplate } from './modelCars.js';

// The models with a plain painted body can be read in a test; the two with a picture painted on need a browser to decode it.
const PLAIN = CAR_MODELS.filter((m) => ['taxi', 'suv', 'sedan', 'sports'].includes(m.file));
const cache = new Map<string, CarTemplate>();
const load = async (file: string): Promise<CarTemplate> => {
  const hit = cache.get(file);
  if (hit) return hit;
  const spec = CAR_MODELS.find((m) => m.file === file)!;
  const b = readFileSync(new URL(`../../../public/game/models/cars/${file}.glb`, import.meta.url));
  const t = await parseCarModel(three, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, spec);
  cache.set(file, t);
  return t;
};
const world = (o: three.Object3D): three.Vector3 => new three.Vector3().setFromMatrixPosition(o.matrixWorld);

describe('cars made from loaded models', () => {
  it('lists six cars, each with a name and a believable length, and the plain ones can be repainted', () => {
    expect(CAR_MODELS).toHaveLength(6);
    for (const m of CAR_MODELS) {
      expect(m.length).toBeGreaterThan(3.5);
      expect(m.length).toBeLessThan(5.5);
    }
    expect(CAR_MODELS.find((m) => m.file === 'suv')!.recolour).toBe(true);
    expect(CAR_MODELS.find((m) => m.file === 'taxi')!.recolour).toBe(false); // a taxi stays yellow
  });

  for (const spec of PLAIN) {
    it(`${spec.name}: is the right length, sits on the ground, faces -z, and has two front wheels and a rear pair that can turn`, async () => {
      const t = await load(spec.file);
      const car = makeModelCar(three, t);
      car.group.updateMatrixWorld(true);
      const box = new three.Box3().setFromObject(car.group);
      expect(box.max.z - box.min.z).toBeGreaterThan(spec.length - 0.15);
      expect(box.max.z - box.min.z).toBeLessThan(spec.length + 0.15);
      expect(box.min.y).toBeGreaterThan(-0.05);
      expect(box.min.y).toBeLessThan(0.1);
      expect(box.max.x - box.min.x).toBeGreaterThan(1.6);
      expect(box.max.x - box.min.x).toBeLessThan(2.55);
      expect(box.max.y).toBeLessThan(2.2);
      // Wheels: front ones are further towards -z than the rear ones.
      const pivots: three.Object3D[] = [];
      car.group.traverse((o) => {
        if (o.userData.wheel) pivots.push(o);
      });
      const front = pivots.filter((p) => p.userData.wheel === 'front');
      const rear = pivots.filter((p) => p.userData.wheel === 'rear');
      expect(front.length).toBe(2);
      expect(rear.length).toBeGreaterThanOrEqual(1);
      const fz = front.reduce((s, p) => s + world(p).z, 0) / front.length;
      const rz = rear.reduce((s, p) => s + world(p).z, 0) / rear.length;
      expect(fz).toBeLessThan(rz - 1.5); // the front is towards -z, a wheelbase away from the rear
      expect(t.wheelR).toBeGreaterThan(0.25);
      expect(t.wheelR).toBeLessThan(0.55);
      expect(car.interior).toBe(false);
      car.dispose();
    });
  }

  it('turns the wheels about their own axles so a rolling wheel moves forward (-z) at its top, for every model', async () => {
    for (const spec of PLAIN) {
      const t = await load(spec.file);
      const car = makeModelCar(three, t);
      car.group.updateMatrixWorld(true);
      // The tyre of a front wheel (the first mesh in its pivot).
      const wheel = (() => {
        let w: three.Object3D | null = null;
        car.group.traverse((o) => {
          if (o.userData.wheel === 'front' && !w) w = o.children[0]!;
        });
        return w as unknown as three.Object3D;
      })();
      const top = (): three.Vector3 => {
        car.group.updateMatrixWorld(true);
        return wheel.localToWorld(new three.Vector3(0, t.wheelR / t.scale, 0));
      };
      const centre = (): three.Vector3 => world(wheel);
      const before = top();
      const c0 = centre();
      car.animate(0.05, 10, 0, 0); // a short roll forward
      const after = top();
      expect(centre().distanceTo(c0), spec.file).toBeLessThan(1e-6); // it turns on the spot: the axle does not move
      expect(after.z, spec.file).toBeLessThan(before.z - 0.05); // the top of the wheel moves forward
      // Further on, the other way round for reversing.
      car.dispose();
    }
  });

  it('steers the front wheels only, to the right for a right turn, and rolls the body outward', async () => {
    const t = await load('suv');
    const car = makeModelCar(three, t);
    const fronts: three.Object3D[] = [];
    const rears: three.Object3D[] = [];
    car.group.traverse((o) => {
      if (o.userData.wheel === 'front') fronts.push(o);
      if (o.userData.wheel === 'rear') rears.push(o);
    });
    for (let i = 0; i < 60; i++) car.animate(1 / 60, 15, 0.6, 0);
    for (const f of fronts) expect(f.rotation.y).toBeLessThan(-0.1);
    for (const r of rears) expect(r.rotation.y).toBe(0);
    expect(car.cabin.rotation.z).toBeGreaterThan(0.02);
    for (let i = 0; i < 40; i++) car.animate(1 / 60, 10, 0, -9);
    expect(car.cabin.rotation.x).toBeLessThan(-0.02); // nose dips under braking
    car.dispose();
  });

  it('repaints one car without touching another or the loaded model', async () => {
    const t = await load('suv');
    const paintOf = (c: ReturnType<typeof makeModelCar>): string => {
      let hex = '';
      c.group.traverse((o) => {
        const m = o as three.Mesh;
        if (m.isMesh) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (mat.name === 'White') hex = (mat as three.MeshStandardMaterial).color.getHexString();
      });
      return hex;
    };
    const red = makeModelCar(three, t, '#ff0000');
    const blue = makeModelCar(three, t, '#0000ff');
    const none = makeModelCar(three, t);
    expect(paintOf(red)).toBe('ff0000');
    expect(paintOf(blue)).toBe('0000ff');
    expect(paintOf(none)).not.toBe('ff0000');
    expect(paintOf(none)).not.toBe('0000ff');
    // A taxi ignores a colour.
    const taxi = await load('taxi');
    const y = makeModelCar(three, taxi, '#00ff00');
    let yellow = false;
    y.group.traverse((o) => {
      const m = o as three.Mesh;
      if (m.isMesh && !Array.isArray(m.material) && m.material.name === 'Yellow') yellow = (m.material as three.MeshStandardMaterial).color.g > 0.3 && (m.material as three.MeshStandardMaterial).color.b < 0.2;
    });
    expect(yellow).toBe(true);
    for (const c of [red, blue, none, y]) c.dispose();
  });

  it('brightens the headlights in the dark and flares the brake lights when braking', async () => {
    const t = await load('sedan');
    const car = makeModelCar(three, t);
    const lights = (re: RegExp): three.MeshStandardMaterial[] => {
      const out: three.MeshStandardMaterial[] = [];
      car.group.traverse((o) => {
        const m = o as three.Mesh;
        if (m.isMesh && !Array.isArray(m.material) && re.test(m.material.name)) out.push(m.material as three.MeshStandardMaterial);
      });
      return out;
    };
    const heads = lights(/headlight/i);
    const tails = lights(/taillight/i);
    expect(heads.length).toBeGreaterThan(0);
    expect(tails.length).toBeGreaterThan(0);
    const day = heads[0]!.emissiveIntensity;
    car.setNight(1);
    expect(heads[0]!.emissiveIntensity).toBeGreaterThan(day + 2);
    const calm = tails[0]!.emissiveIntensity;
    for (let i = 0; i < 30; i++) car.animate(1 / 60, 10, 0, -8);
    expect(tails[0]!.emissiveIntensity).toBeGreaterThan(calm + 1);
    car.dispose();
  });
});
