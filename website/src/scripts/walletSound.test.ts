import { describe, expect, it } from 'vitest';
import { createRinger, ringNotes } from './walletSound.js';

describe('ringNotes', () => {
  it('rises for a price rise and falls for a drop, so the sound says which way it moved', () => {
    const up = ringNotes('up');
    const down = ringNotes('down');
    expect(up[1].freq).toBeGreaterThan(up[0].freq);
    expect(down[1].freq).toBeLessThan(down[0].freq);
  });

  it('rings twice and is over within two and a half seconds', () => {
    for (const tone of ['up', 'down', 'info'] as const) {
      const notes = ringNotes(tone);
      expect(notes).toHaveLength(4);
      expect(Math.max(...notes.map((n) => n.at + n.length))).toBeLessThan(2.5);
    }
  });
});

describe('createRinger', () => {
  it('does nothing, and does not throw, where the browser has no audio', async () => {
    const ringer = createRinger({});
    expect(await ringer.play('up')).toBe(false);
    expect(() => ringer.unlock()).not.toThrow();
  });

  it('stays silent while the browser has not yet allowed sound', async () => {
    let created = 0;
    class Blocked {
      state = 'suspended';
      currentTime = 0;
      constructor() {
        created++;
      }
      resume(): Promise<void> {
        return Promise.resolve();
      }
    }
    const ringer = createRinger({ AudioContext: Blocked });
    expect(await ringer.play('down')).toBe(false);
    expect(created).toBe(1);
  });
});
