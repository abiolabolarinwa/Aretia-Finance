/**
 * Sound for the roaming city, made live in the browser with the Web Audio API (so there are no audio files to download or license):
 * an engine whose pitch climbs through gears, tyre squeal in hard turns and under the handbrake, wind at speed, footsteps, a city hum
 * with crickets at night, a horn, a crash thud, a door and a chime for a found treasure.
 *
 * Browsers only allow sound after the player has pressed a key or clicked, so the audio context is made on the first such action.
 * The mapping from what is happening to what is heard is plain arithmetic, kept in separate functions so it can be tested.
 */

export type SoundMode = 'walk' | 'run' | 'car' | 'boat';

export interface SoundState {
  mode: SoundMode;
  /** Speed in m/s, always positive. */
  speed: number;
  /** Pedal, 0 to 1. */
  throttle: number;
  /** How hard the vehicle is turning, rad/s (either direction as a positive number). */
  yaw: number;
  braking: boolean;
  handbrake: boolean;
  /** How dark it is, 0 to 1. */
  night: number;
  /** How hard it rains and how windy it is, 0 to 1 (none when left out). */
  rain?: number;
  wind?: number;
}

/** The loudness of the rain's hiss and of its low rumble, for how hard it rains. A downpour is much louder than a drizzle. */
export const rainHiss = (rain: number): number => clamp(rain) ** 1.3 * 0.1;
export const rainRumble = (rain: number): number => smooth(0.5, 1, rain) * 0.05;
/** Extra wind noise from the weather (on top of the wind of moving fast). */
export const weatherWind = (wind: number): number => clamp(wind) * 0.09;

const clamp = (v: number, a = 0, b = 1): number => Math.max(a, Math.min(b, v));
const smooth = (a: number, b: number, v: number): number => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** The speeds (m/s) where a car shifts up, so its engine note climbs and drops like a car with gears. */
export const GEAR_SPEEDS = [0, 6, 12.5, 19, 27.5];

/** Which gear (0-based) at a speed, and how far through that gear's range (0 to 1). */
export function gearAt(speed: number): { gear: number; frac: number } {
  const s = Math.max(0, speed);
  for (let g = 0; g < GEAR_SPEEDS.length - 1; g++) {
    if (s < GEAR_SPEEDS[g + 1]!) return { gear: g, frac: (s - GEAR_SPEEDS[g]!) / (GEAR_SPEEDS[g + 1]! - GEAR_SPEEDS[g]!) };
  }
  return { gear: GEAR_SPEEDS.length - 2, frac: 1 };
}

/** The engine's note in Hz: low at idle, rising within each gear and dropping a little at each shift. */
export function engineHz(speed: number, throttle: number): number {
  const { frac } = gearAt(speed);
  return 42 + frac * 70 + clamp(throttle) * 12;
}

export const engineLevel = (speed: number, throttle: number): number => 0.07 + clamp(throttle) * 0.09 + clamp(speed / 27) * 0.05;

/** How loud the tyres squeal: in hard turns at speed, with the handbrake on while moving, and when braking hard from speed. */
export function squealLevel(speed: number, yaw: number, handbrake: boolean, braking: boolean): number {
  const lateral = Math.abs(yaw) * speed;
  const turn = smooth(6, 15, lateral) * 0.55;
  const hand = handbrake && speed > 5 ? 0.7 : 0;
  const brake = braking && speed > 13 ? 0.4 : 0;
  return clamp(turn + hand + brake, 0, 0.85);
}

export const windLevel = (speed: number): number => smooth(8, 28, speed) * 0.22;

/** Seconds between footsteps at a speed (a longer stride the faster the person goes), or null when standing still. */
export function stepInterval(speed: number, running: boolean): number | null {
  if (speed < 0.5) return null;
  const stride = running ? 1.6 : 0.85;
  return stride / speed;
}

