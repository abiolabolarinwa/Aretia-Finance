/**
 * Direct integration with Meteora DLMM (dynamic liquidity market maker: liquidity in discrete price bins). The
 * program itself is the quoter, as with Orca and PumpSwap: a swap is simulated from the user's account and the
 * amount delivered is the price. Aretia does not re-implement bin-walking maths.
 *
 * Source of truth: the program's on-chain IDL (the `swap2` account list, argument layout, and the pool layout whose
 * offsets are used below), checked against real mainnet pools by simulation (solana.live.ts).
 *
 * Finding pools: a pair's pool address is derived from its two mints and a (bin step, base factor) preset, and the
 * program publishes its presets as accounts. Aretia reads that preset list once, derives each candidate address, and
 * keeps the ones that exist and hold liquidity. Customizable pools created outside the presets cannot be derived and
 * are not found; that is a stated limit.
 *
 * Swapping: a swap walks bins from the active one, so the transaction must pass the bin arrays it will touch, in the
 * order it walks them. Aretia passes the active array and the next ones in the swap's direction that exist.
 */
import type * as Web3 from '@solana/web3.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type TokenRef } from '../core/types.js';
import type { LiquidityPool } from '../engine/types.js';
import { sortMints, tokenAccountAmount, type SolRpc } from './raydiumCpmm.js';

export const METEORA_DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
/** Discriminator of the `PresetParameter2` account, from the IDL. */
const PRESET2_DISCRIMINATOR = Uint8Array.from([171, 236, 148, 115, 162, 113, 222, 174]);
const SWAP2 = Uint8Array.from([65, 75, 63, 76, 235, 91, 91, 136]);
/** Bins in one bin array. */
export const BINS_PER_ARRAY = 70;
/** The internal bitmap covers bin array indexes -512 to 511; beyond that the program wants a bitmap extension account. */
const BITMAP_MIN = -512;
const BITMAP_MAX = 511;
const MAX_BIN_ARRAYS = 4;
const MAX_POOLS = 6;
const PRESET_TTL_MS = 6 * 3_600_000;

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

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export interface DlmmPair {
  status: number;
  pairType: number;
  activeId: number;
  binStep: number;
  baseFactor: number;
  mintX: string;
  mintY: string;
  reserveX: string;
  reserveY: string;
  oracle: string;
}

/** Reads a pool account at the IDL's offsets. Null when it is too short. */
export function parseDlmmPair(web3: typeof Web3, data: Uint8Array): DlmmPair | null {
  if (data.length < 904) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pk = (o: number): string => new web3.PublicKey(data.subarray(o, o + 32)).toBase58();
  return { baseFactor: v.getUint16(8, true), pairType: data[75]!, activeId: v.getInt32(76, true), binStep: v.getUint16(80, true), status: data[82]!, mintX: pk(88), mintY: pk(120), reserveX: pk(152), reserveY: pk(184), oracle: pk(552) };
}

export interface Preset {
  binStep: number;
  baseFactor: number;
}

/** Reads a preset account: bin step then base factor, right after the discriminator. */
export function parsePreset(data: Uint8Array): Preset | null {
  if (data.length < 12) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { binStep: v.getUint16(8, true), baseFactor: v.getUint16(10, true) };
}

/** The bin array index that holds a bin id. Floors toward negative infinity, as the program does. */
export const binArrayIndex = (binId: number): number => Math.floor(binId / BINS_PER_ARRAY);

/** The array indexes a swap walks, starting at the active one: down for X to Y, up for Y to X. */
export function walkIndexes(activeId: number, swapForY: boolean, count: number): number[] {
  const start = binArrayIndex(activeId);
  return Array.from({ length: count }, (_, i) => (swapForY ? start - i : start + i));
}

let presetCache: { at: number; presets: Preset[] } | null = null;

export class MeteoraDlmmAdapter {
  private readonly program: Web3.PublicKey;

  constructor(
    private readonly web3: typeof Web3,
    private readonly rpc: SolRpc,
    private readonly now: () => number = Date.now,
  ) {
    this.program = new web3.PublicKey(METEORA_DLMM_PROGRAM);
  }

