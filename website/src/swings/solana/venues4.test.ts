import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { AMM_V4_PROGRAM, AmmV4Adapter, ammV4SwapInstruction, parseAmmV4Pool } from './raydiumAmmV4.js';
import { CLMM_PROGRAM, ClmmAdapter, clmmSwapInstruction, parseClmmPool, tickArrayStart } from './raydiumClmm.js';
import { MANIFEST_PROGRAM, ManifestAdapter, manifestMarketHints, manifestSwapInstruction, parseManifestMarket } from './manifest.js';

const SOL = 'So11111111111111111111111111111111111111112';
const MINT = 'E7cw2vycqvtGcwB2W7WGPZeLHPVHAJqckyqXzHC5pump';
const USER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const key = (n: number): string => new web3.PublicKey(new Uint8Array(32).fill(n)).toBase58();
const put = (d: Uint8Array, o: number, a: string): void => d.set(new web3.PublicKey(a).toBytes(), o);
const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
const ref = (address: string) => ({ chain: 'solana' as const, address });
const POOL = key(20);
const hintsFor = (...addrs: string[]) => async (): Promise<string[]> => addrs;
/** The balance a token account holds, in the layout the SPL token program uses. */
const tokenAccount = (amount: bigint): Uint8Array => {
  const d = new Uint8Array(165);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return d;
};

describe('Raydium AMM v4', () => {
  function pool(o: { status?: bigint; coin?: string; pc?: string; size?: number; pnlCoin?: bigint } = {}): Uint8Array {
    const d = new Uint8Array(o.size ?? 752);
    const v = new DataView(d.buffer);
    v.setBigUint64(0, o.status ?? 6n, true);
    v.setBigUint64(176, 25n, true);
    v.setBigUint64(184, 10000n, true);
    v.setBigUint64(192, o.pnlCoin ?? 0n, true);
    put(d, 336, key(1));
    put(d, 368, key(2));
    put(d, 400, o.coin ?? MINT);
    put(d, 432, o.pc ?? SOL);
    return d;
  }
  const rpcFor = (state: Uint8Array | null, owner = AMM_V4_PROGRAM, vaultOwner = TOKEN_PROGRAM) => async <T>(_m: string, params: unknown[]): Promise<T> =>
    ({
      value: (params[0] as string[]).map((k) => (k === POOL && state ? { owner, data: [b64(state), 'base64'] } : k === key(1) ? { owner: vaultOwner, data: [b64(tokenAccount(1000n)), 'base64'] } : k === key(2) ? { owner: vaultOwner, data: [b64(tokenAccount(500n)), 'base64'] } : null)),
    }) as T;

  it('reads a pool account and refuses anything of another size', () => {
    expect(parseAmmV4Pool(web3, pool())).toMatchObject({ status: 6n, swapFeeNumerator: 25n, swapFeeDenominator: 10000n, coinVault: key(1), pcVault: key(2), coinMint: MINT, pcMint: SOL });
    expect(parseAmmV4Pool(web3, pool({ size: 700 }))).toBeNull();
  });

  it('verifies a hinted pool on-chain, in either order of the pair, with the balances its vaults hold less unclaimed profit', async () => {
    for (const [x, y] of [[SOL, MINT], [MINT, SOL]] as const) {
      const [p] = await new AmmV4Adapter(web3, rpcFor(pool({ pnlCoin: 100n })), () => 3, hintsFor(POOL)).getPools(ref(x), ref(y));
      expect(p).toMatchObject({ status: 'active', token0: ref(MINT), token1: ref(SOL), reserve0: 900n, reserve1: 500n, feePpm: 2500 });
    }
  });

  it('ignores a hint that is of another program, names other mints, has vaults of another program or is not swappable', async () => {
    const run = (state: Uint8Array | null, owner?: string, vaultOwner?: string) => new AmmV4Adapter(web3, rpcFor(state, owner, vaultOwner), () => 3, hintsFor(POOL)).getPools(ref(SOL), ref(MINT));
    expect(await run(pool(), TOKEN_PROGRAM)).toEqual([]);
    expect(await run(pool({ coin: key(9) }))).toEqual([]);
    expect(await run(pool(), AMM_V4_PROGRAM, CLMM_PROGRAM)).toEqual([]);
    expect(await run(null)).toEqual([]);
    expect((await run(pool({ status: 4n })))[0]!.status).toBe('inactive');
    expect(await new AmmV4Adapter(web3, rpcFor(pool()), () => 3, hintsFor()).getPools(ref(SOL), ref(MINT))).toEqual([]);
    await expect(run(null).then(() => new AmmV4Adapter(web3, rpcFor(null)).getPools(ref(SOL), ref(SOL)))).rejects.toThrow(/Invalid/);
  });

  it('builds a swap_base_in_v2 with the pool, its authority and its two vaults, and refuses bad input', async () => {
    const a = new AmmV4Adapter(web3, rpcFor(pool()), () => 3, hintsFor(POOL));
    const [p] = await a.getPools(ref(SOL), ref(MINT));
    const ix = ammV4SwapInstruction(web3, a, USER, p!, ref(SOL), key(10), key(11), 100n, 5n);
    expect(ix.programId.toBase58()).toBe(AMM_V4_PROGRAM);
    expect(ix.data[0]).toBe(16);
    expect(Buffer.from(ix.data).readBigUInt64LE(1)).toBe(100n);
    expect(Buffer.from(ix.data).readBigUInt64LE(9)).toBe(5n);
    expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([USER]);
    expect(ix.keys[2]!.pubkey.toBase58()).toBe(a.authority());
    expect(() => ammV4SwapInstruction(web3, a, USER, p!, ref(SOL), key(10), key(11), 0n, 5n)).toThrow(/above zero/);
    expect(() => ammV4SwapInstruction(web3, a, USER, p!, ref(SOL), key(10), key(11), 5n, 0n)).toThrow(/minimum/);
    expect(() => ammV4SwapInstruction(web3, a, USER, p!, ref(key(12)), key(10), key(11), 5n, 1n)).toThrow(/not in this pool/);
  });
});

