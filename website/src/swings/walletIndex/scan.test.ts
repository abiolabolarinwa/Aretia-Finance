import { describe, expect, it } from 'vitest';
import { scanReceived, TRANSFER_TOPIC, type Log, type Rpc } from './scan';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const T1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const T2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const padded = (a: string): string => `0x${'0'.repeat(24)}${a.slice(2)}`;
const log = (token: string, to: string, block: number, extra: string[] = []): Log => ({ address: token, topics: [TRANSFER_TOPIC, padded(B), padded(to), ...extra], blockNumber: `0x${block.toString(16)}` });

/** A fake node holding these logs: it answers only the ranges and receivers asked for, and refuses a range wider than `limit`. */
function node(logs: Log[], limit = Infinity): { rpc: Rpc; calls: { from: number; to: number; receivers: number }[] } {
  const calls: { from: number; to: number; receivers: number }[] = [];
  const rpc: Rpc = async <T,>(method: string, params: unknown[]): Promise<T> => {
    expect(method).toBe('eth_getLogs');
    const f = params[0] as { fromBlock: string; toBlock: string; topics: [string, null, string[]] };
    const from = parseInt(f.fromBlock, 16);
    const to = parseInt(f.toBlock, 16);
    calls.push({ from, to, receivers: f.topics[2].length });
    if (to - from + 1 > limit) throw new Error('query returned more than 10000 results or block range too wide');
    return logs.filter((l) => parseInt(l.blockNumber, 16) >= from && parseInt(l.blockNumber, 16) <= to && f.topics[2].includes(l.topics[2]!)) as unknown as T;
  };
  return { rpc, calls };
}

describe('scanReceived', () => {
  it('finds the tokens each wallet received, with the first and last block', async () => {
    const { rpc } = node([log(T1, A, 105), log(T1, A, 130), log(T2, A, 110), log(T2, B, 120)]);
    const got = await scanReceived(rpc, [A, B], 100, 140, { maxRange: 1000, addressBatch: 10 });
    expect(got.get(A)!.get(T1)).toEqual({ firstBlock: 105, lastBlock: 130 });
    expect(got.get(A)!.get(T2)).toEqual({ firstBlock: 110, lastBlock: 110 });
    expect([...got.get(B)!.keys()]).toEqual([T2]);
  });

  it('names many wallets in one call, and cuts a long range into windows the node accepts', async () => {
    const { rpc, calls } = node([log(T1, A, 150)]);
    await scanReceived(rpc, [A, B], 100, 299, { maxRange: 100, addressBatch: 10 });
    expect(calls.map((c) => [c.from, c.to, c.receivers])).toEqual([[100, 199, 2], [200, 299, 2]]);
    const split = node([]);
    await scanReceived(split.rpc, [A, B], 100, 120, { maxRange: 1000, addressBatch: 1 });
    expect(split.calls.map((c) => c.receivers)).toEqual([1, 1]);
  });

  it('halves a window the node refuses, down to what it accepts, and loses nothing', async () => {
    const logs = [log(T1, A, 101), log(T2, A, 198)];
    const { rpc, calls } = node(logs, 30);
    const got = await scanReceived(rpc, [A], 100, 199, { maxRange: 1000, addressBatch: 10 });
    expect([...got.get(A)!.keys()].sort()).toEqual([T1, T2]);
    expect(calls.length).toBeGreaterThan(4);
  });

  it('ignores NFT transfers, other receivers, and bad input', async () => {
    const { rpc } = node([log(T1, A, 101, [`0x${'0'.repeat(63)}1`]), { address: T2, topics: [TRANSFER_TOPIC, padded(B)], blockNumber: '0x65' }]);
    expect((await scanReceived(rpc, [A], 100, 110, { maxRange: 1000, addressBatch: 10 })).size).toBe(0);
    expect((await scanReceived(rpc, ['nonsense', A.toUpperCase().replace('0X', '0x')], 110, 100, { maxRange: 10, addressBatch: 10 })).size).toBe(0);
  });

  it('passes on a node that is down instead of hiding it, and lets a caller stop a runaway scan', async () => {
    const down: Rpc = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    await expect(scanReceived(down, [A], 1, 10, { maxRange: 10, addressBatch: 10 })).rejects.toThrow('ECONNREFUSED');
    const { rpc } = node([], 1);
    await expect(
      scanReceived(rpc, [A], 1, 10_000, {
        maxRange: 10_000,
        addressBatch: 10,
        onCall: (n) => {
          if (n > 50) throw new Error('too many calls');
        },
      }),
    ).rejects.toThrow('too many calls');
  });
});
