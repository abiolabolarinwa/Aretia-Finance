import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GAP_MS, holdLowPriority, resetGeckoGap, setGeckoGap, spaced } from './geckoGate.js';

/** A clock the test moves by hand: sleeping moves it forward, so no real time passes. */
function clock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

describe('the GeckoTerminal gate', () => {
  beforeEach(() => setGeckoGap(GAP_MS));
  afterEach(resetGeckoGap);

  it('starts the first read at once, and holds the next back until the gap has passed', async () => {
    const c = clock();
    const starts: number[] = [];
    const read = () => spaced(async () => starts.push(c.now()), c);
    await read();
    await read();
    await read();
    expect(starts[0]).toBe(1_000_000);
    expect(starts[1]! - starts[0]!).toBe(GAP_MS);
    expect(starts[2]! - starts[1]!).toBe(GAP_MS);
    // Only the second and third waited.
    expect(c.sleeps).toEqual([GAP_MS, GAP_MS]);
  });

  it('does not wait at all when the last read was long enough ago', async () => {
    const c = clock();
    await spaced(async () => 1, c);
    c.advance(5_000);
    await spaced(async () => 2, c);
    expect(c.sleeps).toEqual([]);
  });

  it('only waits for what is left of the gap', async () => {
    const c = clock();
    await spaced(async () => 1, c);
    c.advance(800);
    await spaced(async () => 2, c);
    expect(c.sleeps).toEqual([GAP_MS - 800]);
  });

  it('starts reads in the order they were asked for, even when they are all asked at once', async () => {
    const c = clock();
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4].map((n) => spaced(async () => order.push(n), c)));
    expect(order).toEqual([1, 2, 3, 4]);
    expect(c.sleeps).toHaveLength(3);
  });

  it('lets a more important read go ahead of waiting ones, so the chart is not held up behind the table', async () => {
    const c = clock();
    const order: string[] = [];
    // The first read starts at once; while the next ones wait, a chart read is asked for after two table reads.
    const first = spaced(async () => order.push('table-1'), c);
    const t2 = spaced(async () => order.push('table-2'), c);
    const t3 = spaced(async () => order.push('table-3'), c);
    const chart = spaced(async () => order.push('chart'), { ...c, priority: 1 });
    await Promise.all([first, t2, t3, chart]);
    expect(order).toEqual(['table-1', 'chart', 'table-2', 'table-3']);
  });

  it('holds lower-priority reads back while a chart is opening, but not the chart itself', async () => {
    const c = clock();
    holdLowPriority(4_000, c.now);
    const starts: Record<string, number> = {};
    await spaced(async () => (starts.table = c.now()), c);
    // The table waited out the hold; nothing had been read before it, so that is the only wait.
    expect(starts.table! - 1_000_000).toBe(4_000);
    setGeckoGap(GAP_MS);
    holdLowPriority(4_000, c.now);
    const t0 = c.now();
    await spaced(async () => (starts.chart = c.now()), { ...c, priority: 1 });
    expect(starts.chart).toBe(t0);
  });

  it('lets a chart read cut the hold short while the table read is waiting for it', async () => {
    const c = clock();
    holdLowPriority(4_000, c.now);
    // A sleep that only ends when released, so the table read is still waiting when the chart read arrives.
    let release: () => void = () => undefined;
    const slow = () => new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    const table = spaced(async () => order.push('table'), { now: c.now, sleep: slow });
    await Promise.resolve();
    const chart = spaced(async () => order.push('chart'), { now: c.now, sleep: slow, priority: 1 });
    await chart;
    expect(order).toEqual(['chart']);
    release();
    await table;
    expect(order).toEqual(['chart', 'table']);
  });

  it('keeps the order of reads that share a priority', async () => {
    const c = clock();
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4, 5].map((n) => spaced(async () => order.push(n), { ...c, priority: 1 })));
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it('is not held up by a read that fails, and passes the failure on to whoever asked', async () => {
    const c = clock();
    const failing = spaced(async () => {
      throw new Error('offline');
    }, c);
    const next = spaced(async () => 'fine', c);
    await expect(failing).rejects.toThrow('offline');
    expect(await next).toBe('fine');
  });

  it('can be switched off, for tests and for a quiet page', async () => {
    setGeckoGap(0);
    const c = clock();
    await Promise.all([spaced(async () => 1, c), spaced(async () => 2, c), spaced(async () => 3, c)]);
    expect(c.sleeps).toEqual([]);
  });
});