describe('Raydium CLMM', () => {
  const DISC = [247, 237, 227, 245, 215, 195, 222, 70];
  function pool(o: { mint0?: string; mint1?: string; status?: number; liquidity?: bigint; tick?: number } = {}): Uint8Array {
    const d = new Uint8Array(1300);
    d.set(DISC, 0);
    const v = new DataView(d.buffer);
    put(d, 9, key(3));
    put(d, 73, o.mint0 ?? MINT);
    put(d, 105, o.mint1 ?? SOL);
    put(d, 137, key(4));
    put(d, 169, key(5));
    put(d, 201, key(6));
    v.setUint16(235, 10, true);
    v.setBigUint64(237, o.liquidity ?? 1_000_000n, true);
    // sqrt price 1.0 in Q64.64: the 128-bit value 2^64, low half zero and high half one
    v.setBigUint64(253, 0n, true);
    v.setBigUint64(261, 1n, true);
    v.setInt32(269, o.tick ?? -1234, true);
    d[389] = o.status ?? 0;
    return d;
  }
  const cfg = (): Uint8Array => {
    const d = new Uint8Array(100);
    new DataView(d.buffer).setUint32(47, 2500, true);
    return d;
  };
  const probe = new ClmmAdapter(web3, async () => ({}) as never);
  const rpcFor = (state: Uint8Array | null, owner = CLMM_PROGRAM, existingArrays: string[] = []) => async <T>(_m: string, params: unknown[]): Promise<T> =>
    ({
      value: (params[0] as string[]).map((k) =>
        k === POOL && state ? { owner, data: [b64(state), 'base64'] } : k === key(3) ? { owner: CLMM_PROGRAM, data: [b64(cfg()), 'base64'] } : existingArrays.includes(k) ? { owner: CLMM_PROGRAM, data: ['', 'base64'] } : k === MINT || k === SOL ? { owner: TOKEN_PROGRAM, data: ['', 'base64'] } : null,
      ),
    }) as T;

  it('works out which range of ticks a tick lies in', () => {
    expect(tickArrayStart(0, 10)).toBe(0);
    expect(tickArrayStart(599, 10)).toBe(0);
    expect(tickArrayStart(600, 10)).toBe(600);
    expect(tickArrayStart(-1, 10)).toBe(-600);
    expect(tickArrayStart(-1234, 10)).toBe(-1800);
  });

  it('reads a pool account', () => {
    expect(parseClmmPool(web3, pool())).toMatchObject({ ammConfig: key(3), mint0: MINT, mint1: SOL, tickSpacing: 10, liquidity: 1_000_000n, sqrtPriceX64: 1n << 64n, tickCurrent: -1234, status: 0 });
    expect(parseClmmPool(web3, new Uint8Array(1300))).toBeNull();
    expect(parseClmmPool(web3, new Uint8Array(10))).toBeNull();
  });

  it('verifies a hinted pool on-chain, in either order, with its fee and an approximate depth', async () => {
    for (const [x, y] of [[SOL, MINT], [MINT, SOL]] as const) {
      const [p] = await new ClmmAdapter(web3, rpcFor(pool()), () => 3, hintsFor(POOL)).getPools(ref(x), ref(y));
      expect(p).toMatchObject({ status: 'active', model: 'concentrated', token0: ref(MINT), token1: ref(SOL), feePpm: 2500, reserve0: 1_000_000n, reserve1: 1_000_000n });
      expect(p!.extra).toMatchObject({ program0: TOKEN_PROGRAM, program1: TOKEN_PROGRAM, tickSpacing: '10', tickCurrent: '-1234' });
    }
  });

  it('ignores a hint of another program or other mints, and marks a disabled or empty pool inactive', async () => {
    const run = (state: Uint8Array | null, owner?: string) => new ClmmAdapter(web3, rpcFor(state, owner), () => 3, hintsFor(POOL)).getPools(ref(SOL), ref(MINT));
    expect(await run(pool(), TOKEN_PROGRAM)).toEqual([]);
    expect(await run(pool({ mint0: key(9) }))).toEqual([]);
    expect(await run(null)).toEqual([]);
    expect((await run(pool({ status: 0b100 })))[0]!.status).toBe('inactive');
    expect((await run(pool({ liquidity: 0n })))[0]!.status).toBe('inactive');
  });

  it('passes the current range and then the next existing ones in the direction of the swap', async () => {
    const start = tickArrayStart(-1234, 10);
    const next = [-1, -2, -3].map((i) => probe.tickArray(POOL, start + i * 600));
    const a = new ClmmAdapter(web3, rpcFor(pool(), CLMM_PROGRAM, [next[0]!, next[2]!]), () => 3, hintsFor(POOL));
    const arrays = await a.tickArraysFor(POOL, { tickCurrent: -1234, tickSpacing: 10 }, true);
    // The current range always; of the next ones below it, those that exist, up to two.
    expect(arrays).toEqual([probe.tickArray(POOL, start), next[0]!, next[2]!]);
    const up = await a.tickArraysFor(POOL, { tickCurrent: -1234, tickSpacing: 10 }, false);
    expect(up).toEqual([probe.tickArray(POOL, start)]);
  });

  it('builds a swap_v2 with the direction, the ranges and the bitmap extension, and refuses bad input', async () => {
    const a = new ClmmAdapter(web3, rpcFor(pool()), () => 3, hintsFor(POOL));
    const [p] = await a.getPools(ref(SOL), ref(MINT));
    const arrays = [a.tickArray(POOL, 0)];
    const down = clmmSwapInstruction(web3, a, USER, p!, ref(MINT), key(10), key(11), 100n, 5n, arrays);
    expect(down.programId.toBase58()).toBe(CLMM_PROGRAM);
    expect(Buffer.from(down.data).subarray(0, 8)).toEqual(Buffer.from([43, 4, 237, 11, 26, 201, 30, 98]));
    expect(down.keys[5]!.pubkey.toBase58()).toBe(key(4));
    const up = clmmSwapInstruction(web3, a, USER, p!, ref(SOL), key(10), key(11), 100n, 5n, arrays);
    expect(up.keys[5]!.pubkey.toBase58()).toBe(key(5));
    expect(down.keys.slice(-2).map((k) => k.pubkey.toBase58())).toEqual([a.bitmapExtension(POOL), arrays[0]]);
    expect(() => clmmSwapInstruction(web3, a, USER, p!, ref(SOL), key(10), key(11), 0n, 5n, arrays)).toThrow(/above zero/);
    expect(() => clmmSwapInstruction(web3, a, USER, p!, ref(SOL), key(10), key(11), 5n, 0n, arrays)).toThrow(/minimum/);
    expect(() => clmmSwapInstruction(web3, a, USER, p!, ref(SOL), key(10), key(11), 5n, 1n, [])).toThrow(/ranges/);
    expect(() => clmmSwapInstruction(web3, a, USER, p!, ref(key(12)), key(10), key(11), 5n, 1n, arrays)).toThrow(/not in this pool/);
  });
});

