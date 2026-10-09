/**
 * Direct integration with Raydium's concentrated-liquidity pools (CLMM), where much of Solana's deepest stablecoin and
 * blue-chip liquidity sits. Before this, such a pool needed an outside route.
 *
 * Like an AMM v4 pool, a CLMM pool cannot be derived from the token pair (it also depends on the fee tier chosen when it
 * was created), so the candidate pool addresses of a token come from DexScreener and every one is checked on-chain before it
 * is used: owned by the CLMM program, naming exactly this pair of mints, and open for swaps.
 *
 * The swap is `swap_v2` in exact-in mode with no price limit. A concentrated-liquidity swap walks through ranges of ticks, so
 * the program is given the accounts for the ranges it may cross: the one the price is in now, then the next ones in the swap's
 * direction that exist. A trade large enough to need more than the ones passed fails in simulation and is not offered, rather
 * than being quoted wrongly. The program prices the swap (by simulation, from the user's account) and enforces the minimum.
 */
import type * as Web3 from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '../../scripts/walletTools.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type TokenRef } from '../core/types.js';
import type { LiquidityPool } from '../engine/types.js';
import { type PoolHints } from './meteoraDbc.js';
import { aretiaPoolHints } from './poolHints.js';
import { type SolRpc } from './raydiumCpmm.js';

export const CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const DISC_SWAP_V2 = Uint8Array.from([43, 4, 237, 11, 26, 201, 30, 98]);
const DISC_POOL = Uint8Array.from([247, 237, 227, 245, 215, 195, 222, 70]);
/** Ticks per tick array, a constant of the program. */
const TICK_ARRAY_SIZE = 60;
/** How many ranges beyond the current one are looked for, and how far (in ranges) the search for them goes. */
const EXTRA_ARRAYS = 2;
const SEARCH_RANGES = 6;
const POOL_MIN_SIZE = 1096;

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export interface ClmmPool {
  ammConfig: string;
  mint0: string;
  mint1: string;
  vault0: string;
  vault1: string;
  observation: string;
  tickSpacing: number;
  liquidity: bigint;
  sqrtPriceX64: bigint;
  tickCurrent: number;
  /** Bit 2 of the status disables swaps. */
  status: number;
}

/** Reads a pool account. Null when it is too short or is not one. */
export function parseClmmPool(web3: typeof Web3, data: Uint8Array): ClmmPool | null {
  if (data.length < POOL_MIN_SIZE || !DISC_POOL.every((b, i) => data[i] === b)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pk = (o: number): string => new web3.PublicKey(data.subarray(o, o + 32)).toBase58();
  const u128 = (o: number): bigint => view.getBigUint64(o, true) + (view.getBigUint64(o + 8, true) << 64n);
  return { ammConfig: pk(9), mint0: pk(73), mint1: pk(105), vault0: pk(137), vault1: pk(169), observation: pk(201), tickSpacing: view.getUint16(235, true), liquidity: u128(237), sqrtPriceX64: u128(253), tickCurrent: view.getInt32(269, true), status: data[389]! };
}

/** The first tick of the range (tick array) that holds a tick. */
export function tickArrayStart(tick: number, tickSpacing: number): number {
  const span = TICK_ARRAY_SIZE * tickSpacing;
  return Math.floor(tick / span) * span;
}

export class ClmmAdapter {
  private readonly program: Web3.PublicKey;

  constructor(
    private readonly web3: typeof Web3,
    private readonly rpc: SolRpc,
    private readonly now: () => number = Date.now,
    private readonly hints: PoolHints = aretiaPoolHints(),
  ) {
    this.program = new web3.PublicKey(CLMM_PROGRAM);
  }

  private pda(seeds: Uint8Array[]): string {
    return this.web3.PublicKey.findProgramAddressSync(seeds, this.program)[0].toBase58();
  }
  private key = (a: string): Uint8Array => new this.web3.PublicKey(a).toBytes();

  tickArray = (pool: string, start: number): string => {
    const be = new Uint8Array(4);
    new DataView(be.buffer).setInt32(0, start, false);
    return this.pda([enc('tick_array'), this.key(pool), be]);
  };
  bitmapExtension = (pool: string): string => this.pda([enc('pool_tick_array_bitmap_extension'), this.key(pool)]);

  private async accounts(addresses: string[]): Promise<({ data: [string, string]; owner: string } | null)[]> {
    if (addresses.length === 0) return [];
    return (await this.rpc<{ value: ({ data: [string, string]; owner: string } | null)[] }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }])).value;
  }

  /** The tick arrays a swap in one direction may cross: the current one, then the next ones that exist. */
  async tickArraysFor(pool: string, state: Pick<ClmmPool, 'tickCurrent' | 'tickSpacing'>, zeroForOne: boolean): Promise<string[]> {
    const span = TICK_ARRAY_SIZE * state.tickSpacing;
    const current = tickArrayStart(state.tickCurrent, state.tickSpacing);
    const starts = [current];
    for (let i = 1; i <= SEARCH_RANGES; i++) starts.push(current + (zeroForOne ? -i : i) * span);
    const addresses = starts.map((s) => this.tickArray(pool, s));
    const raw = await this.accounts(addresses);
    const out: string[] = [];
    raw.forEach((acc, i) => {
      if (i === 0) out.push(addresses[0]!);
      else if (acc && acc.owner === CLMM_PROGRAM && out.length < 1 + EXTRA_ARRAYS) out.push(addresses[i]!);
    });
    return out;
  }

  /** Pools of the pair, verified on-chain. */
  async getPools(a: TokenRef, b: TokenRef): Promise<LiquidityPool[]> {
    const ta = normalizeTokenRef('solana', a.address);
    const tb = normalizeTokenRef('solana', b.address);
    if (!ta || !tb || ta.address === tb.address) throw new SwingsError('invalid', 'Invalid token pair.');
    const [ha, hb] = await Promise.all([this.hints(ta.address), this.hints(tb.address)]);
    const candidates = [...new Set([...ha, ...hb])].slice(0, 30);
    if (candidates.length === 0) return [];
    const raw = await this.accounts(candidates);
    const found = raw
      .map((acc, i) => ({ acc, address: candidates[i]! }))
      .filter((x): x is { acc: { data: [string, string]; owner: string }; address: string } => x.acc !== null && x.acc.owner === CLMM_PROGRAM)
      .map((x) => ({ ...x, state: parseClmmPool(this.web3, fromBase64(x.acc.data[0])) }))
      .filter((x): x is typeof x & { state: ClmmPool } => x.state !== null && ((x.state.mint0 === ta.address && x.state.mint1 === tb.address) || (x.state.mint0 === tb.address && x.state.mint1 === ta.address)));
    if (found.length === 0) return [];
    const side = await this.accounts([...found.flatMap((f) => [f.state.ammConfig, f.state.mint0, f.state.mint1])]);
    const out: LiquidityPool[] = [];
    found.forEach((f, k) => {
      const cfg = side[k * 3];
      const m0 = side[k * 3 + 1];
      const m1 = side[k * 3 + 2];
      if (!cfg || cfg.owner !== CLMM_PROGRAM || !m0 || !m1) return;
      const s = f.state;
      const cfgData = fromBase64(cfg.data[0]);
      const tradeFee = cfgData.length >= 51 ? new DataView(cfgData.buffer, cfgData.byteOffset, cfgData.byteLength).getUint32(47, true) : 0;
      // The liquidity at the current price, expressed as the two token amounts of a constant-product pool with the same price and depth.
      const Q64 = 1n << 64n;
      const reserve0 = s.sqrtPriceX64 > 0n ? (s.liquidity * Q64) / s.sqrtPriceX64 : 0n;
      const reserve1 = (s.liquidity * s.sqrtPriceX64) / Q64;
      out.push({
        ref: { chain: 'solana', dex: 'raydium-clmm', address: f.address },
        model: 'concentrated',
        token0: { chain: 'solana', address: s.mint0 },
        token1: { chain: 'solana', address: s.mint1 },
        reserve0,
        reserve1,
        feePpm: tradeFee,
        updatedAt: this.now(),
        block: null,
        status: (s.status & 0b100) === 0 && s.liquidity > 0n ? 'active' : 'inactive',
        extra: { ammConfig: s.ammConfig, vault0: s.vault0, vault1: s.vault1, observation: s.observation, tickSpacing: String(s.tickSpacing), tickCurrent: String(s.tickCurrent), program0: m0.owner, program1: m1.owner },
      });
    });
    return out;
  }
}

