import { describe, expect, it } from 'vitest';
import { decodeBase58, encodeBase58 } from '../mi/solana/accounts.js';
import { chainNativeUsd, createChainPricer, type Rpc } from './chainPrice.js';

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

const bytes = (a: string): Uint8Array => decodeBase58(a)!;

/** A node holding one pool account and the other accounts by address (mints, vaults). Every account answers by its address, in any order. */
const solanaNode = (pool: string, owner: string, poolData: () => Uint8Array, others: Record<string, () => string>): Rpc => async (method, params) => {
  if (method === 'getAccountInfo') return { value: { owner, data: [b64(poolData()), 'base64'] } };
  const list = params[0] as string[];
  return { value: list.map((a) => (a === pool ? { data: [b64(poolData()), 'base64'] } : others[a] ? { data: [others[a]!(), 'base64'] } : null)) };
};

describe('createChainPricer, Solana', () => {
  it('prices a CPMM pool from its two vaults, in dollars through a dollar coin', async () => {
    const pool = new Uint8Array(637);
    put(pool, 72, key(11)); // vault A
    put(pool, 104, key(12)); // vault B
    put(pool, 168, key(1)); // mint A: the token
    put(pool, 200, bytes(USDC)); // mint B
    let balances = [1_000_000_000n, 2_000_000n];
    const rpc = solanaNode(KEY(9), CPMM, () => pool, { [KEY(1)]: () => mint(6), [USDC]: () => mint(6), [KEY(11)]: () => tokenAccount(balances[0]!), [KEY(12)]: () => tokenAccount(balances[1]!) });
    const read = await createChainPricer({ chain: 'solana', pool: KEY(9), target: KEY(1) }, { rpc, usdOf });
    expect(read).not.toBeNull();
    expect(await read!()).toBeCloseTo(0.002, 9);
    balances = [1_000_000_000n, 4_000_000n];
    expect(await read!()).toBeCloseTo(0.004, 9);
  });

  it('prices a token paired with SOL through the dollar price of SOL, and not the SOL side when no price of SOL is given', async () => {
    const pool = new Uint8Array(637);
    put(pool, 72, key(11));
    put(pool, 104, key(12));
    put(pool, 168, key(2));
    put(pool, 200, bytes(WSOL));
    const rpc = solanaNode(KEY(8), CPMM, () => pool, { [KEY(2)]: () => mint(6), [WSOL]: () => mint(9), [KEY(11)]: () => tokenAccount(1_000_000_000n), [KEY(12)]: () => tokenAccount(2_000_000_000n) });
    // 1,000 tokens against 2 SOL: 0.002 SOL each, 0.30 dollars at 150 a SOL.
    const read = await createChainPricer({ chain: 'solana', pool: KEY(8), target: KEY(2) }, { rpc, usdOf });
    expect(await read!()).toBeCloseTo(0.3, 6);
    const wsol = await createChainPricer({ chain: 'solana', pool: KEY(8), target: WSOL }, { rpc, usdOf: async () => null });
    expect(await wsol!()).toBeNull();
  });

  it('prices a Meteora DLMM pair from its active bin', async () => {
    const pair = new Uint8Array(904);
    const dv = new DataView(pair.buffer);
    dv.setInt32(76, 0, true); // active bin 0: a price of exactly 1 raw unit of Y per raw unit of X
    dv.setUint16(80, 25, true);
    put(pair, 88, key(3));
    put(pair, 120, bytes(USDC));
    const rpc = solanaNode(KEY(7), DLMM, () => pair, { [KEY(3)]: () => mint(9), [USDC]: () => mint(6) });
    const read = await createChainPricer({ chain: 'solana', pool: KEY(7), target: KEY(3) }, { rpc, usdOf });
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

describe('chainNativeUsd', () => {
  const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const addr = (a: string): string => `0x${a.slice(2).padStart(64, '0')}`;
  const num = (n: bigint): string => n.toString(16).padStart(64, '0');
  // The real pool holds USDC (6 decimals) as token0 and WETH (18) as token1: at 2,000 dollars a WETH, a raw WETH costs 1/(2000e12) raw USDC units... the
  // pool's sqrt price is sqrt(1e18 / (2000 * 1e6)) in raw terms, times 2^96.
  const sqrt = BigInt(Math.floor(Math.sqrt(1e18 / (2000 * 1e6)) * 2 ** 40)) * 2n ** 56n;
  let slot0Reads = 0;
  const node: Rpc = async (_m, params) => {
    const { to, data } = params[0] as { to: string; data: string };
    if (data === '0x0dfe1681') return addr(USDC_ETH);
    if (data === '0xd21220a7') return addr(WETH);
    if (data === '0x313ce567') return `0x${num(to === USDC_ETH ? 6n : 18n)}`;
    if (data === '0x0902f1ac') throw new Error('revert');
    if (data === '0x3850c7bd') {
      slot0Reads++;
      return `0x${num(sqrt)}${num(0n)}`;
    }
    throw new Error('unexpected');
  };

  it('reads a coin dollar price from its reference pool on the chain, with no price service, and keeps it a moment', async () => {
    let t = 0;
    const usd = chainNativeUsd(() => node, () => t, 2_000);
    const first = await usd('ethereum', WETH);
    expect(first).toBeGreaterThan(1990);
    expect(first).toBeLessThan(2010);
    const reads = slot0Reads;
    t = 500;
    expect(await usd('ethereum', WETH)).toBe(first);
    expect(slot0Reads).toBe(reads);
    t = 3_000;
    await usd('ethereum', WETH);
    expect(slot0Reads).toBe(reads + 1);
  });

  it('has no price for a network with no reference pool, and none when the node is down', async () => {
    const down = chainNativeUsd(() => async () => {
      throw new Error('offline');
    });
    expect(await down('robinhood', '0xabc')).toBeNull();
    expect(await down('ethereum', WETH)).toBeNull();
  });

  it('keeps the last good price when a later read fails', async () => {
    let t = 0;
    let up = true;
    const flaky: Rpc = async (m, p) => {
      if (!up) throw new Error('offline');
      return node(m, p);
    };
    const usd = chainNativeUsd(() => flaky, () => t, 2_000);
    const first = await usd('ethereum', WETH);
    up = false;
    t = 5_000;
    expect(await usd('ethereum', WETH)).toBe(first);
    t = 200_000;
    expect(await usd('ethereum', WETH)).toBeNull();
  });
});
