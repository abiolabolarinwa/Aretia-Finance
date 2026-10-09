import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { BOOP_PROGRAM, BoopAdapter, boopSwapInstructions, parseBoopCurve } from './boopCurve.js';
import { MOONSHOT_PROGRAM, MoonshotAdapter, moonshotSwapInstructions, parseMoonshotConfig, parseMoonshotCurve } from './moonshotCurve.js';

const SOL = 'So11111111111111111111111111111111111111112';
const MINT = '13L8jrQqmJCXXLejW26KGkzXJhFFoMNvnLhawYdMboop';
const USER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const key = (n: number): string => new web3.PublicKey(new Uint8Array(32).fill(n)).toBase58();
const put = (d: Uint8Array, o: number, a: string): void => d.set(new web3.PublicKey(a).toBytes(), o);
const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
const ref = (address: string) => ({ chain: 'solana' as const, address });

describe('Boop', () => {
  const DISC = [23, 183, 248, 55, 96, 216, 172, 96];
  function curve(o: { status?: number; mint?: string; tokens?: bigint } = {}): Uint8Array {
    const d = new Uint8Array(200);
    d.set(DISC, 0);
    const v = new DataView(d.buffer);
    put(d, 8, key(3));
    put(d, 40, o.mint ?? MINT);
    v.setBigUint64(72, 30n, true);
    v.setBigUint64(80, 1000n, true);
    v.setBigUint64(104, 5n, true);
    v.setBigUint64(112, o.tokens ?? 800n, true);
    d[124] = o.status ?? 0;
    return d;
  }
  const rpcFor = (bytes: Uint8Array | null, owner = BOOP_PROGRAM) => async <T>(): Promise<T> => ({ value: [bytes ? { owner, data: [b64(bytes), 'base64'] } : null] }) as T;

  it('reads a curve account', () => {
    expect(parseBoopCurve(web3, curve())).toMatchObject({ creator: key(3), mint: MINT, virtualSol: 30n, virtualTokens: 1000n, status: 0 });
    expect(parseBoopCurve(web3, new Uint8Array(200))).toBeNull();
    expect(parseBoopCurve(web3, new Uint8Array(10))).toBeNull();
  });

  it('finds a trading curve in either order of the pair, and not a graduated, mismatched, foreign or missing one', async () => {
    for (const [x, y] of [[SOL, MINT], [MINT, SOL]] as const) {
      const [pool] = await new BoopAdapter(web3, rpcFor(curve()), () => 4).getPools(ref(x), ref(y));
      expect(pool).toMatchObject({ status: 'active', token0: ref(MINT), token1: ref(SOL) });
    }
    expect((await new BoopAdapter(web3, rpcFor(curve({ status: 1 }))).getPools(ref(SOL), ref(MINT)))[0]!.status).toBe('inactive');
    expect((await new BoopAdapter(web3, rpcFor(curve({ tokens: 0n }))).getPools(ref(SOL), ref(MINT)))[0]!.status).toBe('inactive');
    expect(await new BoopAdapter(web3, rpcFor(curve({ mint: key(9) }))).getPools(ref(SOL), ref(MINT))).toEqual([]);
    expect(await new BoopAdapter(web3, rpcFor(curve(), TOKEN_PROGRAM)).getPools(ref(SOL), ref(MINT))).toEqual([]);
    expect(await new BoopAdapter(web3, rpcFor(null)).getPools(ref(SOL), ref(MINT))).toEqual([]);
    expect(await new BoopAdapter(web3, rpcFor(curve())).getPools(ref(MINT), ref(key(4)))).toEqual([]);
    await expect(new BoopAdapter(web3, rpcFor(null)).getPools(ref(SOL), ref(SOL))).rejects.toThrow(/Invalid/);
  });

  it('builds a buy that unwraps the wrapped SOL first and a sell that does not, and refuses bad input', async () => {
    const a = new BoopAdapter(web3, rpcFor(curve()), () => 4);
    const [pool] = await a.getPools(ref(SOL), ref(MINT));
    const buy = boopSwapInstructions(web3, a, USER, pool!, ref(SOL), key(10), key(11), 100n, 5n);
    expect(buy).toHaveLength(3);
    expect(buy[2]!.programId.toBase58()).toBe(BOOP_PROGRAM);
    expect(Buffer.from(buy[2]!.data).subarray(0, 8)).toEqual(Buffer.from([138, 127, 14, 91, 38, 87, 115, 105]));
    expect(buy[2]!.keys.find((k) => k.isSigner)!.pubkey.toBase58()).toBe(USER);
    const sell = boopSwapInstructions(web3, a, USER, pool!, ref(MINT), key(11), key(10), 100n, 5n);
    expect(sell).toHaveLength(1);
    expect(Buffer.from(sell[0]!.data).subarray(0, 8)).toEqual(Buffer.from([109, 61, 40, 187, 230, 176, 135, 174]));
    expect(() => boopSwapInstructions(web3, a, USER, pool!, ref(SOL), key(10), key(11), 0n, 5n)).toThrow(/above zero/);
    expect(() => boopSwapInstructions(web3, a, USER, pool!, ref(SOL), key(10), key(11), 5n, 0n)).toThrow(/minimum/);
    expect(() => boopSwapInstructions(web3, a, USER, pool!, ref(key(12)), key(10), key(11), 5n, 1n)).toThrow(/not in this curve/);
  });
});

