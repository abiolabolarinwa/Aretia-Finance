import { describe, expect, it } from 'vitest';
import { chainConfig } from '../chains.js';
import { solanaSpecById } from '../dexes.js';
import { DEFAULT_RULES } from '../lifecycle.js';
import { RpcError, type Read } from '../rpc.js';
import { InMemoryMiStore } from '../store.js';
import type { MiPool } from '../types.js';
import { followPool, pastGrace, readTx, TX_ATTEMPTS, TX_GRACE_SECONDS } from './engine.js';

const SIG = (n: number) => String(n).padStart(88, '1');
const NOW = 1_800_000_000_000;
const report = () => ({ adapterId: 'x', ok: true, skipped: null, head: null, safeHead: null, fromBlock: null, toBlock: null, lagBlocks: null, creations: 0, poolsNew: 0, tokensNew: 0, swapsSeen: 0, tradesNew: 0, skippedLogs: 0, reorg: null, error: null, durationMs: 0 });

describe('a transaction a node says it cannot find', () => {
  it('is asked again, and returned when a later node has it', async () => {
    let n = 0;
    const rpc: Read = async () => {
      if (++n < 3) throw new RpcError(`Transaction ${SIG(1)} not found`, 'node-error');
      return { slot: 5 };
    };
    expect(await readTx(rpc, SIG(1))).toEqual({ slot: 5 });
    expect(n).toBe(3);
  });

  it('is null (not an exception) after the attempts, whether the node errors or answers null', async () => {
    let n = 0;
    expect(await readTx(async () => (++n, null), SIG(1))).toBeNull();
    expect(n).toBe(TX_ATTEMPTS);
    expect(await readTx(async () => { throw new RpcError('Transaction not found', 'node-error'); }, SIG(1))).toBeNull();
  });

  it('still fails the run for a real outage, so an outage is never mistaken for a missing transaction', async () => {
    await expect(readTx(async () => { throw new RpcError('every node is down', 'transport'); }, SIG(1))).rejects.toThrow('every node is down');
    await expect(readTx(async () => { throw new RpcError('invalid params', 'node-error'); }, SIG(1))).rejects.toThrow('invalid params');
  });

  it('is skipped only once the signature is old', () => {
    expect(pastGrace(NOW, NOW / 1000 - 60)).toBe(false);
    expect(pastGrace(NOW, NOW / 1000 - TX_GRACE_SECONDS - 1)).toBe(true);
    expect(pastGrace(NOW, null)).toBe(false);
  });
});

describe('a pool whose signature list holds a transaction no node returns', () => {
  const spec = solanaSpecById('raydium-amm-v4-solana')!;
  const pool = { key: 'solana:P', address: 'P', base: 'B', quote: 'Q', baseDecimals: 6, quoteDecimals: 9, baseVault: 'BV', quoteVault: 'QV' } as unknown as MiPool;
  const run = async (blockTime: number) => {
    const store = new InMemoryMiStore();
    const rpc: Read = async (method) => {
      if (method === 'getSignaturesForAddress') return [{ signature: SIG(9), slot: 10, blockTime, err: null }];
      throw new RpcError(`Transaction ${SIG(9)} not found`, 'node-error');
    };
    const d = { spec, chain: chainConfig('solana'), rpc, store, rules: DEFAULT_RULES, now: () => NOW };
    const got = await followPool(d, pool, report());
    return { got, cp: await store.getCheckpoint(`${spec.id}|P`) };
  };

  it('waits for a young one: its cursor does not move past it', async () => {
    const { got, cp } = await run(NOW / 1000 - 120);
    expect(got.unavailable).toBe(1);
    expect(got.skipped).toEqual([]);
    expect(cp?.blockHash).toBe('');
  });

  it('skips an old one, records it, and moves the cursor on', async () => {
    const { got, cp } = await run(NOW / 1000 - 7200);
    expect(got.unavailable).toBe(0);
    expect(got.skipped).toEqual([{ signature: SIG(9), pool: 'P' }]);
    expect(cp?.blockHash).toBe(SIG(9));
  });
});