export interface SoundOptions {
  /** For tests: make the audio context. Defaults to the browser's. */
  createContext?: () => AudioContext;
  muted?: boolean;
}

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted: boolean;
  private nodes: {
    engineGain: GainNode;
    engineA: OscillatorNode;
    engineB: OscillatorNode;
    engineFilter: BiquadFilterNode;
    squeal: GainNode;
    wind: GainNode;
    hum: GainNode;
    crickets: GainNode;
    rain: GainNode;
    rumble: GainNode;
  } | null = null;
  private noise: AudioBuffer | null = null;
  private stepClock = 0;
  private disposed = false;
  private readonly make: () => AudioContext;

  constructor(o: SoundOptions = {}) {
    this.muted = o.muted ?? false;
    this.make =
      o.createContext ??
      (() => {
        const C = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        return new C();
      });
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Whether sound has been switched on yet (after the first key press or click). */
  get started(): boolean {
    return this.ctx !== null;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.04);
  }

  /** Makes the audio context if it does not exist and wakes it. Call from a key press or click. */
  unlock(): void {
    if (this.disposed) return;
    if (!this.ctx) {
      try {
        this.ctx = this.make();
      } catch {
        return;
      }
      this.build(this.ctx);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noise) return this.noise;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    return buf;
  }

  private loop(ctx: AudioContext, filterType: BiquadFilterType, freq: number, q: number, out: AudioNode): GainNode {
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f);
    f.connect(g);
    g.connect(out);
    src.start();
    return g;
  }

  private build(ctx: AudioContext): void {
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : 0.8;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp);
    comp.connect(ctx.destination);
    this.master = master;

    // Engine: a rough saw and a square an octave down, through a filter that opens as the revs rise.
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    const engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 400;
    const engineA = ctx.createOscillator();
    engineA.type = 'sawtooth';
    const engineB = ctx.createOscillator();
    engineB.type = 'square';
    engineA.frequency.value = 42;
    engineB.frequency.value = 21;
    engineA.connect(engineFilter);
    engineB.connect(engineFilter);
    engineFilter.connect(engineGain);
    engineGain.connect(master);
    engineA.start();
    engineB.start();

    const squeal = this.loop(ctx, 'bandpass', 1900, 9, master);
    const wind = this.loop(ctx, 'lowpass', 700, 0.5, master);
    const hum = this.loop(ctx, 'lowpass', 240, 0.4, master);
    // Rain: a bright hiss of drops, and a low rumble underneath that only a downpour brings.
    const rain = this.loop(ctx, 'bandpass', 4200, 0.35, master);
    const rumble = this.loop(ctx, 'lowpass', 520, 0.5, master);

    // Crickets: a high tone that chirps, switched on only at night.
    const cricket = ctx.createOscillator();
    cricket.type = 'sine';
    cricket.frequency.value = 4300;
    const chirp = ctx.createGain();
    chirp.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 13;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.5;
    lfo.connect(lfoDepth);
    lfoDepth.connect(chirp.gain);
    const crickets = ctx.createGain();
    crickets.gain.value = 0;
    cricket.connect(chirp);
    chirp.connect(crickets);
    crickets.connect(master);
    cricket.start();
    lfo.start();

    this.nodes = { engineGain, engineA, engineB, engineFilter, squeal, wind, hum, crickets, rain, rumble };
  }

  /** Call every frame. */
  update(s: SoundState, dt: number): void {
    const ctx = this.ctx;
    const n = this.nodes;
    if (!ctx || !n || this.disposed) return;
    const t = ctx.currentTime;
    const driving = s.mode === 'car' || s.mode === 'boat';
    if (driving) {
      const boat = s.mode === 'boat';
      const hz = boat ? 30 + clamp(s.speed / 16) * 25 : engineHz(s.speed, s.throttle);
      n.engineA.frequency.setTargetAtTime(hz, t, 0.06);
      n.engineB.frequency.setTargetAtTime(hz / 2, t, 0.06);
      n.engineFilter.frequency.setTargetAtTime(260 + hz * (boat ? 5 : 11), t, 0.08);
      n.engineGain.gain.setTargetAtTime(boat ? 0.09 + clamp(s.speed / 16) * 0.08 : engineLevel(s.speed, s.throttle), t, 0.06);
      n.squeal.gain.setTargetAtTime(boat ? 0 : squealLevel(s.speed, s.yaw, s.handbrake, s.braking), t, 0.05);
      n.wind.gain.setTargetAtTime(windLevel(s.speed) + weatherWind(s.wind ?? 0), t, 0.12);
    } else {
      n.engineGain.gain.setTargetAtTime(0, t, 0.08);
      n.squeal.gain.setTargetAtTime(0, t, 0.05);
      n.wind.gain.setTargetAtTime(windLevel(s.speed * 2) + weatherWind(s.wind ?? 0), t, 0.12);
    }
    const wet = s.rain ?? 0;
    n.rain.gain.setTargetAtTime(rainHiss(wet), t, 0.4);
    n.rumble.gain.setTargetAtTime(rainRumble(wet), t, 0.6);
    n.hum.gain.setTargetAtTime(0.045 * (1 - 0.4 * s.night) * (1 - 0.5 * clamp(wet)), t, 0.5);
    // Crickets stop when it rains.
    n.crickets.gain.setTargetAtTime(0.011 * s.night * (1 - clamp(wet * 1.6)), t, 0.8);
    // Footsteps, on foot only.
    if (!driving) {
      const every = stepInterval(s.speed, s.mode === 'run');
      if (every === null) this.stepClock = 0;
      else {
        this.stepClock += dt;
        if (this.stepClock >= every) {
          this.stepClock -= every;
          this.footstep();
        }
      }
    } else this.stepClock = 0;
  }

  private burst(ctx: AudioContext, freq: number, q: number, level: number, seconds: number, at?: number, type: BiquadFilterType = 'bandpass'): void {
    if (!this.master) return;
    const t = at ?? ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + seconds + 0.02);
  }

  private tone(ctx: AudioContext, hz: number, type: OscillatorType, level: number, start: number, seconds: number): void {
    if (!this.master) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(level, start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
    o.connect(g);
    g.connect(this.master);
    o.start(start);
    o.stop(start + seconds + 0.05);
  }

  footstep(): void {
    if (!this.ctx) return;
    // A little different each time, so it does not sound like a loop.
    this.burst(this.ctx, 700 + Math.random() * 900, 1.2, 0.1 + Math.random() * 0.04, 0.07);
  }

  /** A crash: a low thump with a crunch. */
  thud(): void {
    if (!this.ctx) return;
    this.burst(this.ctx, 140, 0.8, 0.55, 0.35);
    this.burst(this.ctx, 1200, 0.6, 0.25, 0.18);
  }

  /** A peal of thunder that reaches the player `delay` seconds from now (sound is slower than the flash), louder for a closer strike. */
  thunder(power: number, delay: number): void {
    if (!this.ctx) return;
    const at = this.ctx.currentTime + Math.max(0, delay);
    const p = clamp(power);
    this.burst(this.ctx, 90, 0.7, 0.9 * p, 2.8, at, 'lowpass'); // the deep crack and roll
    this.burst(this.ctx, 420, 0.5, 0.35 * p, 1.3, at + 0.05, 'lowpass');
    this.burst(this.ctx, 140, 0.6, 0.5 * p, 3.6, at + 1.1, 'lowpass'); // the rumble that follows
  }

  /** Getting in or out of a vehicle. */
  door(): void {
    if (!this.ctx) return;
    this.burst(this.ctx, 260, 1.5, 0.3, 0.1);
    this.burst(this.ctx, 1500, 3, 0.12, 0.05);
  }

  horn(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(this.ctx, 392, 'square', 0.09, t, 0.35);
    this.tone(this.ctx, 494, 'square', 0.08, t, 0.35);
  }

  /** A rising chime for a found treasure. */
  chime(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((hz, i) => this.tone(this.ctx!, hz, 'triangle', 0.14, t + i * 0.09, 0.5));
  }

  dispose(): void {
    this.disposed = true;
    const n = this.nodes;
    if (n) {
      for (const o of [n.engineA, n.engineB]) {
        try {
          o.stop();
        } catch {
          // already stopped
        }
      }
    }
    this.nodes = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
  }
}

const KEY = 'ucs-sound';
/** Whether the player turned the sound off last time (it is on the first time). */
export function savedMuted(storage: Pick<Storage, 'getItem'> | null = safeStorage()): boolean {
  try {
    return storage?.getItem(KEY) === 'off';
  } catch {
    return false;
  }
}
export function saveMuted(muted: boolean, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, muted ? 'off' : 'on');
  } catch {
    // not remembered
  }
}
function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
