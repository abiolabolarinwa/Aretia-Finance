import { describe, expect, it } from 'vitest';
import * as three from 'three';
import { RAIN_BOX, RAIN_COUNT, RAIN_HEIGHT, makeRain, rainGeometry } from './rain.js';
import { SoundEngine, rainHiss, rainRumble, weatherWind } from './sound.js';

describe('the rain', () => {
  it('is two points per streak, spread through the box, each pair sharing one seed and marked as top and bottom', () => {
    const g = rainGeometry(three, 500, (() => { let s = 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })());
    expect(g.getAttribute('position').count).toBe(1000);
    const pos = g.getAttribute('position');
    const end = g.getAttribute('aEnd');
    const seed = g.getAttribute('aSeed');
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < 500; i++) {
      const a = i * 2;
      const b = a + 1;
      expect([end.getX(a), end.getX(b)]).toEqual([0, 1]);
      expect(seed.getX(a)).toBe(seed.getX(b));
      expect([pos.getX(a), pos.getY(a), pos.getZ(a)]).toEqual([pos.getX(b), pos.getY(b), pos.getZ(b)]);
      expect(pos.getX(a)).toBeGreaterThanOrEqual(0);
      expect(pos.getX(a)).toBeLessThan(RAIN_BOX);
      expect(pos.getY(a)).toBeLessThan(RAIN_HEIGHT);
      expect(seed.getX(a)).toBeGreaterThanOrEqual(0);
      expect(seed.getX(a)).toBeLessThan(1);
      maxX = Math.max(maxX, pos.getX(a));
      maxY = Math.max(maxY, pos.getY(a));
    }
    expect(maxX).toBeGreaterThan(RAIN_BOX * 0.9); // actually spread out, not bunched
    expect(maxY).toBeGreaterThan(RAIN_HEIGHT * 0.9);
  });

  it('draws nothing at all when it is dry, and follows the camera and the intensity when it rains', () => {
    const rain = makeRain(three);
    expect(rain.object.visible).toBe(false);
    expect(rain.object.geometry.getAttribute('position').count).toBe(RAIN_COUNT * 2);
    expect(rain.object.frustumCulled).toBe(false);
    const cam = new three.Vector3(120, 3, -40);
    rain.update(12.5, cam, 0.65, 0.3, 0.1);
    const u = (rain.object.material as three.ShaderMaterial).uniforms;
    expect(rain.object.visible).toBe(true);
    expect(u.uTime!.value).toBe(12.5);
    expect(u.uCam!.value.toArray()).toEqual([120, 3, -40]);
    expect(u.uIntensity!.value).toBe(0.65);
    expect(u.uWind!.value.toArray().map((v: number) => +v.toFixed(2))).toEqual([0.3, 0.1]);
    cam.set(0, 0, 0);
    expect(u.uCam!.value.x).toBe(120); // a copy, not the camera itself
    rain.update(13, cam, 7, 0, 0);
    expect(u.uIntensity!.value).toBe(1); // capped
    rain.update(14, cam, 0, 0, 0);
    expect(rain.object.visible).toBe(false);
    rain.dispose();
  });

  it('is drawn by a shader that wraps the streaks round the camera, hides the ones above the intensity and fades with distance', () => {
    const m = makeRain(three).object.material as three.ShaderMaterial;
    expect(m.vertexShader).toContain('mod(position.xz - uCam.xz');
    expect(m.vertexShader).toContain('step(aSeed, uIntensity)');
    expect(m.vertexShader).toContain('smoothstep(24.0, 35.0');
    expect(m.vertexShader).toContain(`BOX = ${RAIN_BOX.toFixed(1)}`);
    expect(m.transparent).toBe(true);
    expect(m.depthWrite).toBe(false);
  });
});

describe('the sound of the weather', () => {
  it('gets louder with the rain: a drizzle is quiet, a downpour much louder, and the low rumble only comes with heavy rain', () => {
    expect(rainHiss(0)).toBe(0);
    expect(rainHiss(0.3)).toBeLessThan(rainHiss(0.65));
    expect(rainHiss(1)).toBeGreaterThan(rainHiss(0.65) * 1.4);
    expect(rainHiss(5)).toBe(rainHiss(1)); // capped
    expect(rainRumble(0.4)).toBe(0);
    expect(rainRumble(1)).toBeGreaterThan(0.04);
    expect(weatherWind(0)).toBe(0);
    expect(weatherWind(0.9)).toBeGreaterThan(weatherWind(0.3));
  });

  it('plays thunder as three layered sounds, scheduled after the delay, and stays silent before sound is unlocked', () => {
    const times: number[] = [];
    let sources = 0;
    const param = () => ({ value: 0, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined, setTargetAtTime: () => undefined });
    const node = (kind: string) => {
      if (kind === 'source') sources++;
      return { connect: () => undefined, start: (t?: number) => { if (kind === 'source' && t !== undefined) times.push(t); }, stop: () => undefined, gain: param(), frequency: param(), Q: param(), type: 'sine', loop: false, buffer: null };
    };
    const ctx = {
      currentTime: 10,
      sampleRate: 8000,
      state: 'running',
      destination: {},
      createGain: () => node('gain'),
      createOscillator: () => node('oscillator'),
      createBiquadFilter: () => node('filter'),
      createBufferSource: () => node('source'),
      createDynamicsCompressor: () => node('compressor'),
      createBuffer: (_c: number, len: number) => ({ getChannelData: () => new Float32Array(len) }),
      resume: async () => undefined,
      close: async () => undefined,
    } as unknown as AudioContext;
    const e = new SoundEngine({ createContext: () => ctx });
    e.thunder(1, 2); // before unlock: nothing
    expect(sources).toBe(0);
    e.unlock();
    const base = sources;
    times.length = 0;
    e.thunder(0.8, 3);
    expect(sources - base).toBe(3);
    // Three scheduled starts: the first three seconds from now (10 + 3), the next just after, the tail about a second later.
    expect(times).toHaveLength(3);
    expect(times[0]).toBeCloseTo(13);
    expect(times[1]).toBeCloseTo(13.05);
    expect(times[2]).toBeCloseTo(14.1);
    e.dispose();
  });
});
