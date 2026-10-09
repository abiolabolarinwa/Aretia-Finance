import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { LAUNCHLAB_PROGRAM, LaunchlabAdapter, launchlabSwapInstruction, parseLaunchlabPool } from './raydiumLaunchlab.js';
import { DBC_PROGRAM, DbcAdapter, dbcSwapInstruction, parseDbcConfigQuote, parseDbcPool } from './meteoraDbc.js';

const SOL = 'So11111111111111111111111111111111111111112';
const MINT = 'E7cw2vycqvtGcwB2W7WGPZeLHPVHAJqckyqXzHC5pump';
const USER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const key = (n: number): string => new web3.PublicKey(new Uint8Array(32).fill(n)).toBase58();
const put = (d: Uint8Array, o: number, a: string): void => d.set(new web3.PublicKey(a).toBytes(), o);
const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
const ref = (address: string) => ({ chain: 'solana' as const, address });

function launchlabBytes(o: { status?: number; base?: string; quote?: string; vb?: bigint } = {}): Uint8Array {
  const d = new Uint8Array(429);
  const v = new DataView(d.buffer);
  d[17] = o.status ?? 0;
  v.setBigUint64(37, o.vb ?? 1_000_000n, true);
  v.setBigUint64(45, 30_000n, true);
  put(d, 141, key(1));
  put(d, 173, key(2));
  put(d, 205, o.base ?? MINT);
  put(d, 237, o.quote ?? SOL);
  put(d, 269, key(3));
  put(d, 301, key(4));
  put(d, 333, key(5));
  return d;
}

const DISC_VIRTUAL_POOL = [213, 224, 5, 209, 98, 69, 119, 92];
function dbcBytes(o: { base?: string; migrated?: boolean; progress?: number; reserve?: bigint } = {}): Uint8Array {
  const d = new Uint8Array(424);
  d.set(DISC_VIRTUAL_POOL, 0);
  put(d, 72, key(6));
  put(d, 136, o.base ?? MINT);
  put(d, 168, key(7));
  put(d, 200, key(8));
  new DataView(d.buffer).setBigUint64(232, o.reserve ?? 5_000n, true);
  d[305] = o.migrated ? 1 : 0;
  d[308] = o.progress ?? 0;
  return d;
}

describe('Raydium LaunchLab', () => {
  const probe = new LaunchlabAdapter(web3, async () => ({}) as never);
  const poolAddr = probe.poolAddress(MINT, SOL);
  const rpcFor = (pool: Uint8Array | null, owner = LAUNCHLAB_PROGRAM) => async <T>(_m: string, params: unknown[]): Promise<T> =>
    ({ value: (params[0] as string[]).map((k) => (k === poolAddr && pool ? { owner, data: [b64(pool), 'base64'] } : pool ? { owner: TOKEN_PROGRAM, data: ['', 'base64'] } : null)) }) as T;

  it('reads a pool account', () => {
    expect(parseLaunchlabPool(web3, launchlabBytes())).toMatchObject({ status: 0, virtualBase: 1_000_000n, baseMint: MINT, quoteMint: SOL, creator: key(5) });
    expect(parseLaunchlabPool(web3, new Uint8Array(100))).toBeNull();
  });

  it('finds a trading pool in either order of the pair and names the token programs', async () => {
    const a = new LaunchlabAdapter(web3, rpcFor(launchlabBytes()), () => 9);
    for (const [x, y] of [[SOL, MINT], [MINT, SOL]] as const) {
      const [pool] = await a.getPools(ref(x), ref(y));
      expect(pool).toMatchObject({ status: 'active', token0: ref(MINT), token1: ref(SOL) });
      expect(pool!.extra).toMatchObject({ baseProgram: TOKEN_PROGRAM, quoteProgram: TOKEN_PROGRAM, creator: key(5) });
    }
  });

  it('does not offer a migrating pool, a pool of another program, a mismatched pool, or a pair without a quote token', async () => {
    expect((await new LaunchlabAdapter(web3, rpcFor(launchlabBytes({ status: 1 }))).getPools(ref(SOL), ref(MINT)))[0]!.status).toBe('inactive');
    expect(await new LaunchlabAdapter(web3, rpcFor(launchlabBytes(), TOKEN_PROGRAM)).getPools(ref(SOL), ref(MINT))).toEqual([]);
    expect(await new LaunchlabAdapter(web3, rpcFor(launchlabBytes({ base: key(9) }))).getPools(ref(SOL), ref(MINT))).toEqual([]);
    expect(await new LaunchlabAdapter(web3, rpcFor(null)).getPools(ref(SOL), ref(MINT))).toEqual([]);
    expect(await new LaunchlabAdapter(web3, rpcFor(launchlabBytes())).getPools(ref(MINT), ref(key(4)))).toEqual([]);
    await expect(new LaunchlabAdapter(web3, rpcFor(null)).getPools(ref(SOL), ref(SOL))).rejects.toThrow(/Invalid/);
  });

  it('builds a buy and a sell, and refuses bad amounts', async () => {
    const a = new LaunchlabAdapter(web3, rpcFor(launchlabBytes()), () => 9);
    const [pool] = await a.getPools(ref(SOL), ref(MINT));
    const buy = launchlabSwapInstruction(web3, a, USER, pool!, ref(SOL), key(10), key(11), 100n, 5n);
    const sell = launchlabSwapInstruction(web3, a, USER, pool!, ref(MINT), key(11), key(10), 100n, 5n);
    expect(buy.programId.toBase58()).toBe(LAUNCHLAB_PROGRAM);
    expect(Buffer.from(buy.data).subarray(0, 8)).toEqual(Buffer.from([250, 234, 13, 123, 213, 156, 19, 236]));
    expect(Buffer.from(sell.data).subarray(0, 8)).toEqual(Buffer.from([149, 39, 222, 155, 211, 124, 152, 26]));
    expect(buy.keys.find((k) => k.isSigner)!.pubkey.toBase58()).toBe(USER);
    // The user's base account is the output when buying and the input when selling.
    expect(buy.keys[5]!.pubkey.toBase58()).toBe(key(11));
    expect(sell.keys[5]!.pubkey.toBase58()).toBe(key(11));
    expect(buy.keys[6]!.pubkey.toBase58()).toBe(key(10));
    expect(() => launchlabSwapInstruction(web3, a, USER, pool!, ref(SOL), key(10), key(11), 0n, 5n)).toThrow(/above zero/);
    expect(() => launchlabSwapInstruction(web3, a, USER, pool!, ref(SOL), key(10), key(11), 5n, 0n)).toThrow(/minimum/);
    expect(() => launchlabSwapInstruction(web3, a, USER, pool!, ref(key(12)), key(10), key(11), 5n, 1n)).toThrow(/not in this pool/);
  });
});

