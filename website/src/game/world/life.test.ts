import { describe, expect, it } from 'vitest';
import * as three from 'three';
import { pickNext, startAgent, stepAgent, type Seg } from './agents.js';
import { approach, makeCar, steerAngle } from './vehicles.js';
import { HAZE, SUN_DIRECTION, skyMaterial } from './atmosphere.js';
import { applyDetail, detailShader } from './detail.js';
import { stepFoot, WALK_SPEED, type Foot } from './physics.js';
import { wallColour } from './worldData.js';

const seg = (ax: number, az: number, bx: number, bz: number, width = 8, cls = 'secondary'): Seg => ({ a: [ax, az], b: [bx, bz], width, cls });

describe('inside the car', () => {
  /** Meshes you cannot see through. */
  const solids = (car: ReturnType<typeof makeCar>): three.Object3D[] => {
    const out: three.Object3D[] = [];
    car.group.traverse((o) => {
      const m = o as three.Mesh;
      if (m.isMesh && !(m.material as three.Material).transparent) out.push(m);
    });
    return out;
  };
  const fromSide = (car: ReturnType<typeof makeCar>, y: number, z: number): three.Intersection[] => {
    car.group.updateMatrixWorld(true);
    const rc = new three.Raycaster(new three.Vector3(4, y, z), new three.Vector3(-1, 0, 0), 0, 8);
    return rc.intersectObjects(solids(car), false);
  };

  it('has an open cabin: at head height a ray from the side meets nothing solid, but at door height it meets the door', () => {
    for (const kind of ['sedan', 'suv', 'taxi'] as const) {
      const car = makeCar(three, '#aa2222', kind);
      const [, hy, hz] = car.seat;
      // Head height beside the driver: only clear glass is in the way.
      expect(fromSide(car, hy + 0.7, hz), kind).toHaveLength(0);
      // Door height: the door panel is solid.
      const door = fromSide(car, 0.7, hz);
      expect(door.length, kind).toBeGreaterThan(0);
      expect(door[0]!.point.x, kind).toBeGreaterThan(0.8); // the near door, not something inside
      car.dispose();
    }
  });

  it('seats the driver on the left, inside the car, with the head under the roof and the hips above the floor', () => {
    for (const kind of ['sedan', 'suv'] as const) {
      const car = makeCar(three, '#223344', kind);
      const [x, y, z] = car.seat;
      expect(x).toBeLessThan(-0.3);
      const b = new three.Box3().setFromObject(car.group);
      expect(x).toBeGreaterThan(b.min.x);
      expect(z).toBeGreaterThan(b.min.z);
      expect(z).toBeLessThan(b.max.z);
      expect(y).toBeGreaterThan(0.38);
      expect(y + 0.95).toBeLessThan(b.max.y + 0.05); // sitting height up to the top of the head fits under the roof
      car.dispose();
    }
  });

  it('shows the windows as clear glass and turns the steering wheel with the road wheels', () => {
    const car = makeCar(three, '#223344', 'sedan');
    const clear: three.Mesh[] = [];
    car.group.traverse((o) => {
      const m = o as three.Mesh;
      if (m.isMesh && (m.material as three.Material).transparent) clear.push(m);
    });
    expect(clear.length).toBe(1);
    expect((clear[0]!.material as three.Material).opacity).toBeLessThan(0.5);
    expect((clear[0]!.material as three.Material).depthWrite).toBe(false);
    const torus = (() => {
      let t: three.Mesh | null = null;
      car.cabin.traverse((o) => {
        if ((o as three.Mesh).isMesh && (o as three.Mesh).geometry.type === 'TorusGeometry') t = o as three.Mesh;
      });
      return t as unknown as three.Mesh;
    })();
    expect(torus).toBeDefined();
    for (let i = 0; i < 60; i++) car.animate(1 / 60, 15, 0.6, 0);
    expect(torus.rotation.z).toBeLessThan(-0.3); // a right turn turns the wheel clockwise
    for (let i = 0; i < 120; i++) car.animate(1 / 60, 15, -0.6, 0);
    expect(torus.rotation.z).toBeGreaterThan(0.3);
    car.dispose();
  });

  it('puts a simple driver at the wheel for traffic, once, and takes it away again with the car', () => {
    const car = makeCar(three, '#223344', 'sedan');
    const before = car.cabin.children.length;
    car.addDummyDriver({ skin: '#8d5a3b', hair: '#111111', top: '#2f6b4f' });
    expect(car.cabin.children.length).toBe(before + 1);
    car.addDummyDriver({ skin: '#ffffff', hair: '#ffffff', top: '#ffffff' });
    expect(car.cabin.children.length).toBe(before + 1); // not a second one
    const driver = car.cabin.children[before]!;
    const box = new three.Box3().setFromObject(driver);
    const [sx, sy, sz] = car.seat;
    expect(driver.position.toArray()).toEqual([sx, sy, sz]); // hips on the seat
    expect(box.min.x).toBeLessThan(sx);
    expect(box.max.x).toBeGreaterThan(sx);
    const carBox = new three.Box3().setFromObject(car.group);
    expect(box.max.y).toBeLessThan(carBox.max.y); // under the roof
    expect(box.max.y - box.min.y).toBeGreaterThan(0.8); // a person-sized figure
    // Still the same size of car with a driver in it.
    expect(carBox.max.x - carBox.min.x).toBeLessThan(2.1);
    car.dispose();
  });
});