  private key = (a: string): Uint8Array => new this.web3.PublicKey(a).toBytes();
  private u16 = (n: number): Uint8Array => {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n, true);
    return b;
  };

  /** Pool address for a sorted mint pair and a preset. `legacy` is the older derivation that has no base factor. */
  pairAddress(minMint: string, maxMint: string, binStep: number, baseFactor: number | null): string {
    const seeds = [this.key(minMint), this.key(maxMint), this.u16(binStep), ...(baseFactor === null ? [] : [this.u16(baseFactor)])];
    return this.web3.PublicKey.findProgramAddressSync(seeds, this.program)[0].toBase58();
  }

  binArrayAddress(pair: string, index: number): string {
    const i = new Uint8Array(8);
    new DataView(i.buffer).setBigInt64(0, BigInt(index), true);
    return this.web3.PublicKey.findProgramAddressSync([enc('bin_array'), this.key(pair), i], this.program)[0].toBase58();
  }

  eventAuthority = (): string => this.web3.PublicKey.findProgramAddressSync([enc('__event_authority')], this.program)[0].toBase58();

  private async accounts(addresses: string[], slice0 = false): Promise<({ data: [string, string]; owner: string } | null)[]> {
    const out: ({ data: [string, string]; owner: string } | null)[] = [];
    for (let i = 0; i < addresses.length; i += 90) {
      const part = addresses.slice(i, i + 90);
      const cfg: Record<string, unknown> = { encoding: 'base64', commitment: 'confirmed' };
      if (slice0) cfg.dataSlice = { offset: 0, length: 0 };
      out.push(...(await this.rpc<{ value: ({ data: [string, string]; owner: string } | null)[] }>('getMultipleAccounts', [part, cfg])).value);
    }
    return out;
  }

  /** The program's published presets, read once and kept for hours. */
  async presets(): Promise<Preset[]> {
    if (presetCache && this.now() - presetCache.at < PRESET_TTL_MS) return presetCache.presets;
    const raw = await this.rpc<{ account: { data: [string, string] } }[]>('getProgramAccounts', [METEORA_DLMM_PROGRAM, { encoding: 'base64', dataSlice: { offset: 0, length: 20 }, filters: [{ memcmp: { offset: 0, bytes: encodeBase58(PRESET2_DISCRIMINATOR) } }] }]);
    const seen = new Set<string>();
    const presets: Preset[] = [];
    for (const r of raw) {
      const p = parsePreset(fromBase64(r.account.data[0]));
      if (p && p.binStep > 0 && p.baseFactor > 0 && !seen.has(`${p.binStep}:${p.baseFactor}`)) {
        seen.add(`${p.binStep}:${p.baseFactor}`);
        presets.push(p);
      }
    }
    if (presets.length === 0) throw new SwingsError('provider-failed', 'Meteora DLMM presets could not be read.');
    presetCache = { at: this.now(), presets };
    return presets;
  }

  /** Enabled pools holding both tokens, deepest first, at most a handful. */
  async getPools(a: TokenRef, b: TokenRef): Promise<LiquidityPool[]> {
    const ta = normalizeTokenRef('solana', a.address);
    const tb = normalizeTokenRef('solana', b.address);
    if (!ta || !tb || ta.address === tb.address) throw new SwingsError('invalid', 'Invalid token pair.');
    const [minMint, maxMint] = sortMints(this.web3, ta.address, tb.address);
    const presets = await this.presets();
    const candidates = new Map<string, Preset>();
    for (const p of presets) candidates.set(this.pairAddress(minMint, maxMint, p.binStep, p.baseFactor), p);
    const addresses = [...candidates.keys()];
    const raw = await this.accounts(addresses);
    const parsed = raw
      .map((acc, i) => ({ acc, address: addresses[i]! }))
      .filter((x): x is { acc: { data: [string, string]; owner: string }; address: string } => x.acc !== null && x.acc.owner === METEORA_DLMM_PROGRAM)
      .map((x) => ({ address: x.address, state: parseDlmmPair(this.web3, fromBase64(x.acc.data[0])) }))
      .filter((x): x is { address: string; state: DlmmPair } => x.state !== null && x.state.status === 0 && x.state.mintX === minMint && x.state.mintY === maxMint);
    if (parsed.length === 0) return [];
    const vaults = await this.accounts(parsed.flatMap((p) => [p.state.reserveX, p.state.reserveY]));
    const live = parsed
      .map((p, k) => {
        const vx = vaults[k * 2];
        const vy = vaults[k * 2 + 1];
        if (!vx || !vy) return null;
        return { ...p, vx, vy, rx: tokenAccountAmount(fromBase64(vx.data[0])) ?? 0n, ry: tokenAccountAmount(fromBase64(vy.data[0])) ?? 0n };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null && (p.rx > 0n || p.ry > 0n));
    const depth = (p: { rx: bigint; ry: bigint }): bigint => (p.rx < p.ry ? p.rx : p.ry);
    live.sort((x, y) => (depth(x) > depth(y) ? -1 : depth(x) < depth(y) ? 1 : 0));
    return live.slice(0, MAX_POOLS).map((p): LiquidityPool => ({
      ref: { chain: 'solana', dex: 'meteora-dlmm', address: p.address },
      model: 'concentrated',
      token0: { chain: 'solana', address: p.state.mintX },
      token1: { chain: 'solana', address: p.state.mintY },
      reserve0: p.rx,
      reserve1: p.ry,
      // Base fee only: base factor x bin step x 10, over 1e9, expressed in parts per million.
      feePpm: Math.round((p.state.baseFactor * p.state.binStep) / 100),
      updatedAt: this.now(),
      block: null,
      status: 'active',
      extra: { reserveX: p.state.reserveX, reserveY: p.state.reserveY, oracle: p.state.oracle, activeId: String(p.state.activeId), binStep: String(p.state.binStep), programX: p.vx.owner, programY: p.vy.owner },
    }));
  }

  /** The bin arrays this swap will walk that exist, in walking order. Fewer than needed means the program will say so. */
  async binArrays(pool: LiquidityPool, swapForY: boolean): Promise<string[]> {
    const indexes = walkIndexes(Number(pool.extra!.activeId), swapForY, MAX_BIN_ARRAYS + 2).filter((i) => i >= BITMAP_MIN && i <= BITMAP_MAX);
    const addresses = indexes.map((i) => this.binArrayAddress(pool.ref.address, i));
    const found = await this.accounts(addresses, true);
    return addresses.filter((_, i) => found[i] !== null && found[i]!.owner === METEORA_DLMM_PROGRAM).slice(0, MAX_BIN_ARRAYS);
  }
}

