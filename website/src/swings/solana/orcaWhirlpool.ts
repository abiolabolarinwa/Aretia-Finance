/**
 * Direct integration with Orca Whirlpools (concentrated liquidity), the deepest venue for SOL and USDC on Solana.
 *
 * Pool addresses are derived from the program's own seeds (config, the two mints, tick spacing), read from the
 * chain and parsed against the program's published account layout. As with the other concentrated-liquidity
 * venues, pricing is NOT re-implemented: the swap is simulated on the program itself and the amount it
 * would deliver is read from the balance change, so fee tiers and tick crossings cannot drift from the program.
 *
 * Scope: pools whose two mints both use the classic Token program (Token-2022 pools need `swap_v2`, not built),
 * and swaps that stay within the three tick arrays the swap instruction takes. A trade large enough to need more
 * simply fails its simulation and is reported as having no route.
 */
import type * as Web3 from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '../../scripts/walletTools.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type TokenRef } from '../core/types.js';
import type { LiquidityPool } from '../engine/types.js';
import { sortMints, tokenAccountAmount, type SolRpc } from './raydiumCpmm.js';

export const ORCA_WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
/** Orca's main WhirlpoolsConfig account. */
export const ORCA_CONFIG = '2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ';
/** Tick spacings pools exist for (each is a fee tier). */
export const ORCA_TICK_SPACINGS = [1, 2, 4, 8, 16, 64, 96, 128, 256] as const;
export const TICK_ARRAY_SIZE = 88;
export const MIN_SQRT_PRICE = 4_295_048_016n;
export const MAX_SQRT_PRICE = 79_226_673_515_401_279_992_447_579_055n;

export interface WhirlpoolState {
  config: string;
  tickSpacing: number;
  /** Fee in hundredths of a basis point (3000 = 0.30%). */
  feeRate: number;
  liquidity: bigint;
  sqrtPrice: bigint;
  tickCurrentIndex: number;
  mintA: string;
  vaultA: string;
  mintB: string;
  vaultB: string;
}

const view = (d: Uint8Array): DataView => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u128 = (d: Uint8Array, o: number): bigint => view(d).getBigUint64(o, true) + (view(d).getBigUint64(o + 8, true) << 64n);
const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Anchor tag (8), then the fields in declaration order. Total 653 bytes. */
export function parseWhirlpool(web3: typeof Web3, d: Uint8Array): WhirlpoolState | null {
  if (d.length < 261 + 8) return null;
  const key = (o: number): string => new web3.PublicKey(d.slice(o, o + 32)).toBase58();
  return {
    config: key(8),
    tickSpacing: view(d).getUint16(41, true),
    feeRate: view(d).getUint16(45, true),
    liquidity: u128(d, 49),
    sqrtPrice: u128(d, 65),
    tickCurrentIndex: view(d).getInt32(81, true),
    mintA: key(101),
    vaultA: key(133),
    mintB: key(181),
    vaultB: key(213),
  };
}

/** First tick of the array that holds `tick`, for a pool's tick spacing. Floors toward negative infinity. */
export function tickArrayStart(tick: number, tickSpacing: number): number {
  const span = TICK_ARRAY_SIZE * tickSpacing;
  return Math.floor(tick / span) * span;
}

/**
 * The three tick arrays a swap passes in, in the order the program walks them: the array holding the current tick,
 * then the next two in the direction of travel (down when selling token A, up when selling token B).
 */
export function swapTickArrayStarts(tickCurrent: number, tickSpacing: number, aToB: boolean): number[] {
  const span = TICK_ARRAY_SIZE * tickSpacing;
  const start = tickArrayStart(tickCurrent, tickSpacing);
  return aToB ? [start, start - span, start - 2 * span] : [start, start + span, start + 2 * span];
}

export class OrcaWhirlpoolAdapter {
  readonly program: Web3.PublicKey;