describe('walking with weight', () => {
  const open = { resolve: (x: number, z: number) => ({ x, z, hit: false }), inWater: () => false };

  it('gets up to speed over a fraction of a second, and stops over a shorter one', () => {
    const f: Foot = { x: 0, z: 0, vx: 0, vz: 0, heading: 0 };
    stepFoot(f, { dx: 1, dz: 0, run: false }, 1 / 60, open);
    expect(Math.hypot(f.vx, f.vz)).toBeGreaterThan(0.05);
    expect(Math.hypot(f.vx, f.vz)).toBeLessThan(WALK_SPEED * 0.5); // not instantly at full speed
    for (let i = 0; i < 60; i++) stepFoot(f, { dx: 1, dz: 0, run: false }, 1 / 60, open);
    expect(Math.hypot(f.vx, f.vz)).toBeGreaterThan(WALK_SPEED * 0.98);
    let frames = 0;
    while (Math.hypot(f.vx, f.vz) > 0.1 && frames < 200) {
      stepFoot(f, { dx: 0, dz: 0, run: false }, 1 / 60, open);
      frames++;
    }
    expect(frames).toBeLessThan(40);
    expect(frames).toBeGreaterThan(5);
  });

  it('turns to face a new direction over a few frames, the short way round, without snapping', () => {
    // Heading 0 is north. Walking east means turning to a quarter turn clockwise.
    const f: Foot = { x: 0, z: 0, vx: 0, vz: 0, heading: 0 };
    for (let i = 0; i < 30; i++) stepFoot(f, { dx: 1, dz: 0, run: false }, 1 / 60, open);
    expect(f.heading).toBeGreaterThan(0.3);
    expect(f.heading).toBeLessThan(Math.PI / 2 + 0.01);
    for (let i = 0; i < 120; i++) stepFoot(f, { dx: 1, dz: 0, run: false }, 1 / 60, open);
    expect(f.heading).toBeCloseTo(Math.PI / 2, 2);
    // From just left of north, turning to just right of it goes through north, not the long way round.
    const g: Foot = { x: 0, z: 0, vx: 0, vz: 0, heading: -3.0 };
    for (let i = 0; i < 6; i++) stepFoot(g, { dx: -0.1, dz: 1, run: false }, 1 / 60, open); // wants to face south-ish, heading about 3.04
    expect(g.heading).toBeLessThan(-3.0 + 0.0001); // went further negative (the short way through the date line), not back through zero
  });
});

