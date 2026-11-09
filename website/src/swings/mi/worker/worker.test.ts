import { describe, expect, it } from 'vitest';
import { backfillCreations } from '../backfill.js';
import { chainConfig } from '../chains.js';
import { poolDto } from '../dto.js';
import { specById } from '../dexes.js';
import { DEFAULT_RULES } from '../lifecycle.js';
import { refreshReserves } from '../refresher.js';
import { MULTICALL3 } from '../reserves.js';
import type { Read } from '../rpc.js';
import { InMemoryMiStore } from '../store.js';
import { FakeChain, pairCreatedLog } from '../testkit.js';
import { backoffMs, DEFAULT_LOOP, failureType, FailureLog, runWorker, type WorkerTask } from './loop.js';
import { buildTasks } from './tasks.js';

const spec = specById('pancakeswap-v2-bnb')!;
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const TOKEN = '0x' + 'a1'.repeat(20);
const JUNK = '0x' + 'a2'.repeat(20);
const OTHER = '0x' + 'a3'.repeat(20);
const OTHER2 = '0x' + 'a4'.repeat(20);
const POOL = '0x' + 'c3'.repeat(20);
const POOL_JUNK = '0x' + 'c4'.repeat(20);
const POOL_NOQUOTE = '0x' + 'c5'.repeat(20);
const E18 = 10n ** 18n;
const w = (n: bigint | number): string => BigInt(n).toString(16).padStart(64, '0');

/** Answers Multicall3's aggregate3 by running each inner call against the fake chain, like the real contract. */
function withMulticall(chain: FakeChain): Read {
  return async (method, params) => {
    const call = params[0] as { to?: string; data?: string } | undefined;
    if (method !== 'eth_call' || call?.to?.toLowerCase() !== MULTICALL3.toLowerCase()) return chain.read(method, params);
    const data = call.data!.slice(2 + 8);
    const at = (i: number): number => Number(BigInt('0x' + data.slice(i * 2, i * 2 + 64)));
    const start = at(0);
    const n = at(start);
    const base = start + 32;
    const results: { success: boolean; data: string }[] = [];
    for (let i = 0; i < n; i++) {
      const item = base + at(base + i * 32);
      const target = '0x' + data.slice((item + 12) * 2, (item + 32) * 2);
      const bytesAt = item + at(item + 64);
      const len = at(bytesAt);
      const cd = '0x' + data.slice((bytesAt + 32) * 2, (bytesAt + 32 + len) * 2);
      try {
        results.push({ success: true, data: String(await chain.read('eth_call', [{ to: target, data: cd }, 'latest'])).slice(2) });
      } catch {
        results.push({ success: false, data: '' });
      }
    }
    const bodies = results.map((r) => {
      const len = r.data.length / 2;
      return w(r.success ? 1 : 0) + w(0x40) + w(len) + r.data + '0'.repeat((64 - (r.data.length % 64)) % 64);
    });
    let off = 32 * n;
    const offsets = bodies.map((b) => {
      const o = off;
      off += b.length / 2;
      return w(o);
    });
    return '0x' + w(0x20) + w(n) + offsets.join('') + bodies.join('');
  };
}

function bnbWorld() {
  const chain = new FakeChain();
  chain.addToken(WBNB, 'WBNB', 18);
  chain.addToken(TOKEN, 'MEME', 18);
  chain.addToken(JUNK, 'JUNK', 18);
  chain.addToken(OTHER, 'OA', 18);
  chain.addToken(OTHER2, 'OB', 18);
  chain.reserves.set(POOL, [1_000_000n * E18, 100n * E18]); // token0 = MEME, token1 = WBNB
  chain.reserves.set(POOL_JUNK, [5n * E18, 1_000n]); // a pool holding almost nothing
  chain.reserves.set(POOL_NOQUOTE, [E18, E18]);
  chain.mineEmpty(3);
  chain.mine([pairCreatedLog(spec.factory, TOKEN, WBNB, POOL), pairCreatedLog(spec.factory, JUNK, WBNB, POOL_JUNK), pairCreatedLog(spec.factory, OTHER, OTHER2, POOL_NOQUOTE)]);
  chain.mineEmpty(40);
  const now = () => (chain.blocks[chain.blocks.length - 1]!.time + 5) * 1000;
  return { chain, read: withMulticall(chain), now, cfg: chainConfig('bnb', { MI_CONFIRMATIONS_BNB: '2' }) };
}

