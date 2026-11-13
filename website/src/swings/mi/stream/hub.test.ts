import { describe, expect, it } from 'vitest';
import type { LiveUpdate } from '../../market/liveFields.js';
import { StreamHub, type Sink } from './hub.js';

const upd = (key: string, at: number, price = 1): LiveUpdate => ({
  key,
  at,
  p_usd: price,
  chg: null,
  buys: null,
  sells: null,
  vol: null,
  ro: false,
  liquidity_usd: 1000,
});

function sink() {
  const got: string[] = [];
  let ended = false;
  let full = false;
  const s: Sink = { write: (c) => (full ? false : (got.push(c), true)), end: () => void (ended = true) };
  const events = () => got.filter((c) => c.startsWith('event: u')).flatMap((c) => JSON.parse(c.slice(c.indexOf('data: ') + 6)) as LiveUpdate[]);
  return { s, got, events, isEnded: () => ended, setFull: (v: boolean) => void (full = v) };
}

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe('live stream hub', () => {
  it('sends a viewer the updates of its own pools only', () => {
    const c = clock();
    const hub = new StreamHub({ now: c.now });
    const a = sink();
    const b = sink();
    hub.subscribe(['bnb:0xaa'], a.s);
    hub.subscribe(['bnb:0xbb', 'bnb:0xaa'], b.s);
    hub.publish([upd('bnb:0xaa', c.now()), upd('bnb:0xcc', c.now())]);
    expect(a.events().map((u) => u.key)).toEqual(['bnb:0xaa']);
    expect(b.events().map((u) => u.key)).toEqual(['bnb:0xaa']);
  });

  it('sends a pool to a viewer at most once a second, holds the newest meanwhile, and does not lose the last word', () => {
    const c = clock();
    const hub = new StreamHub({ now: c.now });
    const a = sink();
    hub.subscribe(['bnb:0xaa'], a.s);
    hub.publish([upd('bnb:0xaa', c.now(), 1)]);
    c.advance(100);
    hub.publish([upd('bnb:0xaa', c.now(), 2)]);
    c.advance(100);
    hub.publish([upd('bnb:0xaa', c.now(), 3)]);
    expect(a.events().map((u) => u.p_usd)).toEqual([1]); // the two later ones are held
    c.advance(500);
    hub.flush();
    expect(a.events().map((u) => u.p_usd)).toEqual([1]); // not due yet
    c.advance(400);
    hub.flush();
    expect(a.events().map((u) => u.p_usd)).toEqual([1, 3]); // the newest, the middle one was replaced
    hub.flush();
    expect(a.events()).toHaveLength(2); // nothing is sent twice
  });

  it('brings a new viewer level with the latest known state of its pools, but not an old one', () => {
    const c = clock();
    const hub = new StreamHub({ now: c.now, latestMaxAgeMs: 60_000 });
    hub.publish([upd('bnb:0xaa', c.now(), 7)]);
    c.advance(30_000);
    hub.publish([upd('bnb:0xbb', c.now(), 8)]);
    const a = sink();
    hub.subscribe(['bnb:0xaa', 'bnb:0xbb'], a.s);
    expect(a.events().map((u) => u.p_usd).sort()).toEqual([7, 8]);
    c.advance(40_000); // 0xaa is now 70 s old, 0xbb 40 s
    const b = sink();
    hub.subscribe(['bnb:0xaa', 'bnb:0xbb'], b.s);
    expect(b.events().map((u) => u.key)).toEqual(['bnb:0xbb']);
  });

  it('refuses a viewer with no pools, too many pools, or when the server is full', () => {
    const hub = new StreamHub({ maxClients: 2, maxKeys: 3 });
    expect(hub.subscribe([], sink().s)).toEqual({ ok: false, reason: 'no-keys' });
    expect(hub.subscribe(['a:1', 'a:2', 'a:3', 'a:4'], sink().s)).toEqual({ ok: false, reason: 'too-many-keys' });
    expect(hub.subscribe(['a:1', 'a:1', 'a:1'], sink().s).ok).toBe(true); // duplicates count once
    expect(hub.subscribe(['a:2'], sink().s).ok).toBe(true);
    expect(hub.subscribe(['a:3'], sink().s)).toEqual({ ok: false, reason: 'full' });
    expect(hub.clientCount).toBe(2);
  });

  it('forgets a viewer that left, and drops one whose connection stopped taking data', () => {
    const c = clock();
    const hub = new StreamHub({ now: c.now });
    const gone = sink();
    const slow = sink();
    const r1 = hub.subscribe(['bnb:0xaa'], gone.s);
    hub.subscribe(['bnb:0xaa'], slow.s);
    if (r1.ok) hub.unsubscribe(r1.id);
    slow.setFull(true);
    hub.publish([upd('bnb:0xaa', c.now())]);
    expect(gone.events()).toHaveLength(0);
    expect(slow.isEnded()).toBe(true);
    expect(hub.clientCount).toBe(0);
  });

  it('keeps only the most recent updates in memory', () => {
    const c = clock();
    const hub = new StreamHub({ now: c.now, maxLatest: 3 });
    for (let i = 0; i < 6; i++) hub.publish([upd(`bnb:0x${i}`, c.now(), i)]);
    const a = sink();
    hub.subscribe(['bnb:0x0', 'bnb:0x1', 'bnb:0x2', 'bnb:0x3', 'bnb:0x4', 'bnb:0x5'], a.s);
    expect(a.events().map((u) => u.p_usd).sort()).toEqual([3, 4, 5]);
  });

  it('heartbeats every viewer, and closes them all on shutdown', () => {
    const hub = new StreamHub();
    const a = sink();
    hub.subscribe(['bnb:0xaa'], a.s);
    hub.heartbeat();
    expect(a.got).toContain(': ping\n\n');
    hub.closeAll();
    expect(a.isEnded()).toBe(true);
    expect(hub.clientCount).toBe(0);
  });
});