  constructor(
    private readonly web3: typeof Web3,
    private readonly rpc: SolRpc,
    private readonly now: () => number = Date.now,
  ) {
    this.program = new web3.PublicKey(ORCA_WHIRLPOOL_PROGRAM);
  }

  poolAddress(mintA: string, mintB: string, tickSpacing: number): string {
    const k = (s: string): Uint8Array => new this.web3.PublicKey(s).toBytes();
    const spacing = new Uint8Array(2);
    new DataView(spacing.buffer).setUint16(0, tickSpacing, true);
    return this.web3.PublicKey.findProgramAddressSync([new TextEncoder().encode('whirlpool'), k(ORCA_CONFIG), k(mintA), k(mintB), spacing], this.program)[0].toBase58();
  }

  oracleAddress(pool: string): string {
    return this.web3.PublicKey.findProgramAddressSync([new TextEncoder().encode('oracle'), new this.web3.PublicKey(pool).toBytes()], this.program)[0].toBase58();
  }

  tickArrayAddress(pool: string, startTickIndex: number): string {
    // The program names the account by the decimal text of its first tick.
    return this.web3.PublicKey.findProgramAddressSync([new TextEncoder().encode('tick_array'), new this.web3.PublicKey(pool).toBytes(), new TextEncoder().encode(String(startTickIndex))], this.program)[0].toBase58();
  }

  private async accounts(addresses: string[]): Promise<({ data: [string, string]; owner: string } | null)[]> {
    if (addresses.length === 0) return [];
    return (await this.rpc<{ value: ({ data: [string, string]; owner: string } | null)[] }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }])).value;
  }

  /** Every usable Whirlpool for a pair, across tick spacings. */
  async getPools(a: TokenRef, b: TokenRef): Promise<LiquidityPool[]> {
    const ta = normalizeTokenRef('solana', a.address);
    const tb = normalizeTokenRef('solana', b.address);
    if (!ta || !tb || ta.address === tb.address) throw new SwingsError('invalid', 'Invalid token pair.');
    const [mintA, mintB] = sortMints(this.web3, ta.address, tb.address);
    const addresses = ORCA_TICK_SPACINGS.map((t) => this.poolAddress(mintA, mintB, t));
    const raw = await this.accounts(addresses);
    const found = raw
      .map((acc, i) => ({ acc, i }))
      .filter((x): x is { acc: { data: [string, string]; owner: string }; i: number } => x.acc !== null && x.acc.owner === ORCA_WHIRLPOOL_PROGRAM)
      .map((x) => ({ i: x.i, state: parseWhirlpool(this.web3, fromBase64(x.acc.data[0])) }))
      .filter((x): x is { i: number; state: WhirlpoolState } => x.state !== null && x.state.mintA === mintA && x.state.mintB === mintB && x.state.config === ORCA_CONFIG && x.state.tickSpacing === ORCA_TICK_SPACINGS[x.i]);
    if (found.length === 0) return [];
    const aux = await this.accounts(found.flatMap((f) => [f.state.vaultA, f.state.vaultB, f.state.mintA, f.state.mintB]));
    const out: LiquidityPool[] = [];
    found.forEach((f, k) => {
      const [vaultA, vaultB, mA, mB] = aux.slice(k * 4, k * 4 + 4);
      if (!vaultA || !vaultB || !mA || !mB) return;
      // Token-2022 pools need `swap_v2`; they are not routed.
      if (mA.owner !== TOKEN_PROGRAM_ID || mB.owner !== TOKEN_PROGRAM_ID) return;
      const s = f.state;
      out.push({
        ref: { chain: 'solana', dex: 'orca-whirlpool', address: addresses[f.i]! },
        model: 'concentrated',
        token0: { chain: 'solana', address: s.mintA },
        token1: { chain: 'solana', address: s.mintB },
        reserve0: tokenAccountAmount(fromBase64(vaultA.data[0])) ?? 0n,
        reserve1: tokenAccountAmount(fromBase64(vaultB.data[0])) ?? 0n,
        feePpm: s.feeRate,
        updatedAt: this.now(),
        block: null,
        status: s.liquidity > 0n ? 'active' : 'inactive',
        extra: {
          vaultA: s.vaultA,
          vaultB: s.vaultB,
          tickSpacing: String(s.tickSpacing),
          tickCurrent: String(s.tickCurrentIndex),
          oracle: this.oracleAddress(addresses[f.i]!),
          liquidity: s.liquidity.toString(),
        },
      });
    });
    return out;
  }

  /** The three tick-array addresses the swap passes in, for the pool's current tick and the direction. */
  tickArrays(pool: LiquidityPool, aToB: boolean): string[] {
    const x = pool.extra!;
    return swapTickArrayStarts(Number(x.tickCurrent), Number(x.tickSpacing), aToB).map((s) => this.tickArrayAddress(pool.ref.address, s));
  }
}