function u64le(v: bigint): Uint8Array {
  if (v < 0n || v >= 1n << 64n) throw new SwingsError('invalid', 'Amount out of range for a u64.');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

/**
 * One `swap_v2`, exact in, no price limit (zero tells the program to use the widest allowed). `tickArrays` are the ranges the
 * swap may cross, from `tickArraysFor`; they are passed after the named accounts, behind the pool's bitmap extension.
 */
export function clmmSwapInstruction(web3: typeof Web3, adapter: ClmmAdapter, user: string, pool: LiquidityPool, tokenIn: TokenRef, inAccount: string, outAccount: string, amountIn: bigint, minOut: bigint, tickArrays: string[]): Web3.TransactionInstruction {
  const x = pool.extra;
  if (!x || pool.ref.dex !== 'raydium-clmm') throw new SwingsError('invalid', 'This pool cannot be swapped by the CLMM builder.');
  if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  if (tickArrays.length === 0) throw new SwingsError('invalid', 'A concentrated-liquidity swap needs the ranges it crosses.');
  const zeroForOne = tokenIn.address === pool.token0.address;
  if (!zeroForOne && tokenIn.address !== pool.token1.address) throw new SwingsError('invalid', 'The input token is not in this pool.');
  const pk = (a: string): Web3.PublicKey => new web3.PublicKey(a);
  const meta = (a: string, isWritable = false, isSigner = false) => ({ pubkey: pk(a), isSigner, isWritable });
  const mintIn = zeroForOne ? pool.token0.address : pool.token1.address;
  const mintOut = zeroForOne ? pool.token1.address : pool.token0.address;
  const keys = [
    meta(user, false, true), meta(x.ammConfig!), meta(pool.ref.address, true), meta(inAccount, true), meta(outAccount, true), meta(zeroForOne ? x.vault0! : x.vault1!, true), meta(zeroForOne ? x.vault1! : x.vault0!, true), meta(x.observation!, true),
    meta(TOKEN_PROGRAM_ID), meta(TOKEN_2022), meta(MEMO), meta(mintIn), meta(mintOut),
    meta(adapter.bitmapExtension(pool.ref.address), true), ...tickArrays.map((t) => meta(t, true)),
  ];
  // amount, other_amount_threshold, sqrt_price_limit_x64 (u128, zero), is_base_input = true
  const data = new Uint8Array(8 + 8 + 8 + 16 + 1);
  data.set(DISC_SWAP_V2, 0);
  data.set(u64le(amountIn), 8);
  data.set(u64le(minOut), 16);
  data[40] = 1;
  return new web3.TransactionInstruction({ programId: pk(CLMM_PROGRAM), keys, data: Buffer.from(data) });
}
