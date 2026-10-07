import { describe, expect, it } from 'vitest';
import * as web3 from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { CPMM_CREATE_FEE_RECEIVER, decodeBase58, decodePoolCreation, poolsCreatedIn, SolanaPoolDiscoverySource } from './solanaIndexer.js';
import { ORCA_CONFIG, ORCA_WHIRLPOOL_PROGRAM } from '../solana/orcaWhirlpool.js';
import { RAYDIUM_CPMM_PROGRAM, type SolRpc } from '../solana/raydiumCpmm.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encodeBase58(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '';
  for (const b of bytes) {
    if (b !== 0) break;
    out += '1';
  }
  return out + digits.reverse().map((d) => B58[d]).join('');
}
const disc = (name: string): Buffer => createHash('sha256').update('global:' + name).digest().subarray(0, 8);
const key = (): string => web3.Keypair.generate().publicKey.toBase58();
let counter = 0;
const sig = (): string => encodeBase58(Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 13 + counter++) % 256));

const MINT = key();
const OTHER = key();
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POOL = key();
const V0 = key();
const V1 = key();
const cpmmIx = (mint0: string, mint1: string) => ({
  programId: RAYDIUM_CPMM_PROGRAM,
  accounts: [key(), key(), key(), POOL, mint0, mint1, key(), key(), key(), key(), V0, V1, CPMM_CREATE_FEE_RECEIVER, key(), key(), key(), key(), key(), key(), key()],
  data: encodeBase58(Buffer.concat([disc('initialize'), Buffer.alloc(24, 1)])),
});
const orcaV2Ix = () => ({
  programId: ORCA_WHIRLPOOL_PROGRAM,
  accounts: [ORCA_CONFIG, MINT, USDC, key(), key(), key(), POOL, V0, V1, key(), key(), key(), key(), key()],
  data: encodeBase58(Buffer.concat([disc('initialize_pool_v2'), Buffer.alloc(18, 2)])),
});

describe('base58', () => {
  it('decodes known vectors and round-trips', () => {
    expect([...decodeBase58('')]).toEqual([]);
    expect([...decodeBase58('1112')]).toEqual([0, 0, 0, 1]);
    expect(new web3.PublicKey(decodeBase58(USDC)).toBase58()).toBe(USDC);
    for (const n of [1, 5, 32, 64]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) % 256);
      expect([...decodeBase58(encodeBase58(b))]).toEqual([...b]);
    }
    expect(() => decodeBase58('0OIl')).toThrow();
  });
});

describe('decodePoolCreation', () => {
  it('reads a Raydium CPMM initialize and an Orca initialize_pool_v2 exactly as the programs lay them out', () => {
    expect(decodePoolCreation(cpmmIx(MINT, OTHER), 1_000, 's')).toMatchObject({ venue: 'Raydium CPMM', pool: POOL, mintA: MINT, mintB: OTHER, vaultA: V0, vaultB: V1, blockTime: 1_000 });
    expect(decodePoolCreation(orcaV2Ix(), 2_000, 's')).toMatchObject({ venue: 'Orca Whirlpool', pool: POOL, mintA: MINT, mintB: USDC, vaultA: V0, vaultB: V1 });
  });

  it('refuses another program, another instruction, a wrong length, too few accounts, or a foreign Orca config', () => {
    const ix = cpmmIx(MINT, OTHER);
    expect(decodePoolCreation({ ...ix, programId: key() }, 1, 's')).toBeNull();
    expect(decodePoolCreation({ ...ix, data: encodeBase58(Buffer.concat([disc('swap_base_input'), Buffer.alloc(24)])) }, 1, 's')).toBeNull();
    expect(decodePoolCreation({ ...ix, data: encodeBase58(Buffer.concat([disc('initialize'), Buffer.alloc(8)])) }, 1, 's')).toBeNull();
    expect(decodePoolCreation({ ...ix, accounts: ix.accounts.slice(0, 5) }, 1, 's')).toBeNull();
    expect(decodePoolCreation({ ...ix, data: '0OIl' }, 1, 's')).toBeNull();
    const o = orcaV2Ix();
    expect(decodePoolCreation({ ...o, accounts: [key(), ...o.accounts.slice(1)] }, 1, 's')).toBeNull();
    expect(decodePoolCreation({}, 1, 's')).toBeNull();
  });

  it('finds creations called from another program, ignores failed transactions, and reports a pool once', () => {
    const tx = { blockTime: 1_700_000_000, meta: { err: null, innerInstructions: [{ instructions: [cpmmIx(MINT, OTHER)] }] }, transaction: { message: { instructions: [cpmmIx(MINT, OTHER)] } } };
    expect(poolsCreatedIn(tx, 's')).toHaveLength(1);
    expect(poolsCreatedIn({ ...tx, meta: { err: { InstructionError: [0, 'x'] } } }, 's')).toEqual([]);
    expect(poolsCreatedIn({ ...tx, blockTime: null }, 's')).toEqual([]);
    expect(poolsCreatedIn(null, 's')).toEqual([]);
  });
});

