import { describe, expect, it, vi } from 'vitest';
import { CONFIRMATIONS, decodePairCreated, EvmFactoryDiscoverySource, PAIR_CREATED_TOPIC } from './evmIndexer.js';
import { EVM_V2_DEXES } from '../dex/entries.js';
import { InMemoryTokenRepository, TokenRegistryService } from '../tokens/registry.js';
import { TokenDiscoveryWorker } from '../tokens/discovery.js';
import { selector } from '../engine/abi.js';

const entry = EVM_V2_DEXES.find((e) => e.id === 'pancakeswap-v2-bnb')!;
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const WBNB = entry.wrappedNative!;
const NEW1 = '0x' + 'a1'.repeat(20);
const NEW2 = '0x' + 'b2'.repeat(20);
const PAIR1 = '0x' + 'c1'.repeat(20);
const PAIR2 = '0x' + 'c2'.repeat(20);
const w = (h: string | bigint) => (typeof h === 'bigint' ? h.toString(16) : h.replace('0x', '')).padStart(64, '0');

const log = (t0: string, t1: string, pair: string, block: number, extra: Record<string, unknown> = {}) => ({ topics: [PAIR_CREATED_TOPIC, '0x' + w(t0), '0x' + w(t1)], data: '0x' + w(pair) + w(1n), blockNumber: '0x' + block.toString(16), ...extra });
const str = (s: string) => '0x' + w(32n) + w(BigInt(s.length)) + [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0');

function node(head: number, logs: unknown[], opts: { reserves?: Record<string, [bigint, bigint]>; rangeLimit?: number; badBlock?: boolean } = {}) {
  const getLogsRanges: number[] = [];
  const read = vi.fn(async (method: string, params: unknown[]) => {
    if (method === 'eth_blockNumber') return '0x' + head.toString(16);
    if (method === 'eth_getLogs') {
      const f = params[0] as { fromBlock: string; toBlock: string };
      const from = Number.parseInt(f.fromBlock, 16);
      const to = Number.parseInt(f.toBlock, 16);
      getLogsRanges.push(to - from + 1);
      if (opts.rangeLimit && to - from + 1 > opts.rangeLimit) throw new Error('range too large');
      return (logs as { blockNumber?: string }[]).filter((l) => typeof l.blockNumber === 'string' && Number.parseInt(l.blockNumber, 16) >= from && Number.parseInt(l.blockNumber, 16) <= to);
    }
    if (method === 'eth_getBlockByNumber') return opts.badBlock ? null : { timestamp: '0x' + (1_800_000_000 + Number.parseInt(String(params[0]), 16)).toString(16) };
    if (method === 'eth_getCode') return '0x6080';
    if (method === 'eth_call') {
      const c = params[0] as { to: string; data: string };
      const sel = c.data.slice(2, 10);
      if (sel === selector('getReserves()')) {
        const r = opts.reserves?.[c.to] ?? [0n, 0n];
        return '0x' + w(r[0]) + w(r[1]) + w(1n);
      }
      if (sel === selector('decimals()')) return '0x' + w(18n);
      if (sel === selector('symbol()')) return str('NEWT');
      if (sel === selector('name()')) return str('New Token');
    }
    return '0x';
  });
  return { read: read as unknown as (m: string, p: unknown[]) => Promise<unknown>, getLogsRanges };
}

describe('PairCreated decoding', () => {
  it('reads a real-shaped log and rejects anything else', () => {
    expect(decodePairCreated(log(NEW1, USDT, PAIR1, 100))).toEqual({ token0: NEW1, token1: USDT, pair: PAIR1, block: 100n });
    expect(decodePairCreated(log(NEW1, USDT, PAIR1, 100, { removed: true }))).toBeNull();
    expect(decodePairCreated({ ...log(NEW1, USDT, PAIR1, 100), topics: ['0x' + '00'.repeat(32), '0x' + w(NEW1), '0x' + w(USDT)] })).toBeNull();
    expect(decodePairCreated({ ...log(NEW1, USDT, PAIR1, 100), topics: [PAIR_CREATED_TOPIC] })).toBeNull();
    expect(decodePairCreated({ ...log(NEW1, USDT, PAIR1, 100), data: '0x12' })).toBeNull();
    expect(decodePairCreated({ ...log(NEW1, USDT, PAIR1, 100), blockNumber: 'nope' })).toBeNull();
    expect(decodePairCreated(null)).toBeNull();
    expect(decodePairCreated('x')).toBeNull();
  });
  it('the event topic is the keccak of the signature (the well-known PairCreated topic)', () => {
    expect(PAIR_CREATED_TOPIC).toBe('0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9');
  });
});

describe('EvmFactoryDiscoverySource', () => {
  const make = (n: ReturnType<typeof node>) => new EvmFactoryDiscoverySource(entry, n.read, { confirmations: 15, lookback: 100, maxRange: 50 });

  it('reports new tokens from confirmed blocks only, with the pool block time and on-chain metadata', async () => {
    const n = node(1_000, [log(NEW1, USDT, PAIR1, 950), log(WBNB, NEW2, PAIR2, 990)], { reserves: { [PAIR1]: [10n ** 21n, 5_000n * 10n ** 18n] } });
    const batch = await make(n).poll('930');
    // head 1000 with 15 confirmations: only blocks up to 985 are read, so the log at 990 is not trusted yet.
    expect(batch.nextCursor).toBe('980');
    expect(batch.candidates).toHaveLength(1);
    const c = batch.candidates[0]!;
    expect(c.ref.address).toBe(NEW1);
    expect(c).toMatchObject({ symbol: 'NEWT', name: 'New Token', decimals: 18, onchain: true, firstPoolAt: (1_800_000_000 + 950) * 1000, source: 'aretia-indexer:pancakeswap-v2-bnb' });
    expect(c.pool).toEqual({ venue: 'PancakeSwap V2', address: PAIR1 });
    expect(c.liquidityUsd).toBe(5_000 * 2);
  });

  it('skips hub tokens, reports an empty pair as discovered with no pool, and never claims USD liquidity without a stablecoin', async () => {
    const n = node(1_000, [log(WBNB, NEW2, PAIR2, 960)], { reserves: { [PAIR2]: [10n ** 18n, 10n ** 18n] } });
    const batch = await make(n).poll('950');
    expect(batch.candidates.map((c) => c.ref.address)).toEqual([NEW2]);
    expect(batch.candidates[0]!.liquidityUsd).toBeNull();
    const empty = node(1_000, [log(NEW1, USDT, PAIR1, 960)]);
    const e = await make(empty).poll('950');
    expect(e.candidates[0]!.pool).toBeNull();
    expect(e.candidates[0]!.liquidityUsd).toBe(0);
  });

  it('does nothing and keeps the cursor when there is no confirmed block to read', async () => {
    expect(await make(node(1_000, [])).poll('985')).toEqual({ candidates: [], nextCursor: null });
  });

  it('starts a bounded distance back on the first poll', async () => {
    const src = make(node(10_000, []));
    const batch = await src.poll(null);
    expect(src.lastRun!.fromBlock).toBe(10_000n - 15n - 100n);
    expect(batch.nextCursor).toBe((10_000n - 15n - 100n + 49n).toString());
  });

  it('halves the block range when the node refuses a large one, and loses no log', async () => {
    const n = node(1_000, [log(NEW1, USDT, PAIR1, 940), log(NEW2, USDT, PAIR2, 975)], { rangeLimit: 20 });
    const batch = await make(n).poll('930');
    expect(batch.candidates.map((c) => c.ref.address).sort()).toEqual([NEW1, NEW2].sort());
    expect(n.getLogsRanges.length).toBeGreaterThan(1);
  });

  it('skips pairs whose block time cannot be read, and ignores removed or malformed logs', async () => {
    const n = node(1_000, [log(NEW1, USDT, PAIR1, 960), log(NEW2, USDT, PAIR2, 961, { removed: true }), { junk: true }], { badBlock: true });
    const src = make(n);
    expect((await src.poll('950')).candidates).toEqual([]);
    expect(src.lastRun!.skipped).toBe(1);
  });

  it('reports lag and uses a deeper confirmation window where a chain reorganises more', async () => {
    const src = new EvmFactoryDiscoverySource(entry, node(2_000, []).read, { confirmations: 15, maxRange: 10 });
    await src.poll('1000');
    expect(src.lastRun!.lagBlocks).toBe(2_000n - 1_010n);
    expect(CONFIRMATIONS.polygon).toBeGreaterThan(CONFIRMATIONS.ethereum);
    expect(() => new EvmFactoryDiscoverySource({ ...entry, factory: undefined }, node(1, []).read)).toThrow();
  });

  it('feeds the shared worker: tokens land in the registry with an Aretia-detected first pool time, and re-reading is harmless', async () => {
    const n = node(1_000, [log(NEW1, USDT, PAIR1, 950)], { reserves: { [PAIR1]: [10n ** 21n, 5_000n * 10n ** 18n] } });
    const repo = new InMemoryTokenRepository();
    const worker = new TokenDiscoveryWorker(make(n), new TokenRegistryService(repo, () => 5), repo, null, () => 5);
    await repo.setCursor('aretia:v2-factory:pancakeswap-v2-bnb', '930');
    expect(await worker.runOnce()).toMatchObject({ polled: 1, ingested: 1, error: null });
    const rec = await repo.get({ chain: 'bnb', address: NEW1 });
    expect(rec).toMatchObject({ discoveryStatus: 'tradable', discoverySource: 'aretia-indexer:pancakeswap-v2-bnb', metadataConfidence: 'onchain', firstPoolAt: (1_800_000_000 + 950) * 1000 });
    expect(await repo.getCursor('aretia:v2-factory:pancakeswap-v2-bnb')).toBe('980');
    await repo.setCursor('aretia:v2-factory:pancakeswap-v2-bnb', '930');
    await worker.runOnce();
    expect((await repo.listRecent('bnb', 10)).length).toBe(1);
  });
});
