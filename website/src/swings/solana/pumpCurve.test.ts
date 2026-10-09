import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { PumpCurveAdapter, parsePumpCurve, parsePumpCurveGlobal, pumpCurveInstructions } from './pumpCurve.js';
import { PUMP_PROGRAM } from './pumpswap.js';

const SOL = 'So11111111111111111111111111111111111111112';
const MINT = 'E7cw2vycqvtGcwB2W7WGPZeLHPVHAJqckyqXzHC5pump';
const USER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const key = (n: number): string => new web3.PublicKey(new Uint8Array(32).fill(n)).toBase58();

function curveBytes(o: { complete?: boolean; quote?: string; vt?: bigint; vs?: bigint; rt?: bigint } = {}): Uint8Array {
  const d = new Uint8Array(166);
  const v = new DataView(d.buffer);
  v.setBigUint64(8, o.vt ?? 1_000_000_000_000n, true);
  v.setBigUint64(16, o.vs ?? 30_000_000_000n, true);
  v.setBigUint64(24, o.rt ?? 800_000_000_000n, true);
  d[48] = o.complete ? 1 : 0;
  d.set(new web3.PublicKey(key(7)).toBytes(), 49);
  d.set(new web3.PublicKey(o.quote ?? '11111111111111111111111111111111').toBytes(), 83);
  return d;
}
const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');

function adapterWith(curve: Uint8Array | null, mintOwner = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', now = 5): PumpCurveAdapter {
  const probe = new PumpCurveAdapter(web3, async () => ({}) as never);
  const curveAddr = probe.curveAddress(MINT);
  const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    if (method !== 'getMultipleAccounts') throw new Error('unexpected');
    const keys = (params[0] as string[]);
    return { value: keys.map((k) => (k === curveAddr && curve ? { owner: PUMP_PROGRAM, data: [b64(curve), 'base64'] } : k === MINT ? { owner: mintOwner, data: ['', 'base64'] } : null)) } as T;
  };
  return new PumpCurveAdapter(web3, rpc, () => now);
}

describe('the pump.fun bonding curve', () => {
  it('reads a curve account and the global fee recipients', () => {
    expect(parsePumpCurve(web3, curveBytes())).toMatchObject({ virtualTokens: 1_000_000_000_000n, virtualSol: 30_000_000_000n, complete: false, creator: key(7) });
    expect(parsePumpCurve(web3, new Uint8Array(50))).toBeNull();
    const g = new Uint8Array(1088);
    g.set(new web3.PublicKey(key(1)).toBytes(), 41);
    g.set(new web3.PublicKey(key(2)).toBytes(), 483);
    g.set(new web3.PublicKey(key(3)).toBytes(), 741);
    expect(parsePumpCurveGlobal(web3, g)).toEqual({ feeRecipient: key(1), reservedFeeRecipient: key(2), buybackFeeRecipient: key(3) });
    expect(parsePumpCurveGlobal(web3, new Uint8Array(100))).toBeNull();
  });

  it('finds an open curve in either order of the pair, with the token program of the mint', async () => {
    const a = adapterWith(curveBytes());
    const ref = (address: string) => ({ chain: 'solana' as const, address });
    for (const [x, y] of [[SOL, MINT], [MINT, SOL]] as const) {
      const [pool] = await a.getPools(ref(x), ref(y));
      expect(pool).toMatchObject({ status: 'active', reserve0: 1_000_000_000_000n, reserve1: 30_000_000_000n, token0: ref(MINT), token1: ref(SOL) });
      expect(pool!.ref).toEqual({ chain: 'solana', dex: 'pump-curve', address: a.curveAddress(MINT) });
    }
  });

  it('does not offer a completed curve, a curve priced in another token, or a pair without SOL', async () => {
    const ref = (address: string) => ({ chain: 'solana' as const, address });
    expect((await adapterWith(curveBytes({ complete: true })).getPools(ref(SOL), ref(MINT)))[0]!.status).toBe('inactive');
    expect((await adapterWith(curveBytes({ quote: key(9) })).getPools(ref(SOL), ref(MINT)))[0]!.status).toBe('inactive');
    expect((await adapterWith(curveBytes({ rt: 0n })).getPools(ref(SOL), ref(MINT)))[0]!.status).toBe('inactive');
    expect(await adapterWith(null).getPools(ref(SOL), ref(MINT))).toEqual([]);
    expect(await adapterWith(curveBytes()).getPools(ref(MINT), ref(key(4)))).toEqual([]);
    await expect(adapterWith(curveBytes()).getPools(ref(SOL), ref(SOL))).rejects.toThrow(/Invalid/);
  });

  it('builds a buy that unwraps the wrapped SOL first, and a sell that does not', async () => {
    const a = adapterWith(curveBytes());
    const g = new Uint8Array(1088);
    g.set(new web3.PublicKey(key(1)).toBytes(), 41);
    g.set(new web3.PublicKey(key(2)).toBytes(), 483);
    g.set(new web3.PublicKey(key(3)).toBytes(), 741);
    const rpcWithGlobal = async <T>(_m: string, params: unknown[]): Promise<T> => ({ value: (params[0] as string[]).map(() => ({ owner: PUMP_PROGRAM, data: [b64(g), 'base64'] })) }) as T;
    const adapter = new PumpCurveAdapter(web3, rpcWithGlobal);
    const [pool] = await a.getPools({ chain: 'solana', address: SOL }, { chain: 'solana', address: MINT });
    const wsol = key(5);
    const tok = key(6);
    const buy = await pumpCurveInstructions(web3, adapter, USER, pool!, { chain: 'solana', address: SOL }, wsol, tok, 1_000n, 5n);
    expect(buy).toHaveLength(3);
    expect(buy[2]!.programId.toBase58()).toBe(PUMP_PROGRAM);
    expect(buy[2]!.keys.some((k) => k.pubkey.toBase58() === key(1) && k.isWritable)).toBe(true);
    expect(buy[2]!.keys.some((k) => k.pubkey.toBase58() === key(3) && k.isWritable)).toBe(true);
    expect(buy[2]!.keys.find((k) => k.isSigner)!.pubkey.toBase58()).toBe(USER);
    const sell = await pumpCurveInstructions(web3, adapter, USER, pool!, { chain: 'solana', address: MINT }, tok, wsol, 1_000n, 5n);
    expect(sell).toHaveLength(1);
    expect(Buffer.from(sell[0]!.data).subarray(0, 8)).toEqual(Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]));
    await expect(pumpCurveInstructions(web3, adapter, USER, pool!, { chain: 'solana', address: SOL }, wsol, tok, 0n, 5n)).rejects.toThrow(/above zero/);
    await expect(pumpCurveInstructions(web3, adapter, USER, pool!, { chain: 'solana', address: SOL }, wsol, tok, 5n, 0n)).rejects.toThrow(/minimum/);
    await expect(pumpCurveInstructions(web3, adapter, USER, pool!, { chain: 'solana', address: key(8) }, wsol, tok, 5n, 1n)).rejects.toThrow(/not in this curve/);
  });
});
