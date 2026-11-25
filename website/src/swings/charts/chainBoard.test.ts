import { describe, expect, it } from 'vitest';
import { decodeBase58, encodeBase58 } from '../mi/solana/accounts.js';
import { createBoardFeed, poolKey, type BoardPrice } from './chainBoard.js';
import type { Rpc } from './chainPrice.js';

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
const key = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 5));
const KEY = (n: number): string => encodeBase58(key(n));
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const mint = (): string => {
  const d = new Uint8Array(82);
  d[44] = 6;
  d[45] = 1;
  return b64(d);
};
const tokenAccount = (amount: bigint): string => {
  const d = new Uint8Array(165);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return b64(d);
};
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe('the board feed', () => {
  it('prices every pool on a network from one request per read, and sends only what changed', async () => {
    // Three CPMM pools: token KEY(41+i) against USDC; pool KEY(51+i) with vaults KEY(61+2i), KEY(62+2i).
    const pools = [0, 1, 2].map((i) => {
      const d = new Uint8Array(637);
      d.set(key(61 + 2 * i), 72);
      d.set(key(62 + 2 * i), 104);
      d.set(key(41 + i), 168);
      d.set(decodeBase58(USDC)!, 200);
      return d;
    });
    const usdcBalance = [2_000_000n, 4_000_000n, 6_000_000n];
    const calls: string[][] = [];
    const rpc: Rpc = async (method, params) => {
      if (method === 'getAccountInfo') {
        const i = [51, 52, 53].findIndex((n) => KEY(n) === params[0]);
        return { value: { owner: CPMM, data: [b64(pools[i]!), 'base64'] } };
      }
      const list = params[0] as string[];
      calls.push(list);
      return {
        value: list.map((a) => {
          if (a === USDC || [41, 42, 43].some((n) => KEY(n) === a)) return { data: [mint(), 'base64'] };
          for (let i = 0; i < 3; i++) {
            if (a === KEY(61 + 2 * i)) return { data: [tokenAccount(1_000_000_000n), 'base64'] };
            if (a === KEY(62 + 2 * i)) return { data: [tokenAccount(usdcBalance[i]!), 'base64'] };
          }
          return null;
        }),
      };
    };
    const sent: BoardPrice[][] = [];
    let timer: (() => void) | null = null;
    const feed = createBoardFeed({
      rpc: () => rpc,
      usdOf: async () => null,
      isHidden: () => false,
      setTimer: (fn) => {
        timer = fn;
        return 1;
      },
      clearTimer: () => {
        timer = null;
      },
      onPrices: (l) => sent.push(l),
    });
    feed.setPools([0, 1, 2].map((i) => ({ chain: 'solana' as const, pool: KEY(51 + i), address: KEY(41 + i) })));
    await settle();
    timer!();
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.map((p) => p.usd.toFixed(4))).toEqual(['0.0020', '0.0040', '0.0060']);
    expect(sent[0]![0]!.key).toBe(poolKey('solana', KEY(51)));
    // The three pools' six vaults were read in one request (the node answers up to ten accounts to one).
    expect(calls.at(-1)).toHaveLength(6);
    // Nothing moved: nothing is sent. One pool moved: only it is sent.
    timer!();
    await settle();
    expect(sent).toHaveLength(1);
    usdcBalance[1] = 8_000_000n;
    timer!();
    await settle();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toHaveLength(1);
    expect(sent[1]![0]!.usd).toBeCloseTo(0.008, 9);
    feed.stop();
  });

  it('prices Ethereum-style pools through one batched request, and skips a pool whose kind it cannot read', async () => {
    const TOKEN = '0x00000000000000000000000000000000000000b1';
    const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
    const POOL = '0x00000000000000000000000000000000000000aa';
    const BAD = '0x00000000000000000000000000000000000000ab';
    const addr = (a: string): string => `0x${a.slice(2).padStart(64, '0')}`;
    const num = (n: bigint): string => n.toString(16).padStart(64, '0');
    const reserves = `0x${num(10n ** 24n)}${num(100n * 10n ** 18n)}${num(0n)}`;
    const rpc: Rpc = async (_m, params) => {
      const { to, data } = params[0] as { to: string; data: string };
      if (to === BAD && data !== '0x0dfe1681' && data !== '0xd21220a7' && data !== '0x313ce567') throw new Error('revert');
      if (data === '0x0dfe1681') return addr(TOKEN);
      if (data === '0xd21220a7') return addr(WETH);
      if (data === '0x313ce567') return `0x${num(18n)}`;
      if (data === '0x0902f1ac') return reserves;
      throw new Error('revert');
    };
    let batches = 0;
    const sent: BoardPrice[][] = [];
    let timer: (() => void) | null = null;
    const feed = createBoardFeed({
      rpc: () => rpc,
      batch: () => async (calls) => {
        batches++;
        return calls.map(() => reserves);
      },
      usdOf: async () => 2000,
      isHidden: () => false,
      setTimer: (fn) => {
        timer = fn;
        return 1;
      },
      clearTimer: () => undefined,
      onPrices: (l) => sent.push(l),
    });
    feed.setPools([
      { chain: 'ethereum', pool: POOL, address: TOKEN },
      { chain: 'ethereum', pool: BAD, address: TOKEN },
    ]);
    await settle();
    timer!();
    await settle();
    expect(batches).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(1);
    expect(sent[0]![0]!.usd).toBeCloseTo(0.2, 9);
    expect(sent[0]![0]!.key).toBe(`ethereum:${POOL}`);
    feed.stop();
  });

  it('reads nothing while the tab is hidden', async () => {
    let reads = 0;
    let timer: (() => void) | null = null;
    const feed = createBoardFeed({
      rpc: () => async () => {
        reads++;
        return null;
      },
      usdOf: async () => null,
      isHidden: () => true,
      setTimer: (fn) => {
        timer = fn;
        return 1;
      },
      clearTimer: () => undefined,
      onPrices: () => undefined,
    });
    feed.setPools([{ chain: 'solana', pool: KEY(51), address: KEY(41) }]);
    await settle();
    const before = reads;
    timer!();
    await settle();
    expect(reads).toBe(before);
    feed.stop();
  });
});
