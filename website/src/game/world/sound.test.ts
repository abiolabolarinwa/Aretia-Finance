import { describe, expect, it } from 'vitest';
import { GEAR_SPEEDS, SoundEngine, engineHz, engineLevel, gearAt, saveMuted, savedMuted, squealLevel, stepInterval, windLevel, type SoundState } from './sound.js';

/** A stand-in for the browser's audio context that records what is made and what values are set. */
function fakeContext() {
  const created: Record<string, number> = {};
  const targets = new Map<unknown, number>();
  let closed = false;
  let resumed = 0;
  const param = (v = 0) => {
    const p = {
      value: v,
      setValueAtTime(x: number) {
        p.value = x;
        targets.set(p, x);
      },
      linearRampToValueAtTime(x: number) {
        targets.set(p, x);
      },
      exponentialRampToValueAtTime(x: number) {
        targets.set(p, x);
      },
      setTargetAtTime(x: number) {
        p.value = x;
        targets.set(p, x);
      },
    };
    return p;
  };
  const node = (kind: string) => {
    created[kind] = (created[kind] ?? 0) + 1;
    const n: Record<string, unknown> = {
      connect: () => n,
      start: () => undefined,
      stop: () => undefined,
      gain: param(1),
      frequency: param(440),
      Q: param(1),
      type: 'sine',
      loop: false,
      buffer: null,
    };
    return n;
  };
  const ctx = {
    currentTime: 0,
    sampleRate: 8000,
    state: 'suspended',
    destination: {},
    createGain: () => node('gain'),
    createOscillator: () => node('oscillator'),
    createBiquadFilter: () => node('filter'),
    createBufferSource: () => node('source'),
    createDynamicsCompressor: () => node('compressor'),
    createBuffer: (_c: number, len: number) => ({ getChannelData: () => new Float32Array(len) }),
    resume: async () => {
      resumed++;
      ctx.state = 'running';
    },
    close: async () => {
      closed = true;
    },
  };
  return { ctx: ctx as unknown as AudioContext, created, info: () => ({ closed, resumed }), raw: ctx };
}

const car = (over: Partial<SoundState> = {}): SoundState => ({ mode: 'car', speed: 15, throttle: 1, yaw: 0, braking: false, handbrake: false, night: 0, ...over });

describe('what the sound depends on', () => {
  it('changes gear as a car speeds up, so the engine note climbs and then drops at each shift', () => {
    expect(gearAt(0)).toEqual({ gear: 0, frac: 0 });
    expect(gearAt(3).gear).toBe(0);
    expect(gearAt(9).gear).toBe(1);
    expect(gearAt(15).gear).toBe(2);
    expect(gearAt(30).gear).toBe(GEAR_SPEEDS.length - 2);
    expect(gearAt(-5).frac).toBe(0);
    // Just before a shift is high, just after is low again.
    const before = engineHz(5.9, 0);
    const after = engineHz(6.1, 0);
    expect(before).toBeGreaterThan(after + 30);
    // Climbs within a gear and with the pedal down.
    expect(engineHz(5, 0)).toBeGreaterThan(engineHz(1, 0));
    expect(engineHz(3, 1)).toBeGreaterThan(engineHz(3, 0));
    expect(engineLevel(20, 1)).toBeGreaterThan(engineLevel(0, 0));
    expect(engineLevel(100, 5)).toBeLessThan(0.25);
  });

  it('squeals in hard turns at speed and under the handbrake, not when driving straight or slowly', () => {
    expect(squealLevel(20, 0, false, false)).toBe(0);
    expect(squealLevel(20, 1.0, false, false)).toBeGreaterThan(0.3); // sharp turn at speed
    expect(squealLevel(4, 1.0, false, false)).toBe(0); // same turn slowly: no squeal
    expect(squealLevel(15, 0, true, false)).toBeGreaterThan(0.6);
    expect(squealLevel(2, 0, true, false)).toBe(0); // handbrake while almost stopped
    expect(squealLevel(20, 0, false, true)).toBeGreaterThan(0.3);
    expect(squealLevel(30, 3, true, true)).toBeLessThanOrEqual(0.85);
    expect(squealLevel(20, -1.0, false, false)).toBe(squealLevel(20, 1.0, false, false)); // either direction
  });

  it('gets windier with speed, and steps faster for a run but with a longer stride', () => {
    expect(windLevel(5)).toBe(0);
    expect(windLevel(27)).toBeGreaterThan(windLevel(15));
    expect(stepInterval(0.2, false)).toBeNull();
    const walk = stepInterval(1.5, false)!;
    const run = stepInterval(5, true)!;
    expect(walk).toBeGreaterThan(0.4);
    expect(walk).toBeLessThan(0.7); // about 2 steps a second
    expect(run).toBeLessThan(walk); // quicker steps when running
    expect(stepInterval(3, false)!).toBeLessThan(stepInterval(1.5, false)!);
  });
});

