import { describe, expect, it } from 'vitest';
import { encodeBase58 } from '../mi/solana/accounts.js';
import { createChainPricer, dexscreenerUsd, type Rpc } from './chainPrice.js';

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
const key = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 7));
const KEY = (n: number): string => encodeBase58(key(n));
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

function mint(decimals: number): string {
  const d = new Uint8Array(82);
  d[44] = decimals;
  d[45] = 1;
  return b64(d);
}
function tokenAccount(amount: bigint): string {
  const d = new Uint8Array(165);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return b64(d);
}
function put(d: Uint8Array, at: number, k: Uint8Array): void {
  d.set(k, at);
}
const usdOf = async (): Promise<number | null> => 150;

describe('createChainPricer, Solana', () => {
  it('prices a CPMM pool from its two vaults, in dollars through a dollar coin', async () => {
    const pool = new Uint8Array(637);
    const base = encodeBase58(key(1));
    put(pool, 72, key(11)); // vault A
    put(pool, 104, key(12)); // vault B
    put(pool, 168, key(1)); // mint A: the token
    put(pool, 200, new Uint8Array(0));
    // mint B is USDC: write its real 32 bytes by decoding the address.
    const usdcBytes = (await import('../mi/solana/accounts.js')).decodeBase58(USDC)!;
    put(pool, 200, usdcBytes);
    let balances = [1_000_000_000n, 2_000_000n]; // 1,000 tokens (6 dec) against 2 USDC (6 dec)... see decimals below
    const rpc: Rpc = async (method, params) => {
      if (method === 'getAccountInfo') return { value: { owner: CPMM, data: [b64(pool), 'base64'] } };
      if (method === 'getMultipleAccounts') {
        const list = params[0] as string[];
        if (list[0] === base) return { value: [{ data: [mint(6), 'base64'] }, { data: [mint(6), 'base64'] }] };
        return { value: [{ data: [tokenAccount(balances[0]!), 'base64'] }, { data: [tokenAccount(balances[1]!), 'base64'] }] };
      }
      throw new Error('unexpected');
    };
    const read = await createChainPricer({ chain: 'solana', pool: KEY(9), target: base }, { rpc, usdOf });
    expect(read).not.toBeNull();
    expect(await read!()).toBeCloseTo(0.002, 9);
    balances = [1_000_000_000n, 4_000_000n];
    expect(await read!()).toBeCloseTo(0.004, 9);
  });

  it('prices a token paired with SOL through the dollar price of SOL, and the other side of the pool by inversion', async () => {
    const pool = new Uint8Array(637);
    put(pool, 72, key(11));
    put(pool, 104, key(12));
    put(pool, 168, key(1));
    put(pool, 200, (await import('../mi/solana/accounts.js')).decodeBase58(WSOL)!);
    const rpc: Rpc = async (method, params) => {
      if (method === 'getAccountInfo') return { value: { owner: CPMM, data: [b64(pool), 'base64'] } };
      const list = params[0] as string[];
      if (list[0] === encodeBase58(key(1))) return { value: [{ data: [mint(6), 'base64'] }, { data: [mint(9), 'base64'] }] };
      return { value: [{ data: [tokenAccount(1_000_000_000n), 'base64'] }, { data: [tokenAccount(2_000_000_000n), 'base64'] }] };
    };
    // 1,000 tokens against 2 SOL: 0.002 SOL each, 0.30 dollars at 150 a SOL.
    const read = await createChainPricer({ chain: 'solana', pool: KEY(9), target: encodeBase58(key(1)) }, { rpc, usdOf });
    expect(await read!()).toBeCloseTo(0.3, 6);
    // Charted the other way round, SOL itself is 150 dollars (the dollar price used) and the token is not the target.
    const wsol = await createChainPricer({ chain: 'solana', pool: KEY(9), target: WSOL }, { rpc, usdOf: async () => null });
    expect(await wsol!()).toBeNull();
  });

  it('prices a Meteora DLMM pair from its active bin', async () => {
    const pair = new Uint8Array(904);
    const dv = new DataView(pair.buffer);
    dv.setInt32(76, 0, true); // active bin 0: a price of exactly 1 raw unit of Y per raw unit of X
    dv.setUint16(80, 25, true);
    put(pair, 88, key(1));
    put(pair, 120, (await import('../mi/solana/accounts.js')).decodeBase58(USDC)!);
    const rpc: Rpc = async (method, params) => {
      if (method === 'getAccountInfo') return { value: { owner: DLMM, data: [b64(pair), 'base64'] } };
      void params;
      return { value: [{ data: [mint(9), 'base64'] }, { data: [mint(6), 'base64'] }] };
    };
    const read = await createChainPricer({ chain: 'solana', pool: KEY(9), target: encodeBase58(key(1)) }, { rpc, usdOf });
    // 1 raw Y (6 decimals) per raw X (9 decimals): 1 whole X = 1e9 / 1e6 whole Y = 1,000 dollars.
    expect(await read!()).toBeCloseTo(1000, 6);
    dv.setInt32(76, 100, true);
    expect(await read!()).toBeCloseTo(1000 * Math.pow(1.0025, 100), 3);
  });

  it('answers null for a pool of a kind it does not read, and for a token that is not in the pool', async () => {
    const other: Rpc = async () => ({ value: { owner: '11111111111111111111111111111111', data: ['', 'base64'] } });
    expect(await createChainPricer({ chain: 'solana', pool: KEY(9), target: KEY(1) }, { rpc: other, usdOf })).toBeNull();
    const broken: Rpc = async () => {
      throw new Error('node down');
    };
    expect(await createChainPricer({ chain: 'solana', pool: KEY(9), target: KEY(1) }, { rpc: broken, usdOf })).toBeNull();
  });
});