describe('Moonit (Moonshot)', () => {
  const MOONMINT = '6r3pKypcRBUvcUdCDNYya4bBmZbsUob1waSe8NN7moon';
  const DISC = [8, 91, 83, 28, 132, 216, 248, 22];
  function curve(o: { mint?: string; amount?: bigint; collateral?: number } = {}): Uint8Array {
    const d = new Uint8Array(100);
    d.set(DISC, 0);
    const v = new DataView(d.buffer);
    v.setBigUint64(8, 1_000_000n, true);
    v.setBigUint64(16, o.amount ?? 700_000n, true);
    put(d, 24, o.mint ?? MOONMINT);
    d[56] = 9;
    d[57] = o.collateral ?? 0;
    return d;
  }
  const config = (): Uint8Array => {
    const d = new Uint8Array(200);
    put(d, 104, key(20));
    put(d, 136, key(21));
    return d;
  };
  const configAddress = new MoonshotAdapter(web3, async () => ({}) as never).config();
  const rpcFor = (bytes: Uint8Array | null, owner = MOONSHOT_PROGRAM) => async <T>(_m: string, params: unknown[]): Promise<T> =>
    ({ value: (params[0] as string[]).map((k) => (k === configAddress ? { owner: MOONSHOT_PROGRAM, data: [b64(config()), 'base64'] } : bytes ? { owner, data: [b64(bytes), 'base64'] } : null)) }) as T;

  it('reads a curve and the fee accounts of the config', () => {
    expect(parseMoonshotCurve(web3, curve())).toMatchObject({ totalSupply: 1_000_000n, curveAmount: 700_000n, mint: MOONMINT, decimals: 9, collateral: 0 });
    expect(parseMoonshotCurve(web3, new Uint8Array(100))).toBeNull();
    expect(parseMoonshotConfig(web3, config())).toEqual({ helioFee: key(20), dexFee: key(21) });
    expect(parseMoonshotConfig(web3, new Uint8Array(20))).toBeNull();
  });

  it('finds a curve in either order of the pair, and not an empty, other-collateral, mismatched, foreign or missing one', async () => {
    for (const [x, y] of [[SOL, MOONMINT], [MOONMINT, SOL]] as const) {
      const [pool] = await new MoonshotAdapter(web3, rpcFor(curve()), () => 4).getPools(ref(x), ref(y));
      expect(pool).toMatchObject({ status: 'active', token0: ref(MOONMINT), token1: ref(SOL) });
    }
    expect((await new MoonshotAdapter(web3, rpcFor(curve({ amount: 0n }))).getPools(ref(SOL), ref(MOONMINT)))[0]!.status).toBe('inactive');
    expect((await new MoonshotAdapter(web3, rpcFor(curve({ collateral: 1 }))).getPools(ref(SOL), ref(MOONMINT)))[0]!.status).toBe('inactive');
    expect(await new MoonshotAdapter(web3, rpcFor(curve({ mint: key(9) }))).getPools(ref(SOL), ref(MOONMINT))).toEqual([]);
    expect(await new MoonshotAdapter(web3, rpcFor(curve(), TOKEN_PROGRAM)).getPools(ref(SOL), ref(MOONMINT))).toEqual([]);
    expect(await new MoonshotAdapter(web3, rpcFor(null)).getPools(ref(SOL), ref(MOONMINT))).toEqual([]);
    expect(await new MoonshotAdapter(web3, rpcFor(curve())).getPools(ref(MOONMINT), ref(key(4)))).toEqual([]);
  });

  it('builds a buy that unwraps the wrapped SOL first and a sell that does not, naming the fee accounts of the config', async () => {
    const a = new MoonshotAdapter(web3, rpcFor(curve()), () => 4);
    const [pool] = await a.getPools(ref(SOL), ref(MOONMINT));
    const buy = await moonshotSwapInstructions(web3, a, USER, pool!, ref(SOL), key(10), key(11), 100n, 5n);
    expect(buy).toHaveLength(3);
    expect(Buffer.from(buy[2]!.data).subarray(0, 8)).toEqual(Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]));
    expect(buy[2]!.keys.map((k) => k.pubkey.toBase58())).toEqual(expect.arrayContaining([key(20), key(21)]));
    const sell = await moonshotSwapInstructions(web3, a, USER, pool!, ref(MOONMINT), key(11), key(10), 100n, 5n);
    expect(sell).toHaveLength(1);
    expect(Buffer.from(sell[0]!.data).subarray(0, 8)).toEqual(Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]));
    await expect(moonshotSwapInstructions(web3, a, USER, pool!, ref(SOL), key(10), key(11), 0n, 5n)).rejects.toThrow(/above zero/);
    await expect(moonshotSwapInstructions(web3, a, USER, pool!, ref(SOL), key(10), key(11), 5n, 0n)).rejects.toThrow(/minimum/);
    await expect(moonshotSwapInstructions(web3, a, USER, pool!, ref(key(12)), key(10), key(11), 5n, 1n)).rejects.toThrow(/not in this curve/);
  });

  it('fails clearly when the config cannot be read', async () => {
    const a = new MoonshotAdapter(web3, async <T>() => ({ value: [null] }) as T, () => 4);
    await expect(a.feeAccounts()).rejects.toThrow(/configuration could not be read/);
  });
});