describe('car motion', () => {
  const wheels = (g: three.Object3D): { steer: three.Object3D[]; spin: three.Object3D[]; shell: three.Object3D } => {
    // Children of the car: the shell (body) first, then four wheel pivots, each holding a spinning group.
    const kids = g.children;
    const pivots = kids.filter((c) => c.children.length > 0 && c.position.y > 0.3 && Math.abs(c.position.x) > 0.7);
    return { steer: pivots.filter((p) => p.position.z < 0), spin: pivots.map((p) => p.children[0]!), shell: kids[0]! };
  };

  it('works out how far the front wheels turn, to the right for a right turn, and less when fast', () => {
    expect(steerAngle(0, 10)).toBe(0);
    expect(steerAngle(0.5, 8)).toBeGreaterThan(0.1);
    expect(steerAngle(-0.5, 8)).toBeLessThan(-0.1);
    expect(steerAngle(0.5, 25)).toBeLessThan(steerAngle(0.5, 8));
    expect(steerAngle(4, 2)).toBeLessThanOrEqual(0.55); // limited to what a car can do
    expect(steerAngle(0.5, -8)).toBeLessThan(0); // in reverse the wheels turn the other way for the same yaw
  });

  it('eases towards a target at the same pace at any frame rate', () => {
    let fast = 0;
    for (let i = 0; i < 60; i++) fast = approach(fast, 1, 5, 1 / 60);
    let slow = 0;
    for (let i = 0; i < 10; i++) slow = approach(slow, 1, 5, 1 / 10);
    expect(fast).toBeCloseTo(slow, 3);
  });

  it('spins the wheels forward with speed, steers the front pair only, leans outward in a turn and dips under braking', () => {
    const car = makeCar(three, '#223344', 'sedan');
    const { steer, spin, shell } = wheels(car.group);
    expect(steer).toHaveLength(2);
    expect(spin).toHaveLength(4);
    for (let i = 0; i < 90; i++) car.animate(1 / 60, 10, 0, 0);
    // 1.5 s at 10 m/s on 0.36 m wheels: well over a full turn, and forward is a negative turn about x.
    expect(spin[0]!.rotation.x).toBeLessThan(-30);
    expect(Math.abs(steer[0]!.rotation.y)).toBeLessThan(0.01);
    // Turn right at speed: front wheels turn right (negative about y), the body leans left side down... outward (positive about z).
    for (let i = 0; i < 60; i++) car.animate(1 / 60, 15, 0.6, 0);
    expect(steer[0]!.rotation.y).toBeLessThan(-0.1);
    expect(steer[1]!.rotation.y).toBeCloseTo(steer[0]!.rotation.y);
    expect(shell.rotation.z).toBeGreaterThan(0.02);
    // Hard braking: the nose dips (negative about x) and settles back when the car stops braking.
    for (let i = 0; i < 40; i++) car.animate(1 / 60, 10, 0, -9);
    expect(shell.rotation.x).toBeLessThan(-0.02);
    for (let i = 0; i < 180; i++) car.animate(1 / 60, 10, 0, 0);
    expect(Math.abs(shell.rotation.x)).toBeLessThan(0.005);
    car.dispose();
  });
});

describe('photographed detail and wall colours', () => {
  it('reads colour tags in hex, short hex and plain names, and ignores anything else', () => {
    expect(wallColour('#D2B48C')).toBe('#d2b48c');
    expect(wallColour('#abc')).toBe('#aabbcc');
    expect(wallColour('Beige')).toBe('#d9c9a8');
    expect(wallColour('rgb(1,2,3)')).toBeUndefined();
    expect(wallColour('javascript:alert(1)')).toBeUndefined();
    expect(wallColour(5)).toBeUndefined();
    expect(wallColour(undefined)).toBeUndefined();
  });

  it('adds the detail picture to the right places in a surface shader, in the ground and wall modes', () => {
    const ground = detailShader('world');
    expect(ground.fragmentBody).toContain('vDetailWorld.xz * detailParams.x');
    expect(ground.fragmentBody).toContain('cameraPosition'); // fades with distance from the camera
    expect(ground.vertexBody).toContain('modelMatrix');
    const wall = detailShader('uv');
    expect(wall.fragmentBody).toContain('vMapUv * detailParams.x');
    // It multiplies the colour, centred on the picture's own average so overall brightness is unchanged.
    expect(wall.fragmentBody).toContain('/ detailMean');
    expect(wall.fragmentBody).toContain('diffuseColor.rgb *=');
  });

  it('hooks the detail into a material and shares one program per mode', () => {
    const tex = { texture: new three.Texture(), mean: [0.3, 0.3, 0.3] as [number, number, number] };
    const a = applyDetail(three, new three.MeshLambertMaterial(), { detail: tex, mode: 'world', scale: 0.4, strength: 0.8, near: 30, far: 150 });
    const b = applyDetail(three, new three.MeshLambertMaterial(), { detail: tex, mode: 'world', scale: 0.3, strength: 0.5, near: 30, far: 150 });
    const w = applyDetail(three, new three.MeshLambertMaterial(), { detail: tex, mode: 'uv', scale: 0.5, strength: 0.7, near: 60, far: 300 });
    expect(a.customProgramCacheKey!()).toBe(b.customProgramCacheKey!());
    expect(a.customProgramCacheKey!()).not.toBe(w.customProgramCacheKey!());
    // Running the hook rewrites the standard shader and registers the uniforms.
    const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <map_fragment>' };
    a.onBeforeCompile(shader as never, undefined as never);
    expect(shader.vertexShader).toContain('vDetailWorld =');
    expect(shader.fragmentShader).toContain('uniform sampler2D detailMap;');
    expect(Object.keys(shader.uniforms).sort()).toEqual(['detailMap', 'detailMean', 'detailParams']);
  });
});

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
