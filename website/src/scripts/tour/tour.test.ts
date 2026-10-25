import { describe, expect, it } from 'vitest';
import { createTourStorage } from './storage';
import { TourSession } from './session';
import { computePosition } from './placement';
import { WALLET_TOURS } from './walletTourConfigs';
import type { TourConfig } from './types';

const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `S${i}`, body: `B${i}` }));
const tour = (n = 4, version = 1): TourConfig => ({ id: 't', title: 'T', version, steps: steps(n) });

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

function session(t = tour(), usable: (i: number) => boolean = () => true, store = memStore()) {
  const storage = createTourStorage(() => store);
  return { s: new TourSession(t, storage, async (i) => usable(i)), storage, store };
}

describe('tour state machine', () => {
  it('starts on the first step and moves forward and back', async () => {
    const { s } = session();
    expect(await s.start()).toBe(true);
    expect(s.state).toEqual({ status: 'in-progress', index: 0 });
    await s.next();
    await s.next();
    expect(s.state.index).toBe(2);
    await s.back();
    expect(s.state.index).toBe(1);
  });

  it('stays on the first step when Back has nowhere to go', async () => {
    const { s } = session();
    await s.start();
    await s.back();
    expect(s.state).toEqual({ status: 'in-progress', index: 0 });
  });

  it('completes after the last step and remembers it', async () => {
    const { s, storage } = session(tour(2));
    await s.start();
    await s.next();
    await s.next();
    expect(s.state.status).toBe('completed');
    expect(storage.read(tour(2))?.status).toBe('completed');
    expect(s.isFresh()).toBe(false);
    expect(s.canResume()).toBe(false);
  });

  it('skip keeps the step so the tour can be resumed', async () => {
    const { s } = session();
    await s.start();
    await s.next();
    await s.next();
    s.skip();
    expect(s.state).toEqual({ status: 'skipped', index: 2 });
    expect(s.canResume()).toBe(true);
    const again = new TourSession(tour(), createTourStorage(() => null), async () => true);
    expect(again.canResume()).toBe(false);
    expect(await s.resume()).toBe(true);
    expect(s.state).toEqual({ status: 'in-progress', index: 2 });
  });

  it('resume works in a new session from the saved copy', async () => {
    const store = memStore();
    const a = session(tour(), () => true, store).s;
    await a.start();
    await a.next();
    a.skip();
    const b = session(tour(), () => true, store).s;
    expect(b.canResume()).toBe(true);
    await b.resume();
    expect(b.state.index).toBe(1);
  });

  it('start after completion begins again from the top', async () => {
    const { s } = session(tour(2));
    await s.start();
    await s.next();
    await s.next();
    await s.start();
    expect(s.state).toEqual({ status: 'in-progress', index: 0 });
  });

  it('ignores a step that finishes loading after the person skipped', async () => {
    let release: (v: boolean) => void = () => {};
    const store = memStore();
    const s = new TourSession(tour(), createTourStorage(() => store), (i) => (i === 0 ? Promise.resolve(true) : new Promise<boolean>((r) => (release = r))));
    await s.start();
    const pending = s.next();
    s.skip();
    release(true);
    await pending;
    expect(s.state.status).toBe('skipped');
    expect(s.state.index).toBe(0);
  });
});

describe('versioning', () => {
  it('shows a tour again after its version is bumped', async () => {
    const store = memStore();
    const v1 = session(tour(2, 1), () => true, store).s;
    await v1.start();
    await v1.next();
    await v1.next();
    expect(v1.isFresh()).toBe(false);
    const v2 = session(tour(2, 2), () => true, store).s;
    expect(v2.isFresh()).toBe(true);
    expect(v2.canResume()).toBe(false);
  });
});

