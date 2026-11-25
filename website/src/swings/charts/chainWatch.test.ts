import { describe, expect, it } from 'vitest';
import { decodeBase58, encodeBase58 } from '../mi/solana/accounts.js';
import { createChainWatch } from './chainWatch.js';
import type { Rpc } from './chainPrice.js';

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
const key = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 7));
const KEY = (n: number): string => encodeBase58(key(n));
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';

const mint = (decimals: number): string => {
  const d = new Uint8Array(82);
  d[44] = decimals;
  d[45] = 1;
  return b64(d);
};
const tokenAccount = (amount: bigint): string => {
  const d = new Uint8Array(165);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return b64(d);
};

/** A CPMM pool of token KEY(21) against USDC, whose USDC vault balance can be changed. */
function setup(): { rpc: Rpc; setUsdc: (n: bigint) => void; reads: () => number } {
  const pool = new Uint8Array(637);
  pool.set(key(31), 72);
  pool.set(key(32), 104);
  pool.set(key(21), 168);
  pool.set(decodeBase58(USDC)!, 200);
  let usdc = 2_000_000n;
  let reads = 0;
  const rpc: Rpc = async (method, params) => {
    if (method === 'getAccountInfo') return { value: { owner: CPMM, data: [b64(pool), 'base64'] } };
    const list = params[0] as string[];
    if (list.includes(KEY(31))) reads++;
    return {
      value: list.map((a) => (a === KEY(21) || a === USDC ? { data: [mint(6), 'base64'] } : a === KEY(31) ? { data: [tokenAccount(1_000_000_000n), 'base64'] } : a === KEY(32) ? { data: [tokenAccount(usdc), 'base64'] } : null)),
    };
  };
  return { rpc, setUsdc: (n) => (usdc = n), reads: () => reads };
}

/** A timer that runs when the test says so. */
function clock(): { setTimer: (fn: () => void) => unknown; clearTimer: (t: unknown) => void; tick: () => Promise<void> } {
  let next: (() => void) | null = null;
  return {
    setTimer: (fn) => {
      next = fn;
      return 1;
    },
    clearTimer: () => {
      next = null;
    },
    tick: async () => {
      const fn = next;
      next = null;
      fn?.();
      await new Promise((r) => setTimeout(r, 5));
    },
  };
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe('the shared chain watcher', () => {
  it('gives every watcher of a pool the same reads, and the newest price to a late one', async () => {
    const s = setup();
    const c = clock();
    const watch = createChainWatch({ deps: () => ({ rpc: s.rpc, usdOf: async () => null }), isTabHidden: () => false, setTimer: c.setTimer, clearTimer: c.clearTimer });
    const a: number[] = [];
    const b: number[] = [];
    const stopA = watch({ chain: 'solana', pool: KEY(9), target: KEY(21) }, (p) => a.push(p));
    await settle();
    expect(a).toEqual([0.002]);
    const stopB = watch({ chain: 'solana', pool: KEY(9), target: KEY(21) }, (p) => b.push(p));
    expect(b).toEqual([0.002]);
    s.setUsdc(4_000_000n);
    await c.tick();
    expect(a.at(-1)).toBeCloseTo(0.004, 9);
    expect(b.at(-1)).toBeCloseTo(0.004, 9);
    // One loop served both: one read for the first price, one for the change.
    expect(s.reads()).toBe(2);
    stopA();
    stopB();
  });

  it('stops reading when the last watcher leaves, and reads nothing while every watcher is hidden', async () => {
    const s = setup();
    const c = clock();
    let shown = false;
    const watch = createChainWatch({ deps: () => ({ rpc: s.rpc, usdOf: async () => null }), isTabHidden: () => false, setTimer: c.setTimer, clearTimer: c.clearTimer });
    const got: number[] = [];
    const stop = watch({ chain: 'solana', pool: KEY(9), target: KEY(21), visible: () => shown }, (p) => got.push(p));
    await settle();
    expect(s.reads()).toBe(0);
    shown = true;
    await c.tick();
    expect(got).toHaveLength(1);
    stop();
    await c.tick();
    expect(s.reads()).toBe(1);
  });

  it('gives up after several failed reads in a row', async () => {
    const s = setup();
    let fail = false;
    const c = clock();
    const rpc: Rpc = async (m, p) => {
      if (fail && m === 'getMultipleAccounts' && (p[0] as string[]).includes(KEY(31))) throw new Error('offline');
      return s.rpc(m, p);
    };
    const watch = createChainWatch({ deps: () => ({ rpc, usdOf: async () => null }), maxFailures: 2, isTabHidden: () => false, setTimer: c.setTimer, clearTimer: c.clearTimer });
    const got: number[] = [];
    watch({ chain: 'solana', pool: KEY(9), target: KEY(21) }, (p) => got.push(p));
    await settle();
    fail = true;
    await c.tick();
    await c.tick();
    await c.tick();
    await c.tick();
    expect(got).toHaveLength(1);
    // After two failures no further read was scheduled: ticking again does nothing.
    fail = false;
    await c.tick();
    expect(got).toHaveLength(1);
  });
});

describe('a price that keeps still is read less often', () => {
  it('waits longer after each read that finds no change, up to the ceiling, and goes back to the base pace on a move', async () => {
    const s = setup();
    const waits: number[] = [];
    let next: (() => void) | null = null;
    const watch = createChainWatch({
      deps: () => ({ rpc: s.rpc, usdOf: async () => null }),
      isTabHidden: () => false,
      everyMs: 400,
      calmMaxMs: 4000,
      setTimer: (fn, ms) => {
        waits.push(ms);
        next = fn;
        return 1;
      },
      clearTimer: () => {
        next = null;
      },
    });
    const stop = watch({ chain: 'solana', pool: KEY(9), target: KEY(21) }, () => undefined);
    await settle();
    for (let i = 0; i < 8; i++) {
      const fn = next as (() => void) | null;
      next = null;
      fn?.();
      await settle();
    }
    expect(waits[0]).toBe(400); // the first price is new
    expect(waits.at(-1)).toBe(4000); // still for a while: at the ceiling
    s.setUsdc(4_000_000n);
    const fn = next as (() => void) | null;
    fn?.();
    await settle();
    expect(waits.at(-1)).toBe(400); // a move: back to the base pace
    stop();
  });
});

