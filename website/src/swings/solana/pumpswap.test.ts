import { describe, expect, it } from 'vitest';
import * as web3 from '@solana/web3.js';
import { parsePumpGlobal, parsePumpPool, PUMP_FEE_PROGRAM, PUMPSWAP_PROGRAM, PumpSwapAdapter, pumpSwapInstructions } from './pumpswap.js';
import type { SolRpc } from './raydiumCpmm.js';
import type { LiquidityPool } from '../engine/types.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const key = (): string => web3.Keypair.generate().publicKey.toBase58();
const USER = key();
const MINT = key();
const CREATOR = key();
const idle = new PumpSwapAdapter(web3, (async () => ({})) as never);

function poolBytes(over: { index?: number; base?: string; quote?: string; cashback?: boolean } = {}): { bytes: Uint8Array; baseVault: string; quoteVault: string } {
  const d = new Uint8Array(301);
  const baseVault = key();
  const quoteVault = key();
  new DataView(d.buffer).setUint16(9, over.index ?? 0, true);
  const put = (o: number, k: string) => d.set(new web3.PublicKey(k).toBytes(), o);
  put(11, key());
  put(43, over.base ?? MINT);
  put(75, over.quote ?? WSOL);
  put(107, key());
  put(139, baseVault);
  put(171, quoteVault);
  put(211, CREATOR);
  d[244] = over.cashback ? 1 : 0;
  return { bytes: d, baseVault, quoteVault };
}

function globalBytes(opts: { disable?: number } = {}): { bytes: Uint8Array; protocol: string; buyback: string } {
  const d = new Uint8Array(949);
  const v = new DataView(d.buffer);
  v.setBigUint64(40, 20n, true);
  v.setBigUint64(48, 5n, true);
  d[56] = opts.disable ?? 0;
  const protocol = key();
  const buyback = key();
  d.set(new web3.PublicKey(protocol).toBytes(), 57);
  v.setBigUint64(313, 5n, true);
  d.set(new web3.PublicKey(buyback).toBytes(), 643);
  return { bytes: d, protocol, buyback };
}

const b64 = (d: Uint8Array) => btoa(String.fromCharCode(...d));
const tokenAcct = (amount: bigint) => {
  const d = new Uint8Array(165);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return b64(d);
};

describe('PumpSwap parsing', () => {
  it('reads a pool and the global config at the offsets the program lays out', () => {
    const p = poolBytes({ cashback: true });
    expect(parsePumpPool(web3, p.bytes)).toMatchObject({ index: 0, baseMint: MINT, quoteMint: WSOL, baseVault: p.baseVault, quoteVault: p.quoteVault, coinCreator: CREATOR, isCashback: true });
    expect(parsePumpPool(web3, new Uint8Array(100))).toBeNull();
    const g = globalBytes();
    expect(parsePumpGlobal(web3, g.bytes)).toMatchObject({ lpFeeBps: 20n, protocolFeeBps: 5n, coinCreatorFeeBps: 5n, disableFlags: 0, protocolFeeRecipients: [g.protocol], buybackFeeRecipients: [g.buyback] });
    expect(parsePumpGlobal(web3, new Uint8Array(10))).toBeNull();
  });
});

describe('PumpSwapAdapter', () => {
  it('derives the canonical pool the same way for every call, and differently for each token', () => {
    expect(idle.canonicalPool(MINT, WSOL)).toBe(idle.canonicalPool(MINT, WSOL));
    expect(idle.canonicalPool(MINT, WSOL)).not.toBe(idle.canonicalPool(key(), WSOL));
    expect(idle.canonicalPool(MINT, WSOL)).not.toBe(idle.canonicalPool(WSOL, MINT));
  });

  function rpcFor(opts: { pool?: ReturnType<typeof poolBytes>; global?: ReturnType<typeof globalBytes>; owner?: string; baseAmount?: bigint } = {}): SolRpc {
    const pool = opts.pool ?? poolBytes();
    const global = opts.global ?? globalBytes();
    const poolAddress = idle.canonicalPool(MINT, WSOL);
    return (async (_m: string, params: unknown[]) => ({
      value: (params[0] as string[]).map((a) => {
        if (a === poolAddress) return { data: [b64(pool.bytes), 'base64'], owner: opts.owner ?? PUMPSWAP_PROGRAM };
        if (a === idle.globalConfigAddress()) return { data: [b64(global.bytes), 'base64'], owner: PUMPSWAP_PROGRAM };
        if (a === pool.baseVault) return { data: [tokenAcct(opts.baseAmount ?? 5_000_000_000n), 'base64'], owner: TOKEN_2022 };
        if (a === pool.quoteVault) return { data: [tokenAcct(40_000_000_000n), 'base64'], owner: TOKEN_PROGRAM };
        return null;
      }),
    })) as SolRpc;
  }
  const pair = [{ chain: 'solana' as const, address: MINT }, { chain: 'solana' as const, address: WSOL }] as const;

  it('finds the canonical pool of a pair in either order, with both token programs and the vault balances', async () => {
    const a = new PumpSwapAdapter(web3, rpcFor(), () => 5);
    for (const [x, y] of [[pair[0], pair[1]], [pair[1], pair[0]]] as const) {
      const pools = await a.getPools(x, y);
      expect(pools).toHaveLength(1);
      expect(pools[0]).toMatchObject({ token0: { address: MINT }, token1: { address: WSOL }, reserve0: 5_000_000_000n, reserve1: 40_000_000_000n, status: 'active', feePpm: 3_000 });
      expect(pools[0]!.extra).toMatchObject({ baseProgram: TOKEN_2022, quoteProgram: TOKEN_PROGRAM, coinCreator: CREATOR });
    }
  });

  it('refuses pools from another program, at another index, or naming other mints, and marks disabled or empty pools inactive', async () => {
    expect(await new PumpSwapAdapter(web3, rpcFor({ owner: key() })).getPools(pair[0], pair[1])).toEqual([]);
    expect(await new PumpSwapAdapter(web3, rpcFor({ pool: poolBytes({ index: 3 }) })).getPools(pair[0], pair[1])).toEqual([]);
    expect(await new PumpSwapAdapter(web3, rpcFor({ pool: poolBytes({ base: key() }) })).getPools(pair[0], pair[1])).toEqual([]);
    expect((await new PumpSwapAdapter(web3, rpcFor({ global: globalBytes({ disable: 0b01000 }) })).getPools(pair[0], pair[1]))[0]!.status).toBe('inactive');
    expect((await new PumpSwapAdapter(web3, rpcFor({ baseAmount: 0n })).getPools(pair[0], pair[1]))[0]!.status).toBe('inactive');
    await expect(new PumpSwapAdapter(web3, rpcFor()).getPools(pair[0], pair[0])).rejects.toThrow();
  });
});

