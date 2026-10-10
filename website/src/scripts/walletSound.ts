/**
 * The ringing sound for a notification, made in the browser with the Web Audio API: no audio file, nothing downloaded.
 * A rising pair of bell tones for a price rise, a falling pair for a drop, and a single soft double ring for anything
 * else, so the sound alone says which way the price went. Browsers only let a page make sound after the person has
 * touched it once; before that, play() quietly does nothing rather than throwing.
 */
import type { NotificationTone } from '../swings/account/notifications.js';

export interface Note {
  /** Pitch in hertz. */
  freq: number;
  /** Seconds after the sound starts. */
  at: number;
  /** How long the note rings for, in seconds. */
  length: number;
}

/** The notes of one ring, kept as plain data so the pattern can be checked without a sound card. */
export function ringNotes(tone: NotificationTone): Note[] {
  const [first, second] = tone === 'up' ? [784, 1175] : tone === 'down' ? [1175, 784] : [988, 988];
  return [
    { freq: first, at: 0, length: 0.55 },
    { freq: second, at: 0.2, length: 0.75 },
    // The ring repeats once so it is heard over other sounds.
    { freq: first, at: 0.9, length: 0.55 },
    { freq: second, at: 1.1, length: 0.75 },
  ];
}

/** The peak loudness: a clear ring, well below the loudest the speakers can do. */
const LEVEL = 0.18;

type AudioContextCtor = typeof AudioContext;

export function createRinger(win: object = window) {
  let ctx: AudioContext | null = null;

  function context(): AudioContext | null {
    if (ctx) return ctx;
    const host = win as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
    const Ctor: AudioContextCtor | undefined = host.AudioContext ?? host.webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      ctx = null;
    }
    return ctx;
  }

  /** Called from a click or key press: the first one is what lets the browser allow sound later. */
  function unlock(): void {
    const c = context();
    if (c && c.state === 'suspended') void c.resume().catch(() => undefined);
  }

  async function play(tone: NotificationTone = 'info'): Promise<boolean> {
    const c = context();
    if (!c) return false;
    if (c.state === 'suspended') await c.resume().catch(() => undefined);
    // Still suspended: the browser has not yet allowed sound on this page. Say nothing, ring nothing.
    if (c.state !== 'running') return false;
    const t0 = c.currentTime + 0.02;
    for (const n of ringNotes(tone)) {
      // A bell: a pure tone and a quieter tone an octave and a bit above, both dying away.
      for (const [mult, gain] of [[1, 1], [2.76, 0.28]] as const) {
        const osc = c.createOscillator();
        const amp = c.createGain();
        osc.type = 'sine';
        osc.frequency.value = n.freq * mult;
        amp.gain.setValueAtTime(0.0001, t0 + n.at);
        amp.gain.exponentialRampToValueAtTime(LEVEL * gain, t0 + n.at + 0.015);
        amp.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.length);
        osc.connect(amp).connect(c.destination);
        osc.start(t0 + n.at);
        osc.stop(t0 + n.at + n.length + 0.05);
      }
    }
    return true;
  }

  return { play, unlock };
}