describe('createChainPricer, Ethereum-style pools', () => {
  const POOL = '0x00000000000000000000000000000000000000aa';
  const TOKEN = '0x00000000000000000000000000000000000000b1';
  const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const addr = (a: string): string => `0x${a.slice(2).padStart(64, '0')}`;
  const num = (n: bigint): string => n.toString(16).padStart(64, '0');
  const rpcFor = (kind: 'v2' | 'v3', state: () => string): Rpc => async (_m, params) => {
    const { to, data } = params[0] as { to: string; data: string };
    if (data === '0x0dfe1681') return addr(TOKEN);
    if (data === '0xd21220a7') return addr(WETH);
    if (data === '0x313ce567') return `0x${num(to === TOKEN ? 18n : 18n)}`;
    if (data === '0x0902f1ac') {
      if (kind !== 'v2') throw new Error('revert');
      return state();
    }
    if (data === '0x3850c7bd') {
      if (kind !== 'v3') throw new Error('revert');
      return state();
    }
    throw new Error('unexpected');
  };

  it('prices a V2 pool from its reserves, through the network coin', async () => {
    // 1,000,000 tokens against 100 WETH, 18 decimals both: 0.0001 WETH each, 0.2 dollars at 2,000 a WETH.
    const state = (): string => `0x${num(10n ** 24n)}${num(100n * 10n ** 18n)}${num(0n)}`;
    const read = await createChainPricer({ chain: 'ethereum', pool: POOL, target: TOKEN }, { rpc: rpcFor('v2', state), usdOf: async () => 2000 });
    expect(await read!()).toBeCloseTo(0.2, 9);
  });

  it('prices a V3 pool from its sqrt price', async () => {
    // sqrtPriceX96 of 2^96 is a price of exactly 1 token1 per token0: 1 WETH each, 2,000 dollars.
    const state = (): string => `0x${num(2n ** 96n)}${num(0n)}`;
    const read = await createChainPricer({ chain: 'ethereum', pool: POOL, target: TOKEN }, { rpc: rpcFor('v3', state), usdOf: async () => 2000 });
    expect(await read!()).toBeCloseTo(2000, 6);
  });

  it('is null for a pool that answers neither, and for a pair with no dollar value', async () => {
    const neither: Rpc = async (_m, params) => {
      const { data } = params[0] as { data: string };
      if (data === '0x0dfe1681') return addr(TOKEN);
      if (data === '0xd21220a7') return addr(WETH);
      if (data === '0x313ce567') return `0x${num(18n)}`;
      throw new Error('revert');
    };
    expect(await createChainPricer({ chain: 'ethereum', pool: POOL, target: TOKEN }, { rpc: neither, usdOf: async () => 2000 })).toBeNull();
    const state = (): string => `0x${num(10n ** 24n)}${num(100n * 10n ** 18n)}${num(0n)}`;
    const read = await createChainPricer({ chain: 'ethereum', pool: POOL, target: TOKEN }, { rpc: rpcFor('v2', state), usdOf: async () => null });
    expect(await read!()).toBeNull();
  });
});

describe('dexscreenerUsd', () => {
  it('takes the price from the deepest pool that has the token as its base, and keeps the last good price when a read fails', async () => {
    let fail = false;
    let t = 0;
    const f = (async () => {
      if (fail) throw new Error('offline');
      return { ok: true, json: async () => ({ pairs: [{ baseToken: { address: WSOL }, priceUsd: '70', liquidity: { usd: 10 } }, { baseToken: { address: WSOL }, priceUsd: '69.5', liquidity: { usd: 5_000_000 } }, { baseToken: { address: 'other' }, priceUsd: '1', liquidity: { usd: 9e9 } }] }) };
    }) as unknown as typeof fetch;
    const usd = dexscreenerUsd(f, () => t, 5_000);
    expect(await usd('solana', WSOL)).toBe(69.5);
    fail = true;
    t = 10_000;
    expect(await usd('solana', WSOL)).toBe(69.5);
  });
});