let cached: Uint8Array | null = null;
/** Anchor tag of the `swap` instruction: first 8 bytes of sha256("global:swap"). */
export async function whirlpoolSwapDiscriminator(): Promise<Uint8Array> {
  if (cached) return cached;
  cached = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('global:swap'))).slice(0, 8);
  return cached;
}

function u64le(v: bigint): Uint8Array {
  if (v < 0n || v >= 1n << 64n) throw new SwingsError('invalid', 'Amount out of range for a u64.');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

function u128le(v: bigint): Uint8Array {
  const out = new Uint8Array(16);
  new DataView(out.buffer).setBigUint64(0, v & ((1n << 64n) - 1n), true);
  new DataView(out.buffer).setBigUint64(8, v >> 64n, true);
  return out;
}

/** The `swap` instruction (exact input) with the program's account order. */
export async function whirlpoolSwapInstruction(web3: typeof Web3, adapter: OrcaWhirlpoolAdapter, user: string, pool: LiquidityPool, tokenIn: TokenRef, inAccount: string, outAccount: string, amountIn: bigint, minOut: bigint): Promise<Web3.TransactionInstruction> {
  const x = pool.extra;
  if (!x || pool.ref.dex !== 'orca-whirlpool') throw new SwingsError('invalid', 'This pool cannot be swapped by the Whirlpool builder.');
  if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  const aToB = pool.token0.address === tokenIn.address;
  if (!aToB && pool.token1.address !== tokenIn.address) throw new SwingsError('invalid', 'The input token is not in this pool.');
  const [t0, t1, t2] = adapter.tickArrays(pool, aToB);
  const pk = (a: string): Web3.PublicKey => new web3.PublicKey(a);
  const meta = (a: string, isWritable: boolean, isSigner = false) => ({ pubkey: pk(a), isSigner, isWritable });
  // Owner accounts are passed in pool order (A then B): the sold token's account is the input account.
  const ownerA = aToB ? inAccount : outAccount;
  const ownerB = aToB ? outAccount : inAccount;
  const data = new Uint8Array(8 + 8 + 8 + 16 + 1 + 1);
  data.set(await whirlpoolSwapDiscriminator(), 0);
  data.set(u64le(amountIn), 8);
  data.set(u64le(minOut), 16);
  data.set(u128le(aToB ? MIN_SQRT_PRICE : MAX_SQRT_PRICE), 24);
  data[40] = 1; // amount_specified_is_input
  data[41] = aToB ? 1 : 0;
  return new web3.TransactionInstruction({
    programId: pk(ORCA_WHIRLPOOL_PROGRAM),
    keys: [
      meta(TOKEN_PROGRAM_ID, false),
      meta(user, false, true),
      meta(pool.ref.address, true),
      meta(ownerA, true),
      meta(x.vaultA!, true),
      meta(ownerB, true),
      meta(x.vaultB!, true),
      meta(t0!, true),
      meta(t1!, true),
      meta(t2!, true),
      meta(x.oracle!, false),
    ],
    data: Buffer.from(data),
  });
}
