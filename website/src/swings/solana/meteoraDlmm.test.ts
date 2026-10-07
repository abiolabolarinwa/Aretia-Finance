import { beforeEach, describe, expect, it } from 'vitest';
import * as web3 from '@solana/web3.js';
import { binArrayIndex, BINS_PER_ARRAY, dlmmSwapInstruction, METEORA_DLMM_PROGRAM, MeteoraDlmmAdapter, parseDlmmPair, parsePreset, resetDlmmPresetCache, walkIndexes } from './meteoraDlmm.js';
import { sortMints, type SolRpc } from './raydiumCpmm.js';
import type { LiquidityPool } from '../engine/types.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const key = (): string => web3.Keypair.generate().publicKey.toBase58();
const b64 = (d: Uint8Array) => btoa(String.fromCharCode(...d));
const [X, Y] = sortMints(web3, WSOL, USDC);

function pairBytes(over: { status?: number; activeId?: number; binStep?: number; baseFactor?: number; mintX?: string; mintY?: string } = {}) {
  const d = new Uint8Array(904);
  const v = new DataView(d.buffer);
  const put = (o: number, k: string) => d.set(new web3.PublicKey(k).toBytes(), o);
  const reserveX = key();
  const reserveY = key();
  const oracle = key();
  v.setUint16(8, over.baseFactor ?? 10_000, true);
  v.setInt32(76, over.activeId ?? 1_234, true);
  v.setUint16(80, over.binStep ?? 20, true);
  d[82] = over.status ?? 0;
  put(88, over.mintX ?? X);
  put(120, over.mintY ?? Y);
  put(152, reserveX);
  put(184, reserveY);
  put(552, oracle);
  return { bytes: d, reserveX, reserveY, oracle };
}
const presetBytes = (binStep: number, baseFactor: number): Uint8Array => {
  const d = new Uint8Array(20);
  const v = new DataView(d.buffer);
  v.setUint16(8, binStep, true);
  v.setUint16(10, baseFactor, true);
  return d;
};
const tokenAcct = (amount: bigint) => {
  const d = new Uint8Array(165);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return b64(d);
};

describe('DLMM bin arithmetic', () => {
  it('maps bin ids to the array that holds them, flooring toward negative infinity', () => {
    expect(BINS_PER_ARRAY).toBe(70);
    expect(binArrayIndex(0)).toBe(0);
    expect(binArrayIndex(69)).toBe(0);
    expect(binArrayIndex(70)).toBe(1);
    expect(binArrayIndex(-1)).toBe(-1);
    expect(binArrayIndex(-70)).toBe(-1);
    expect(binArrayIndex(-71)).toBe(-2);
  });
  it('walks down when selling X for Y and up when selling Y for X', () => {
    expect(walkIndexes(150, true, 3)).toEqual([2, 1, 0]);
    expect(walkIndexes(150, false, 3)).toEqual([2, 3, 4]);
    expect(walkIndexes(-5, true, 2)).toEqual([-1, -2]);
  });
});

describe('DLMM parsing', () => {
  it('reads a pool at the IDL offsets and a preset after its discriminator', () => {
    const p = pairBytes({ activeId: -42, binStep: 80, baseFactor: 7_500 });
    expect(parseDlmmPair(web3, p.bytes)).toMatchObject({ status: 0, activeId: -42, binStep: 80, baseFactor: 7_500, mintX: X, mintY: Y, reserveX: p.reserveX, reserveY: p.reserveY, oracle: p.oracle });
    expect(parseDlmmPair(web3, new Uint8Array(100))).toBeNull();
    expect(parsePreset(presetBytes(80, 7_500))).toEqual({ binStep: 80, baseFactor: 7_500 });
    expect(parsePreset(new Uint8Array(4))).toBeNull();
  });
});