describe('Manifest', () => {
  function market(o: { base?: string; quote?: string; disc?: bigint } = {}): Uint8Array {
    const d = new Uint8Array(300);
    new DataView(d.buffer).setBigUint64(0, o.disc ?? 4859840929024028656n, true);
    put(d, 16, o.base ?? MINT);
    put(d, 48, o.quote ?? SOL);
    put(d, 80, key(1));
    put(d, 112, key(2));
    return d;
  }
  const rpcFor = (state: Uint8Array | null, owner = MANIFEST_PROGRAM) => async <T>(_m: string, params: unknown[]): Promise<T> =>
    ({
      value: (params[0] as string[]).map((k) => (k === POOL && state ? { owner, data: [b64(state), 'base64'] } : k === key(1) ? { owner: TOKEN_PROGRAM, data: [b64(tokenAccount(700n)), 'base64'] } : k === key(2) ? { owner: TOKEN_PROGRAM, data: [b64(tokenAccount(0n)), 'base64'] } : k === MINT || k === SOL ? { owner: TOKEN_PROGRAM, data: ['', 'base64'] } : null)),
    }) as T;

  it('reads a market account and refuses another kind', () => {
    expect(parseManifestMarket(web3, market())).toEqual({ baseMint: MINT, quoteMint: SOL, baseVault: key(1), quoteVault: key(2) });
    expect(parseManifestMarket(web3, market({ disc: 1n }))).toBeNull();
    expect(parseManifestMarket(web3, new Uint8Array(20))).toBeNull();
  });

  it('verifies a hinted market on-chain, in either order, with what its vaults hold', async () => {
    for (const [x, y] of [[SOL, MINT], [MINT, SOL]] as const) {
      const [p] = await new ManifestAdapter(web3, rpcFor(market()), () => 3, async () => [POOL]).getPools(ref(x), ref(y));
      expect(p).toMatchObject({ status: 'active', token0: ref(MINT), token1: ref(SOL), reserve0: 700n, reserve1: 0n });
    }
  });

  it('ignores a hint of another program, a mismatched market or a missing one', async () => {
    const run = (state: Uint8Array | null, owner?: string) => new ManifestAdapter(web3, rpcFor(state, owner), () => 3, async () => [POOL]).getPools(ref(SOL), ref(MINT));
    expect(await run(market(), TOKEN_PROGRAM)).toEqual([]);
    expect(await run(market({ base: key(9) }))).toEqual([]);
    expect(await run(null)).toEqual([]);
    expect(await new ManifestAdapter(web3, rpcFor(market()), () => 3, async () => []).getPools(ref(SOL), ref(MINT))).toEqual([]);
  });

  it('lists candidate markets from the public list: only the pair, markets with orders on both sides first, never a bad address', async () => {
    const rows = [
      { pool_id: key(31), base_currency: MINT, target_currency: SOL, bid: 0, ask: 0 },
      { pool_id: key(32), base_currency: MINT, target_currency: SOL, bid: 1, ask: 2 },
      { pool_id: key(33), base_currency: SOL, target_currency: MINT },
      { pool_id: key(34), base_currency: MINT, target_currency: key(9) },
      { pool_id: 'not an address!', base_currency: MINT, target_currency: SOL },
      { nonsense: true },
    ];
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(JSON.stringify(rows));
    }) as unknown as typeof fetch;
    const hints = manifestMarketHints(f, () => 1000);
    expect(await hints(MINT, SOL)).toEqual([key(32), key(31), key(33)]);
    expect(await hints(SOL, MINT)).toHaveLength(3);
    expect(calls).toBe(1);
    expect(await manifestMarketHints((async () => new Response('x', { status: 500 })) as unknown as typeof fetch)(MINT, SOL)).toEqual([]);
    expect(await manifestMarketHints((async () => new Response('{}')) as unknown as typeof fetch)(MINT, SOL)).toEqual([]);
    expect(await manifestMarketHints((async () => { throw new Error('offline'); }) as unknown as typeof fetch)(MINT, SOL)).toEqual([]);
  });

  it('builds a swap with the direction and the floor, and refuses bad input', async () => {
    const a = new ManifestAdapter(web3, rpcFor(market()), () => 3, async () => [POOL]);
    const [p] = await a.getPools(ref(SOL), ref(MINT));
    const buy = manifestSwapInstruction(web3, USER, p!, ref(SOL), key(10), key(11), 100n, 5n);
    expect(buy.programId.toBase58()).toBe(MANIFEST_PROGRAM);
    expect([...buy.data.subarray(0, 1), buy.data[17], buy.data[18]]).toEqual([4, 0, 1]);
    expect(Buffer.from(buy.data).readBigUInt64LE(1)).toBe(100n);
    expect(Buffer.from(buy.data).readBigUInt64LE(9)).toBe(5n);
    // Buying the base token: the user's quote account is the input (key 10), the base account the output (key 11).
    expect(buy.keys[3]!.pubkey.toBase58()).toBe(key(11));
    expect(buy.keys[4]!.pubkey.toBase58()).toBe(key(10));
    const sell = manifestSwapInstruction(web3, USER, p!, ref(MINT), key(11), key(10), 100n, 5n);
    expect(sell.data[17]).toBe(1);
    expect(() => manifestSwapInstruction(web3, USER, p!, ref(SOL), key(10), key(11), 0n, 5n)).toThrow(/above zero/);
    expect(() => manifestSwapInstruction(web3, USER, p!, ref(SOL), key(10), key(11), 5n, 0n)).toThrow(/minimum/);
    expect(() => manifestSwapInstruction(web3, USER, p!, ref(key(12)), key(10), key(11), 5n, 1n)).toThrow(/not in this market/);
  });
});