describe('the sound engine', () => {
  it('stays silent and makes no audio context until the player has pressed something', () => {
    const f = fakeContext();
    const e = new SoundEngine({ createContext: () => f.ctx });
    e.update(car(), 0.016);
    e.footstep();
    expect(e.started).toBe(false);
    expect(Object.keys(f.created)).toHaveLength(0);
    e.unlock();
    expect(e.started).toBe(true);
    expect(f.info().resumed).toBe(1);
    expect(f.created.oscillator).toBeGreaterThanOrEqual(4); // engine x2, crickets and their flutter
  });

  it('survives a browser that refuses to make an audio context', () => {
    const e = new SoundEngine({ createContext: () => { throw new Error('no audio'); } });
    expect(() => e.unlock()).not.toThrow();
    expect(e.started).toBe(false);
    expect(() => e.update(car(), 0.016)).not.toThrow();
  });

  it('plays footsteps at walking pace, none when standing, and none when driving', () => {
    const f = fakeContext();
    const e = new SoundEngine({ createContext: () => f.ctx });
    e.unlock();
    const base = f.created.source ?? 0;
    for (let i = 0; i < 180; i++) e.update({ mode: 'walk', speed: 1.5, throttle: 0, yaw: 0, braking: false, handbrake: false, night: 0 }, 1 / 60);
    const steps = (f.created.source ?? 0) - base;
    expect(steps).toBeGreaterThanOrEqual(4); // three seconds at about two a second
    expect(steps).toBeLessThanOrEqual(8);
    const after = f.created.source ?? 0;
    for (let i = 0; i < 120; i++) e.update({ mode: 'walk', speed: 0, throttle: 0, yaw: 0, braking: false, handbrake: false, night: 0 }, 1 / 60);
    for (let i = 0; i < 120; i++) e.update(car(), 1 / 60);
    expect(f.created.source ?? 0).toBe(after);
  });

  it('one-off sounds work after unlock, and not before', () => {
    const f = fakeContext();
    const e = new SoundEngine({ createContext: () => f.ctx });
    e.thud();
    e.horn();
    e.chime();
    e.door();
    expect(Object.keys(f.created)).toHaveLength(0);
    e.unlock();
    const before = (f.created.oscillator ?? 0) + (f.created.source ?? 0);
    e.thud();
    e.door();
    e.horn();
    e.chime();
    expect((f.created.oscillator ?? 0) + (f.created.source ?? 0)).toBeGreaterThan(before + 6);
  });

  it('mutes and unmutes, and starts muted when asked', () => {
    const f = fakeContext();
    const e = new SoundEngine({ createContext: () => f.ctx, muted: true });
    expect(e.isMuted).toBe(true);
    e.unlock();
    e.setMuted(false);
    expect(e.isMuted).toBe(false);
    e.setMuted(true);
    expect(e.isMuted).toBe(true);
  });

  it('cleans up: stops and closes the audio context, and ignores updates after', () => {
    const f = fakeContext();
    const e = new SoundEngine({ createContext: () => f.ctx });
    e.unlock();
    e.dispose();
    expect(f.info().closed).toBe(true);
    expect(e.started).toBe(false);
    expect(() => e.update(car(), 0.016)).not.toThrow();
    e.unlock(); // a disposed engine does not wake up again
    expect(e.started).toBe(false);
  });

  it('remembers whether the player turned the sound off', () => {
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(savedMuted(s)).toBe(false);
    saveMuted(true, s);
    expect(savedMuted(s)).toBe(true);
    saveMuted(false, s);
    expect(savedMuted(s)).toBe(false);
    expect(savedMuted({ getItem: () => { throw new Error('blocked'); } })).toBe(false);
  });
});