describe('pool backfill and reserves refresher (BNB Chain, PancakeSwap V2)', () => {
  it('registers only pools with real dollar liquidity found in the creation events, once, and resumes as done', async () => {
    const { chain, read, now, cfg } = bnbWorld();
    const store = new InMemoryMiStore();
    const deps = { spec, chain: cfg, read, store, rules: DEFAULT_RULES, now, nativeUsd: async () => 600, budgetMs: 30_000, days: 0.02 };
    const r = await backfillCreations(deps);
    expect(r.ok).toBe(true);
    expect(r.state).toBe('done');
    expect(r.creations).toBe(3);
    expect(r.candidates).toBe(2); // the pair without a recognised quote token is never a candidate
    expect(r.registered).toBe(1);
    expect(r.belowFloor).toBe(1); // 1,000 wei of WBNB is not liquidity
    expect([...store.pools.keys()]).toEqual([`bnb:${POOL}`]);
    const pool = store.pools.get(`bnb:${POOL}`)!;
    expect(pool.reserveQuote).toBe((100n * E18).toString());
    expect(store.trades.size).toBe(0); // no trade is invented
    const again = await backfillCreations(deps);
    expect(again.state).toBe('done');
    expect(again.registered).toBe(0);
    expect((await store.getCheckpoint(`${spec.id}:backfill:0.02d`))?.blockHash).toBe('done');
    void chain;
  });

  it('refreshes liquidity from on-chain reserves, shows no price or volume without stored trades, and follows a drained pool', async () => {
    const { chain, read, now, cfg } = bnbWorld();
    const store = new InMemoryMiStore();
    await backfillCreations({ spec, chain: cfg, read, store, rules: DEFAULT_RULES, now, nativeUsd: async () => 600, budgetMs: 30_000, days: 0.02 });
    const deps = { spec, chain: cfg, read, store, rules: DEFAULT_RULES, now, nativeUsd: async () => 600, budgetMs: 10_000 };

    const first = await refreshReserves(deps);
    expect(first).toMatchObject({ ok: true, considered: 1, read: 1, unreadable: 0 });
    const stats = store.pools.get(`bnb:${POOL}`)!.stats!;
    expect(stats.reservesOnly).toBe(true);
    expect(stats.liquidityUsd).toBe(120_000); // 100 WBNB x 2 x $600
    expect(stats.price).toBeNull();
    expect(stats.reservePrice).toBe('0.0001'); // 100 WBNB / 1,000,000 MEME, read from the reserves
    expect(stats.reservePriceUsd).toBeCloseTo(0.06, 10); // x $600
    const dto = poolDto(store.pools.get(`bnb:${POOL}`)!, new Map(), now());
    expect(dto.liquidity.usd).toBe(120_000);
    expect(dto.volume.usd).toBeNull(); // absent, not zero
    expect(dto.volume.quote).toBeNull();
    expect(dto.changePct.h24).toBeNull();
    expect(dto.txns.buys).toBeNull();

    chain.reserves.set(POOL, [1_000_000n * E18, 0n]); // liquidity pulled
    const second = await refreshReserves(deps);
    expect(second.stateChanges).toBe(1);
    expect(store.pools.get(`bnb:${POOL}`)!.state).toBe('awaiting_liquidity');
  });

  it('does nothing on a chain without Multicall3 or for a V4 adapter', async () => {
    const { read, now } = bnbWorld();
    const store = new InMemoryMiStore();
    const v4 = specById('uniswap-v4-bnb') ?? specById('uniswap-v4-ethereum')!;
    const r = await refreshReserves({ spec: v4, chain: chainConfig(v4.chain), read, store, rules: DEFAULT_RULES, now, budgetMs: 1000 });
    expect(r.skipped).toBe('unsupported');
  });
});

describe('tasks from configuration', () => {
  const store = new InMemoryMiStore();
  const ids = (env: Record<string, string>) => buildTasks({ env, store, now: Date.now, readFor: () => (async () => null) as unknown as Read }).map((t) => t.id);
  it('live task per adapter, a refresher per V2/V3 adapter, and a backfill only when asked (BNB V2/V3 by default)', () => {
    expect(ids({ MI_ADAPTERS: 'pancakeswap-v2-bnb' })).toEqual(['pancakeswap-v2-bnb', 'pancakeswap-v2-bnb:refresh']);
    expect(ids({ MI_ADAPTERS: 'pancakeswap-v2-bnb', MI_REFRESH: '0' })).toEqual(['pancakeswap-v2-bnb']);
    const withBackfill = ids({ MI_ADAPTERS: 'pancakeswap-v2-bnb', MI_BACKFILL_DAYS: '7' });
    expect(withBackfill).toContain('pancakeswap-v2-bnb:backfill');
    expect(withBackfill.some((i) => i.endsWith('-bnb:backfill') && i.startsWith('uniswap-v3'))).toBe(true);
    expect(ids({ MI_ADAPTERS: 'pancakeswap-v2-bnb', MI_BACKFILL_DAYS: '7', MI_BACKFILL_ADAPTERS: 'apeswap-v2-bnb' }).filter((i) => i.endsWith(':backfill'))).toEqual(['apeswap-v2-bnb:backfill']);
  });
});