function u64le(v: bigint): Uint8Array {
  if (v < 0n || v >= 1n << 64n) throw new SwingsError('invalid', 'Amount out of range for a u64.');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

/** `swap2` with no transfer-hook accounts: the program's account order, then the bin arrays it walks. */
export async function dlmmSwapInstruction(web3: typeof Web3, adapter: MeteoraDlmmAdapter, user: string, pool: LiquidityPool, tokenIn: TokenRef, inAccount: string, outAccount: string, amountIn: bigint, minOut: bigint): Promise<Web3.TransactionInstruction> {
  const x = pool.extra;
  if (!x || pool.ref.dex !== 'meteora-dlmm') throw new SwingsError('invalid', 'This pool cannot be swapped by the DLMM builder.');
  if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  const swapForY = pool.token0.address === tokenIn.address;
  if (!swapForY && pool.token1.address !== tokenIn.address) throw new SwingsError('invalid', 'The input token is not in this pool.');
  const arrays = await adapter.binArrays(pool, swapForY);
  if (arrays.length === 0) throw new SwingsError('no-route', 'This pool has no liquidity in the direction of the swap.');
  const pk = (a: string): Web3.PublicKey => new web3.PublicKey(a);
  const meta = (a: string, isWritable: boolean, isSigner = false) => ({ pubkey: pk(a), isSigner, isWritable });
  // Anchor's optional accounts are "absent" when the program's own id stands in for them.
  const absent = meta(METEORA_DLMM_PROGRAM, false);
  const keys = [
    meta(pool.ref.address, true), absent, meta(x.reserveX!, true), meta(x.reserveY!, true), meta(inAccount, true), meta(outAccount, true),
    meta(pool.token0.address, false), meta(pool.token1.address, false), meta(x.oracle!, true), { ...absent }, meta(user, true, true),
    meta(x.programX!, false), meta(x.programY!, false), meta(MEMO_PROGRAM, false), meta(adapter.eventAuthority(), false), meta(METEORA_DLMM_PROGRAM, false),
    ...arrays.map((a) => meta(a, true)),
  ];
  // amount_in, min_amount_out, then RemainingAccountsInfo with no slices (a borsh vec of length zero).
  const data = new Uint8Array(8 + 8 + 8 + 4);
  data.set(SWAP2, 0);
  data.set(u64le(amountIn), 8);
  data.set(u64le(minOut), 16);
  return new web3.TransactionInstruction({ programId: pk(METEORA_DLMM_PROGRAM), keys, data: Buffer.from(data) });
}

/** Test hook: forget the cached presets. */
export const resetDlmmPresetCache = (): void => {
  presetCache = null;
};