describe('SolanaPoolDiscoverySource', () => {
  const NOW = 1_700_000_100_000;
  const tokenAcct = (amount: bigint) => {
    const d = new Uint8Array(165);
    new DataView(d.buffer).setBigUint64(64, amount, true);
    return { data: [btoa(String.fromCharCode(...d)), 'base64'] };
  };
  const mintAcct = (decimals: number) => {
    const d = new Uint8Array(82);
    d[44] = decimals;
    return { data: [btoa(String.fromCharCode(...d)), 'base64'] };
  };
  // The pool holds MINT (vault A, V0) against USDC (vault B, V1).
  const fakeRpc = (opts: { empty?: boolean } = {}) => {
    const tx = { blockTime: 1_700_000_050, meta: { err: null }, transaction: { message: { instructions: [cpmmIx(MINT, USDC)] } } };
    const s = sig();
    const failed = sig();
    const asked: { method: string; params: unknown[] }[] = [];
    const rpc = (async (method: string, params: unknown[]) => {
      asked.push({ method, params });
      if (method === 'getSignaturesForAddress') {
        const [addr, o] = params as [string, { until?: string }];
        return addr === CPMM_CREATE_FEE_RECEIVER && !o.until ? [{ signature: s, blockTime: 1_700_000_050, err: null }, { signature: failed, blockTime: 1_700_000_040, err: { x: 1 } }] : [];
      }
      if (method === 'getTransaction') return (params[0] as string) === s ? tx : null;
      if (method === 'getMultipleAccounts') {
        const list = params[0] as string[];
        return { value: list.map((a) => (a === MINT ? mintAcct(6) : a === V0 ? tokenAcct(opts.empty ? 0n : 5_000_000_000n) : a === V1 ? tokenAcct(opts.empty ? 0n : 20_000_000_000n) : null)) };
      }
      throw new Error('unexpected ' + method);
    }) as SolRpc;
    return { rpc, asked, sig: s };
  };
  const source = (rpc: SolRpc) => new SolanaPoolDiscoverySource(async () => web3, rpc, { now: () => NOW });

  it('turns a creation into a token with on-chain decimals, the real block time, the pool and dollar liquidity', async () => {
    const { rpc, sig: s } = fakeRpc();
    const src = source(rpc);
    const batch = await src.poll(null);
    expect(batch.candidates).toHaveLength(1);
    const c = batch.candidates[0]!;
    expect(c.ref).toEqual({ chain: 'solana', address: MINT });
    expect(c.decimals).toBe(6);
    expect(c.onchain).toBe(true);
    expect(c.firstPoolAt).toBe(1_700_000_050_000);
    expect(c.pool).toEqual({ venue: 'Raydium CPMM', address: POOL });
    expect(c.liquidityUsd).toBe(40_000); // twice the 20,000 USDC held by the stablecoin side
    expect(c.source).toBe('aretia-indexer:raydium-cpmm');
    expect(JSON.parse(batch.nextCursor!)[CPMM_CREATE_FEE_RECEIVER]).toBe(s);
    expect(src.lastRun).toMatchObject({ accountsRead: 10, signaturesNew: 1, transactionsRead: 1, poolsFound: 1, truncated: false });
  });

  it('reads only finalized data and resumes after the cursor', async () => {
    const { rpc, asked } = fakeRpc();
    const src = source(rpc);
    const first = await src.poll(null);
    expect(asked.filter((a) => a.method === 'getSignaturesForAddress').every((a) => (a.params[1] as { commitment: string }).commitment === 'finalized')).toBe(true);
    expect(asked.find((a) => a.method === 'getTransaction')!.params[1]).toMatchObject({ commitment: 'finalized' });
    asked.length = 0;
    const second = await src.poll(first.nextCursor);
    expect(asked.some((a) => a.method === 'getSignaturesForAddress' && (a.params[1] as { until?: string }).until !== undefined)).toBe(true);
    expect(second.candidates).toEqual([]);
    expect(JSON.parse(second.nextCursor!)).toEqual(JSON.parse(first.nextCursor!));
  });

  it('does not report a pool that holds nothing, and ignores a cursor it did not write', async () => {
    const src = source(fakeRpc({ empty: true }).rpc);
    const batch = await src.poll('{"junk": 5, "also": "not a signature"}');
    expect(batch.candidates[0]!.pool).toBeNull();
    expect(batch.candidates[0]!.liquidityUsd).toBeNull();
  });

  it('skips creations older than the look-back on a first poll', async () => {
    const src = new SolanaPoolDiscoverySource(async () => web3, fakeRpc().rpc, { now: () => NOW, lookbackSeconds: 10 });
    expect((await src.poll(null)).candidates).toEqual([]);
  });

  it('says so when a busy account returned a full page after a cursor', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ signature: sig(), blockTime: 1_700_000_000 + i, err: null }));
    const rpc = (async (method: string) => (method === 'getSignaturesForAddress' ? many : method === 'getTransaction' ? null : { value: [] })) as SolRpc;
    const src = source(rpc);
    await src.poll(JSON.stringify({ [CPMM_CREATE_FEE_RECEIVER]: sig() }));
    expect(src.lastRun!.truncated).toBe(true);
  });
});