describe('worker loop', () => {
  /** A fake clock: sleeping advances time; the loop stops after `until` ms of it. */
  function harness(until: number) {
    let t = 0;
    const lines: string[] = [];
    return {
      lines,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      advance: (ms: number) => {
        t += ms;
      },
      stopping: () => t >= until,
      log: (l: string) => lines.push(l),
    };
  }
  const opts = { ...DEFAULT_LOOP, sliceMs: 1000, idleMs: 10_000, backoffBaseMs: 1000, backoffMaxMs: 8000 };

  it('gives adapters of a chain turns (least recently served first) and runs chains side by side', async () => {
    const h = harness(60_000);
    const order: string[] = [];
    const mk = (id: string, chain: WorkerTask['chain']): WorkerTask => ({ id, chain, run: async () => (order.push(id), h.advance(500), { ok: true, caughtUp: true }) });
    await runWorker({ tasks: [mk('a', 'bnb'), mk('b', 'bnb'), mk('c', 'ethereum')], options: opts, now: h.now, sleep: h.sleep, stopping: h.stopping, log: h.log, random: () => 0.5 });
    expect(order.slice(0, 3).sort()).toEqual(['a', 'b', 'c']);
    // Within a chain, a and b alternate rather than a running twice before b has run.
    const bnb = order.filter((x) => x !== 'c');
    expect(bnb.slice(0, 4)).toEqual(['a', 'b', 'a', 'b']);
  });

  it('backs off after failures, doubling up to the cap, logs one line per failure type, and one line on recovery', async () => {
    const h = harness(120_000);
    let calls = 0;
    const times: number[] = [];
    const flaky: WorkerTask = {
      id: 'flaky',
      chain: 'bnb',
      run: async () => {
        times.push(h.now());
        calls++;
        return calls <= 5 ? { ok: false, error: 'HTTP 429 rate limit exceeded' } : { ok: true, caughtUp: true };
      },
    };
    await runWorker({ tasks: [flaky], options: opts, now: h.now, sleep: h.sleep, stopping: h.stopping, log: h.log, random: () => 0.5 });
    const gaps = times.slice(1, 6).map((t, i) => t - times[i]!);
    expect(gaps).toEqual([1000, 2000, 4000, 8000, 8000]); // 1s, 2s, 4s, then capped at 8s
    expect(h.lines.filter((l) => l.includes('failing')).length).toBe(1); // five failures, one line
    expect(h.lines.some((l) => l.includes('recovered after 5 failure(s) (rate-limited)'))).toBe(true);
  });

  it('a task that throws is a failure, not a crash of the loop', async () => {
    const h = harness(10_000);
    await runWorker({ tasks: [{ id: 'boom', chain: 'bnb', run: async () => { throw new Error('connect ECONNREFUSED'); } }], options: opts, now: h.now, sleep: h.sleep, stopping: h.stopping, log: h.log, random: () => 0.5 });
    expect(h.lines.some((l) => l.includes('failing (node-unreachable)'))).toBe(true);
  });

  it('classifies failures and bounds the backoff', () => {
    expect(failureType('HTTP 429 too many requests')).toBe('rate-limited');
    expect(failureType('request timed out')).toBe('timeout');
    expect(failureType('block 5 changed while it was being read')).toBe('reorg');
    expect(failureType('PostgREST answered 503')).toBe('database');
    expect(failureType('something odd')).toBe('other');
    expect(backoffMs(50, opts, 0.5)).toBe(8000);
    const log: string[] = [];
    const f = new FailureLog((l) => log.push(l), 1000);
    f.failed('x', 'timeout', 0);
    f.failed('x', 'timeout', 500);
    f.failed('x', 'timeout', 1500);
    expect(log.length).toBe(2); // first, then one summary after the window
  });
});