describe('PumpSwap instructions', () => {
  async function build(selling: boolean, amount = 1_000_000n, minOut = 7n) {
    const g = globalBytes();
    const p = poolBytes();
    const rpc = (async (_m: string, params: unknown[]) => ({ value: (params[0] as string[]).map((a) => (a === idle.globalConfigAddress() ? { data: [b64(g.bytes), 'base64'], owner: PUMPSWAP_PROGRAM } : null)) })) as SolRpc;
    const adapter = new PumpSwapAdapter(web3, rpc);
    const pool: LiquidityPool = { ref: { chain: 'solana', dex: 'pumpswap', address: idle.canonicalPool(MINT, WSOL) }, model: 'constant-product', token0: { chain: 'solana', address: MINT }, token1: { chain: 'solana', address: WSOL }, reserve0: 1n, reserve1: 1n, feePpm: 0, updatedAt: 1, block: null, status: 'active', extra: { baseVault: p.baseVault, quoteVault: p.quoteVault, coinCreator: CREATOR, baseProgram: TOKEN_PROGRAM, quoteProgram: TOKEN_PROGRAM, cashback: '0' } };
    const inAcct = key();
    const outAcct = key();
    const ixs = await pumpSwapInstructions(web3, adapter, USER, pool, { chain: 'solana', address: selling ? MINT : WSOL }, inAcct, outAcct, amount, minOut);
    return { ixs, g, pool, inAcct, outAcct, adapter };
  }

  it('selling the base token is sell: three idempotent account creations, then the swap with the trailing accounts', async () => {
    const { ixs, g, inAcct, outAcct, adapter } = await build(true);
    expect(ixs).toHaveLength(4);
    expect(ixs.slice(0, 3).every((i) => i.programId.toBase58() === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' && i.data[0] === 1)).toBe(true);
    const swap = ixs[3]!;
    expect([...swap.data.subarray(0, 8)]).toEqual([51, 230, 133, 164, 1, 127, 131, 173]);
    expect(swap.data.readBigUInt64LE(8)).toBe(1_000_000n);
    expect(swap.data.readBigUInt64LE(16)).toBe(7n);
    expect(swap.data.length).toBe(24);
    const k = swap.keys.map((x) => x.pubkey.toBase58());
    expect(k).toHaveLength(24);
    expect(k[1]).toBe(USER);
    expect(swap.keys[1]!.isSigner).toBe(true);
    expect(k[5]).toBe(inAcct); // the user's base account is the one sold
    expect(k[6]).toBe(outAcct);
    expect(k[9]).toBe(g.protocol);
    expect(k[19]).toBe(adapter.feeConfig());
    expect(k[20]).toBe(PUMP_FEE_PROGRAM);
    expect(k[21]).toBe(adapter.poolV2(MINT));
    expect(k[22]).toBe(g.buyback);
  });

  it('buying the base token is buy_exact_quote_in: spends exactly the quote amount, with volume tracking off', async () => {
    const { ixs, inAcct, outAcct, adapter } = await build(false, 2_500_000n, 99n);
    const swap = ixs[3]!;
    expect([...swap.data.subarray(0, 8)]).toEqual([198, 46, 21, 82, 180, 217, 232, 112]);
    expect(swap.data.readBigUInt64LE(8)).toBe(2_500_000n);
    expect(swap.data.readBigUInt64LE(16)).toBe(99n);
    expect(swap.data[24]).toBe(0);
    expect(swap.data.length).toBe(25);
    const k = swap.keys.map((x) => x.pubkey.toBase58());
    expect(k).toHaveLength(26);
    expect(k[5]).toBe(outAcct); // the user's base account receives
    expect(k[6]).toBe(inAcct);
    expect(k[19]).toBe(adapter.globalVolumeAccumulator());
    expect(k[20]).toBe(adapter.userVolumeAccumulator(USER));
    expect(swap.keys[20]!.isWritable).toBe(true);
  });

  it('refuses a zero amount, a zero minimum, a token outside the pool, and a pool of another venue', async () => {
    await expect(build(true, 0n)).rejects.toThrow(/above zero/);
    await expect(build(true, 5n, 0n)).rejects.toThrow(/minimum/);
    const { pool, adapter } = await build(true);
    await expect(pumpSwapInstructions(web3, adapter, USER, pool, { chain: 'solana', address: key() }, key(), key(), 5n, 5n)).rejects.toThrow(/not in this pool/);
    await expect(pumpSwapInstructions(web3, adapter, USER, { ...pool, ref: { ...pool.ref, dex: 'orca-whirlpool' } }, { chain: 'solana', address: MINT }, key(), key(), 5n, 5n)).rejects.toThrow(/cannot be swapped/);
  });
});