describe('MeteoraDlmmAdapter', () => {
  beforeEach(() => resetDlmmPresetCache());
  const idle = new MeteoraDlmmAdapter(web3, (async () => ({})) as never);

  function rpc(opts: { presets?: [number, number][]; pools?: Record<string, ReturnType<typeof pairBytes>>; owner?: string; amounts?: [bigint, bigint]; existingArrays?: string[] }): SolRpc {
    const presets = opts.presets ?? [[20, 10_000], [80, 7_500]];
    return (async (method: string, params: unknown[]) => {
      if (method === 'getProgramAccounts') return presets.map(([s, f]) => ({ account: { data: [b64(presetBytes(s, f)), 'base64'] } }));
      const list = params[0] as string[];
      return {
        value: list.map((a) => {
          const pool = opts.pools?.[a];
          if (pool) return { data: [b64(pool.bytes), 'base64'], owner: opts.owner ?? METEORA_DLMM_PROGRAM };
          for (const p of Object.values(opts.pools ?? {})) {
            if (a === p.reserveX) return { data: [tokenAcct(opts.amounts?.[0] ?? 5_000_000_000n), 'base64'], owner: TOKEN };
            if (a === p.reserveY) return { data: [tokenAcct(opts.amounts?.[1] ?? 600_000_000n), 'base64'], owner: TOKEN };
          }
          if (opts.existingArrays?.includes(a)) return { data: ['', 'base64'], owner: METEORA_DLMM_PROGRAM };
          return null;
        }),
      };
    }) as SolRpc;
  }

  it('derives a pool for each preset, keeps the ones that exist and hold liquidity, and ignores the rest', async () => {
    const addr = idle.pairAddress(X, Y, 20, 10_000);
    const p = pairBytes({ binStep: 20, baseFactor: 10_000 });
    const a = new MeteoraDlmmAdapter(web3, rpc({ pools: { [addr]: p } }), () => 7);
    for (const [x, y] of [[WSOL, USDC], [USDC, WSOL]] as const) {
      const pools = await a.getPools({ chain: 'solana', address: x }, { chain: 'solana', address: y });
      expect(pools).toHaveLength(1);
      expect(pools[0]).toMatchObject({ ref: { dex: 'meteora-dlmm', address: addr }, token0: { address: X }, token1: { address: Y }, reserve0: 5_000_000_000n, reserve1: 600_000_000n, feePpm: 2_000, status: 'active' });
      expect(pools[0]!.extra).toMatchObject({ oracle: p.oracle, activeId: '1234', binStep: '20', programX: TOKEN, programY: TOKEN });
    }
  });

  it('refuses pools of another program, paused pools, pools naming other mints, and empty pools', async () => {
    const addr = idle.pairAddress(X, Y, 20, 10_000);
    const pair = [{ chain: 'solana' as const, address: WSOL }, { chain: 'solana' as const, address: USDC }] as const;
    expect(await new MeteoraDlmmAdapter(web3, rpc({ pools: { [addr]: pairBytes() }, owner: key() })).getPools(...pair)).toEqual([]);
    expect(await new MeteoraDlmmAdapter(web3, rpc({ pools: { [addr]: pairBytes({ status: 1 }) } })).getPools(...pair)).toEqual([]);
    expect(await new MeteoraDlmmAdapter(web3, rpc({ pools: { [addr]: pairBytes({ mintX: key() }) } })).getPools(...pair)).toEqual([]);
    expect(await new MeteoraDlmmAdapter(web3, rpc({ pools: { [addr]: pairBytes() }, amounts: [0n, 0n] })).getPools(...pair)).toEqual([]);
    expect(await new MeteoraDlmmAdapter(web3, rpc({ pools: {} })).getPools(...pair)).toEqual([]);
    await expect(new MeteoraDlmmAdapter(web3, rpc({})).getPools(pair[0], pair[0])).rejects.toThrow();
  });

  it('puts the deepest pools first and keeps only a handful', async () => {
    const presets: [number, number][] = Array.from({ length: 9 }, (_, i) => [10 + i, 10_000]);
    const pools: Record<string, ReturnType<typeof pairBytes>> = {};
    presets.forEach(([s, f]) => {
      pools[idle.pairAddress(X, Y, s, f)] = pairBytes({ binStep: s, baseFactor: f });
    });
    const a = new MeteoraDlmmAdapter(web3, rpc({ presets, pools }));
    const found = await a.getPools({ chain: 'solana', address: WSOL }, { chain: 'solana', address: USDC });
    expect(found).toHaveLength(6);
  });

  it('keeps only the bin arrays that exist, in the order the swap walks them', async () => {
    const pair = idle.pairAddress(X, Y, 20, 10_000);
    const idx = walkIndexes(1_234, true, 6); // 17, 16, 15, ...
    const exists = [idx[0]!, idx[2]!, idx[3]!].map((i) => idle.binArrayAddress(pair, i));
    const a = new MeteoraDlmmAdapter(web3, rpc({ existingArrays: exists }));
    const pool = { ref: { chain: 'solana' as const, dex: 'meteora-dlmm', address: pair }, extra: { activeId: '1234' } } as unknown as LiquidityPool;
    expect(await a.binArrays(pool, true)).toEqual(exists);
    expect(await a.binArrays(pool, false)).toEqual([exists[0]]);
  });
});