describe('storage', () => {
  it('works from memory when storage throws', async () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const storage = createTourStorage(() => broken);
    const s = new TourSession(tour(), storage, async () => true);
    expect(s.isFresh()).toBe(true);
    await s.start();
    await s.next();
    s.skip();
    expect(s.canResume()).toBe(true);
    expect(storage.read(tour())).toEqual({ version: 1, status: 'skipped', step: 1 });
  });

  it('works when localStorage does not exist at all', () => {
    const storage = createTourStorage(() => null);
    storage.write('t', { version: 1, status: 'completed', step: 3 });
    expect(storage.read(tour())?.status).toBe('completed');
    storage.clear('t');
    expect(storage.read(tour())).toBeNull();
  });

  it('survives corrupt saved data', () => {
    const store = memStore();
    store.setItem('aretia-tour:t', '{nope');
    expect(createTourStorage(() => store).read(tour())).toBeNull();
    store.setItem('aretia-tour:t', JSON.stringify({ version: 1, status: 'weird', step: 1 }));
    expect(createTourStorage(() => store).read(tour())).toBeNull();
  });

  it('persists across storage instances', () => {
    const store = memStore();
    createTourStorage(() => store).write('t', { version: 1, status: 'in-progress', step: 2 });
    expect(createTourStorage(() => store).read(tour())).toEqual({ version: 1, status: 'in-progress', step: 2 });
  });
});

describe('missing targets', () => {
  it('skips steps that cannot be shown, going forward', async () => {
    const { s } = session(tour(5), (i) => i !== 0 && i !== 2);
    await s.start();
    expect(s.state.index).toBe(1);
    await s.next();
    expect(s.state.index).toBe(3);
  });

  it('skips steps that cannot be shown, going back', async () => {
    const { s } = session(tour(5), (i) => i !== 2);
    await s.start();
    await s.next();
    await s.next();
    expect(s.state.index).toBe(3);
    await s.back();
    expect(s.state.index).toBe(1);
  });

  it('completes when every later step is missing', async () => {
    const { s } = session(tour(3), (i) => i === 0);
    await s.start();
    await s.next();
    expect(s.state.status).toBe('completed');
  });

  it('does not start, and saves nothing, when no step can be shown', async () => {
    const { s, storage } = session(tour(3), () => false);
    expect(await s.start()).toBe(false);
    expect(s.state.status).toBe('idle');
    expect(storage.read(tour())).toBeNull();
  });

  it('treats a throwing prepare as a missing step', async () => {
    const s = new TourSession(tour(3), createTourStorage(() => null), async (i) => {
      if (i === 0) throw new Error('boom');
      return true;
    });
    await s.start();
    expect(s.state.index).toBe(1);
  });
});

describe('tooltip placement', () => {
  const view = { width: 1000, height: 700 };
  const tip = { width: 320, height: 160 };
  const rect = (top: number, left: number, width = 100, height = 40) => ({ top, left, width, height });

  it('goes below the target when there is room', () => {
    const p = computePosition(rect(100, 400), tip, view, 'bottom');
    expect(p.placement).toBe('bottom');
    expect(p.top).toBe(152);
  });

  it('flips above when there is no room below', () => {
    const p = computePosition(rect(600, 400), tip, view, 'bottom');
    expect(p.placement).toBe('top');
  });

  it('flips to the right when the target is at the left edge and the preferred side is left', () => {
    expect(computePosition(rect(300, 10), tip, view, 'left').placement).toBe('right');
  });

  it('stays inside the viewport', () => {
    const p = computePosition(rect(100, 950, 40, 40), tip, view, 'bottom');
    expect(p.left + tip.width).toBeLessThanOrEqual(view.width);
    expect(p.left).toBeGreaterThanOrEqual(0);
  });

  it('centres a step with no target', () => {
    const p = computePosition(null, tip, view);
    expect(p.placement).toBe('center');
    expect(p.left).toBe(340);
  });

  it('uses a bottom sheet at phone width', () => {
    const p = computePosition(rect(100, 20), { width: 300, height: 180 }, { width: 375, height: 800 });
    expect(p.placement).toBe('sheet');
    expect(p.top).toBe(800 - 180 - 12);
  });
});

describe('wallet tour configs', () => {
  it('has unique ids and complete steps', () => {
    const ids = WALLET_TOURS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of WALLET_TOURS) {
      expect(t.steps.length).toBeGreaterThan(0);
      for (const st of t.steps) {
        expect(st.title.length).toBeGreaterThan(0);
        expect(st.body.length).toBeGreaterThan(0);
      }
    }
  });

  it('includes the feature tours that were asked for', () => {
    const ids = WALLET_TOURS.map((t) => t.id);
    for (const id of ['wallet-welcome', 'tour-swap', 'tour-markets', 'tour-launch', 'tour-pay', 'tour-launchbox']) expect(ids).toContain(id);
  });
});