describe('Meteora Dynamic Bonding Curve', () => {
  const POOL = key(20);
  const CONFIG = key(6);
  const configBytes = (quote: string): Uint8Array => {
    const d = new Uint8Array(300);
    put(d, 8, quote);
    return d;
  };
  const rpcFor = (pool: Uint8Array | null, owner = DBC_PROGRAM, quote = SOL) => async <T>(_m: string, params: unknown[]): Promise<T> =>
    ({
      value: (params[0] as string[]).map((k) => (k === POOL && pool ? { owner, data: [b64(pool), 'base64'] } : k === CONFIG ? { owner: DBC_PROGRAM, data: [b64(configBytes(quote)), 'base64'] } : { owner: TOKEN_PROGRAM, data: ['', 'base64'] })),
    }) as T;
  const hints = async (mint: string): Promise<string[]> => (mint === MINT ? [POOL] : []);

  it('reads a pool and a config', () => {
    expect(parseDbcPool(web3, dbcBytes())).toMatchObject({ config: CONFIG, baseMint: MINT, baseReserve: 5_000n, migrated: false, migrationProgress: 0 });
    expect(parseDbcPool(web3, new Uint8Array(424))).toBeNull();
    expect(parseDbcPool(web3, new Uint8Array(10))).toBeNull();
    expect(parseDbcConfigQuote(web3, configBytes(SOL))).toBe(SOL);
    expect(parseDbcConfigQuote(web3, new Uint8Array(3))).toBeNull();
  });

  it('verifies a hinted pool on-chain before offering it, in either order', async () => {
    const a = new DbcAdapter(web3, rpcFor(dbcBytes()), () => 5, hints);
    for (const [x, y] of [[SOL, MINT], [MINT, SOL]] as const) {
      const [pool] = await a.getPools(ref(x), ref(y));
      expect(pool).toMatchObject({ status: 'active', token0: ref(MINT), token1: ref(SOL) });
      expect(pool!.ref).toEqual({ chain: 'solana', dex: 'meteora-dbc', address: POOL });
    }
  });

  it('ignores a hint that is not a pool of that token, of another program, priced in another token, or missing', async () => {
    expect(await new DbcAdapter(web3, rpcFor(dbcBytes({ base: key(9) })), () => 5, hints).getPools(ref(SOL), ref(MINT))).toEqual([]);
    expect(await new DbcAdapter(web3, rpcFor(dbcBytes(), TOKEN_PROGRAM), () => 5, hints).getPools(ref(SOL), ref(MINT))).toEqual([]);
    expect(await new DbcAdapter(web3, rpcFor(dbcBytes(), DBC_PROGRAM, key(30)), () => 5, hints).getPools(ref(SOL), ref(MINT))).toEqual([]);
    expect(await new DbcAdapter(web3, rpcFor(null), () => 5, hints).getPools(ref(SOL), ref(MINT))).toEqual([]);
    expect(await new DbcAdapter(web3, rpcFor(dbcBytes()), () => 5, async () => []).getPools(ref(SOL), ref(MINT))).toEqual([]);
  });

  it('does not offer a migrated pool', async () => {
    expect((await new DbcAdapter(web3, rpcFor(dbcBytes({ migrated: true })), () => 5, hints).getPools(ref(SOL), ref(MINT)))[0]!.status).toBe('inactive');
    expect((await new DbcAdapter(web3, rpcFor(dbcBytes({ progress: 3 })), () => 5, hints).getPools(ref(SOL), ref(MINT)))[0]!.status).toBe('inactive');
  });

  it('builds a swap with the program-fixed accounts and the floor', async () => {
    const a = new DbcAdapter(web3, rpcFor(dbcBytes()), () => 5, hints);
    const [pool] = await a.getPools(ref(SOL), ref(MINT));
    const ix = dbcSwapInstruction(web3, a, USER, pool!, ref(SOL), key(10), key(11), 100n, 5n);
    expect(ix.programId.toBase58()).toBe(DBC_PROGRAM);
    expect(Buffer.from(ix.data).subarray(0, 8)).toEqual(Buffer.from([65, 75, 63, 76, 235, 91, 91, 136]));
    expect(ix.keys[0]!.pubkey.toBase58()).toBe('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM');
    expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([USER]);
    expect(() => dbcSwapInstruction(web3, a, USER, pool!, ref(SOL), key(10), key(11), 0n, 5n)).toThrow(/above zero/);
    expect(() => dbcSwapInstruction(web3, a, USER, pool!, ref(SOL), key(10), key(11), 5n, 0n)).toThrow(/minimum/);
    expect(() => dbcSwapInstruction(web3, a, USER, pool!, ref(key(12)), key(10), key(11), 5n, 1n)).toThrow(/not in this pool/);
  });
});
