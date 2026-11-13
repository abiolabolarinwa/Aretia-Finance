import { describe, expect, it } from 'vitest';
import { createLiveStream, MAX_STREAM_KEYS, parseUpdates, streamUrl, type EventSourceLike } from './walletLiveStream';

const A = 'solana:' + 'A'.repeat(44);
const B = 'bnb:0x' + 'b'.repeat(40);
const upd = (key: string) => ({ key, at: 1, p_usd: 1, chg: null, buys: null, sells: null, vol: null, ro: null, liquidity_usd: 1 });

class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  closed = false;
  private listeners = new Map<string, (e: { data: string }) => void>();
  constructor(public url: string) {}
  addEventListener(t: string, fn: (e: { data: string }) => void): void {
    this.listeners.set(t, fn);
  }
  close(): void {
    this.closed = true;
  }
  emit(data: string): void {
    this.listeners.get('u')?.({ data });
  }
}

/** A stream wired to fake timers and a fake connection, so the tests choose when time passes. */
function rig(hiddenNow = false) {
  const sources: FakeSource[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const got: unknown[][] = [];
  const states: boolean[] = [];
  let hidden = hiddenNow;
  const stream = createLiveStream({
    url: 'https://data.example/stream',
    onUpdates: (u) => got.push(u),
    onState: (s) => states.push(s),
    open: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
    isHidden: () => hidden,
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      (t as { live: boolean }).live = false;
    },
  });
  const fire = (): void => {
    const t = [...timers].reverse().find((x) => x.live);
    if (t) {
      t.live = false;
      t.fn();
    }
  };
  return { stream, sources, got, states, fire, setHidden: (v: boolean) => (hidden = v), timers };
}

describe('parseUpdates', () => {
  it('keeps only updates about pools that were asked for', () => {
    const out = parseUpdates(JSON.stringify([upd(A), upd(B), upd('bnb:0x' + 'c'.repeat(40))]), new Set([A, B]));
    expect(out.map((u) => u.key)).toEqual([A, B]);
  });
  it('ignores anything that is not a list of updates', () => {
    expect(parseUpdates('nope', new Set([A]))).toEqual([]);
    expect(parseUpdates('{"key":"x"}', new Set([A]))).toEqual([]);
    expect(parseUpdates(JSON.stringify([null, 5, { key: A }]), new Set([A]))).toEqual([]);
  });
  it('builds the address with the pools named', () => {
    expect(streamUrl('https://h/stream', [A, B])).toBe(`https://h/stream?keys=${encodeURIComponent(`${A},${B}`)}`);
  });
});

describe('createLiveStream', () => {
  it('opens one connection after the pools settle, and passes updates on', () => {
    const r = rig();
    r.stream.setKeys([B, A]);
    r.stream.setKeys([A, B]);
    expect(r.sources).toHaveLength(0);
    r.fire();
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0]!.url).toContain(encodeURIComponent(`${B},${A}`)); // sorted, so the same pools always make the same address
    r.sources[0]!.onopen?.({});
    r.sources[0]!.emit(JSON.stringify([upd(A)]));
    expect(r.got).toHaveLength(1);
    expect(r.states).toEqual([true]);
  });
  it('does not reconnect for the same pools, and does for a different set', () => {
    const r = rig();
    r.stream.setKeys([A]);
    r.fire();
    r.stream.setKeys([A]);
    expect(r.timers.filter((t) => t.live)).toHaveLength(0);
    r.stream.setKeys([A, B]);
    r.fire();
    expect(r.sources).toHaveLength(2);
    expect(r.sources[0]!.closed).toBe(true);
  });
  it('names at most 100 pools and drops names that are not pools', () => {
    const r = rig();
    const many = Array.from({ length: 150 }, (_, i) => `bnb:0x${i.toString(16).padStart(40, '0')}`);
    r.stream.setKeys([...many, 'not-a-pool']);
    r.fire();
    const named = decodeURIComponent(r.sources[0]!.url.split('keys=')[1]!).split(',');
    expect(named).toHaveLength(MAX_STREAM_KEYS);
    expect(named).not.toContain('not-a-pool');
  });
  it('closes while the tab is hidden and opens again when it is shown', () => {
    const r = rig();
    r.stream.setKeys([A]);
    r.fire();
    r.setHidden(true);
    r.stream.visibility();
    expect(r.sources[0]!.closed).toBe(true);
    r.setHidden(false);
    r.stream.visibility();
    expect(r.sources).toHaveLength(2);
  });
  it('waits longer after each failure and gives up for a while after five', () => {
    const r = rig();
    r.stream.setKeys([A]);
    r.fire();
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      r.sources[r.sources.length - 1]!.onerror?.({});
      waits.push(r.timers[r.timers.length - 1]!.ms);
      r.fire();
    }
    expect(waits.slice(0, 4)).toEqual([3_000, 6_000, 12_000, 30_000]);
    expect(waits[4]).toBe(10 * 60_000);
  });
  it('a working connection resets the failures, and stop closes for good', () => {
    const r = rig();
    r.stream.setKeys([A]);
    r.fire();
    r.sources[0]!.onerror?.({});
    r.fire();
    r.sources[1]!.onopen?.({});
    r.sources[1]!.onerror?.({});
    expect(r.timers[r.timers.length - 1]!.ms).toBe(3_000);
    r.stream.stop();
    r.fire();
    expect(r.sources.every((s) => s.closed)).toBe(true);
  });
  it('does nothing without an address or without pools', () => {
    const r = rig();
    r.stream.setKeys([]);
    r.fire();
    expect(r.sources).toHaveLength(0);
    const sources: FakeSource[] = [];
    const s = createLiveStream({ url: '', onUpdates: () => undefined, open: (u) => (sources.push(new FakeSource(u)), sources[0]!), setTimer: (fn) => (fn(), null), clearTimer: () => undefined });
    s.setKeys([A]);
    expect(sources).toHaveLength(0);
  });
});