describe('DLMM swap instruction', () => {
  const adapterFor = (arrays: string[]) => {
    const a = new MeteoraDlmmAdapter(web3, (async () => ({ value: [] })) as never);
    a.binArrays = async () => arrays;
    return a;
  };
  const pool: LiquidityPool = {
    ref: { chain: 'solana', dex: 'meteora-dlmm', address: key() },
    model: 'concentrated',
    token0: { chain: 'solana', address: X },
    token1: { chain: 'solana', address: Y },
    reserve0: 1n,
    reserve1: 1n,
    feePpm: 0,
    updatedAt: 1,
    block: null,
    status: 'active',
    extra: { reserveX: key(), reserveY: key(), oracle: key(), activeId: '0', binStep: '20', programX: TOKEN, programY: TOKEN },
  };
  const USER = key();

  it('lays out the program\'s accounts, uses its own id for the absent optional ones, and appends the bin arrays', async () => {
    const arrays = [key(), key()];
    const inA = key();
    const outA = key();
    const ix = await dlmmSwapInstruction(web3, adapterFor(arrays), USER, pool, { chain: 'solana', address: X }, inA, outA, 1_000n, 9n);
    const k = ix.keys.map((m) => m.pubkey.toBase58());
    expect(k).toHaveLength(16 + 2);
    expect(k[0]).toBe(pool.ref.address);
    expect(k[1]).toBe(METEORA_DLMM_PROGRAM); // no bitmap extension
    expect(k[9]).toBe(METEORA_DLMM_PROGRAM); // no host fee
    expect(k[4]).toBe(inA);
    expect(k[5]).toBe(outA);
    expect(k[10]).toBe(USER);
    expect(ix.keys[10]!.isSigner).toBe(true);
    expect(k.slice(16)).toEqual(arrays);
    expect(ix.keys.slice(16).every((m) => m.isWritable)).toBe(true);
    expect([...ix.data.subarray(0, 8)]).toEqual([65, 75, 63, 76, 235, 91, 91, 136]);
    expect(ix.data.readBigUInt64LE(8)).toBe(1_000n);
    expect(ix.data.readBigUInt64LE(16)).toBe(9n);
    expect(ix.data.length).toBe(28);
    expect(ix.data.readUInt32LE(24)).toBe(0); // no remaining-account slices
  });

  it('refuses a zero amount, a zero minimum, a token outside the pool, a pool of another venue, and a swap with no liquidity to walk', async () => {
    const a = adapterFor([key()]);
    await expect(dlmmSwapInstruction(web3, a, USER, pool, { chain: 'solana', address: X }, key(), key(), 0n, 1n)).rejects.toThrow(/above zero/);
    await expect(dlmmSwapInstruction(web3, a, USER, pool, { chain: 'solana', address: X }, key(), key(), 5n, 0n)).rejects.toThrow(/minimum/);
    await expect(dlmmSwapInstruction(web3, a, USER, pool, { chain: 'solana', address: key() }, key(), key(), 5n, 1n)).rejects.toThrow(/not in this pool/);
    await expect(dlmmSwapInstruction(web3, a, USER, { ...pool, ref: { ...pool.ref, dex: 'orca-whirlpool' } }, { chain: 'solana', address: X }, key(), key(), 5n, 1n)).rejects.toThrow(/cannot be swapped/);
    await expect(dlmmSwapInstruction(web3, adapterFor([]), USER, pool, { chain: 'solana', address: X }, key(), key(), 5n, 1n)).rejects.toMatchObject({ code: 'no-route' });
  });
});
