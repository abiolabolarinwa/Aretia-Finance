/**
 * Direct integration with the pump.fun bonding curve: where a pump.fun token trades from its launch until it fills the
 * curve and moves to PumpSwap. Before this, such a token had no pool Aretia could read.
 *
 * The curve account of a token is found by the program's own address derivation (seed "bonding-curve" + the mint),
 * parsed against the layout of the program's published IDL, and swapped with `buy_exact_sol_in` and `sell`. Like
 * PumpSwap, the program itself is the quoter: a swap is simulated from the user's account and the amount delivered is
 * the price, so fee changes on the program's side can never make Aretia quote something the program will not do.
 *
 * Scope, stated plainly: curves priced in SOL only (pump.fun is adding other quote tokens), and only curves that have
 * not completed. A completed curve has moved to PumpSwap, which has its own venue.
 *
 * The program takes and pays native SOL directly from the user's account, not through a wrapped-SOL account. The route
 * builder wraps SOL for every route that starts in SOL, so a buy first unwraps that SOL again (see
 * `pumpCurveInstructions`); a sell pays SOL straight to the user and the builder's own unwrap closes the empty wSOL account.
 */
import type * as Web3 from '@solana/web3.js';
import { ataAddress, createAtaIdempotentInstruction, TOKEN_PROGRAM_ID } from '../../scripts/walletTools.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type TokenRef } from '../core/types.js';
import type { LiquidityPool } from '../engine/types.js';
import { PUMP_FEE_PROGRAM, PUMP_PROGRAM } from './pumpswap.js';
import { type SolRpc } from './raydiumCpmm.js';
import { closeAccount } from './builder.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const SYSTEM = '11111111111111111111111111111111';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
/** The second seed of the fee-config account, a constant of the fee program. */
const FEE_CONFIG_SEED = Uint8Array.from([1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81, 137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176]);

const DISC_BUY_EXACT_SOL_IN = Uint8Array.from([56, 252, 116, 8, 158, 223, 205, 95]);
const DISC_SELL = Uint8Array.from([51, 230, 133, 164, 1, 127, 131, 173]);

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export interface PumpCurve {
  virtualTokens: bigint;
  virtualSol: bigint;
  realTokens: bigint;
  realSol: bigint;
  complete: boolean;
  creator: string;
  mayhem: boolean;
  cashback: boolean;
  quoteMint: string;
}

/** Reads a bonding-curve account. Null when it is too short to be one. */
export function parsePumpCurve(web3: typeof Web3, data: Uint8Array): PumpCurve | null {
  if (data.length < 115) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pk = (o: number): string => new web3.PublicKey(data.subarray(o, o + 32)).toBase58();
  return { virtualTokens: view.getBigUint64(8, true), virtualSol: view.getBigUint64(16, true), realTokens: view.getBigUint64(24, true), realSol: view.getBigUint64(32, true), complete: data[48] === 1, creator: pk(49), mayhem: data[81] === 1, cashback: data[82] === 1, quoteMint: pk(83) };
}

export interface PumpCurveGlobal {
  feeRecipient: string;
  /** The recipient a curve in "mayhem mode" must pay its fee to. */
  reservedFeeRecipient: string;
  /** The recipient of the buyback share of fees, which the live program requires after the documented accounts. */
  buybackFeeRecipient: string;
}

/** Reads the program's global account for the fee recipients a swap must name. Null when it is too short. */
export function parsePumpCurveGlobal(web3: typeof Web3, data: Uint8Array): PumpCurveGlobal | null {
  if (data.length < 773) return null;
  const pk = (o: number): string => new web3.PublicKey(data.subarray(o, o + 32)).toBase58();
  return { feeRecipient: pk(41), reservedFeeRecipient: pk(483), buybackFeeRecipient: pk(741) };
}

export class PumpCurveAdapter {
  private readonly program: Web3.PublicKey;
  private global: PumpCurveGlobal | null = null;

  constructor(
    private readonly web3: typeof Web3,
    private readonly rpc: SolRpc,
    private readonly now: () => number = Date.now,
  ) {
    this.program = new web3.PublicKey(PUMP_PROGRAM);
  }

  private pda(seeds: Uint8Array[], program: Web3.PublicKey = this.program): string {
    return this.web3.PublicKey.findProgramAddressSync(seeds, program)[0].toBase58();
  }
  private key = (a: string): Uint8Array => new this.web3.PublicKey(a).toBytes();

  curveAddress = (mint: string): string => this.pda([enc('bonding-curve'), this.key(mint)]);
  curveV2 = (mint: string): string => this.pda([enc('bonding-curve-v2'), this.key(mint)]);
  globalAddress = (): string => this.pda([enc('global')]);
  eventAuthority = (): string => this.pda([enc('__event_authority')]);
  globalVolumeAccumulator = (): string => this.pda([enc('global_volume_accumulator')]);
  userVolumeAccumulator = (user: string): string => this.pda([enc('user_volume_accumulator'), this.key(user)]);
  creatorVault = (creator: string): string => this.pda([enc('creator-vault'), this.key(creator)]);
  feeConfig = (): string => this.pda([enc('fee_config'), FEE_CONFIG_SEED], new this.web3.PublicKey(PUMP_FEE_PROGRAM));

  private async accounts(addresses: string[]): Promise<({ data: [string, string]; owner: string } | null)[]> {
    if (addresses.length === 0) return [];
    return (await this.rpc<{ value: ({ data: [string, string]; owner: string } | null)[] }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }])).value;
  }

  async globalConfig(): Promise<PumpCurveGlobal> {
    if (this.global) return this.global;
    const [acc] = await this.accounts([this.globalAddress()]);
    const g = acc && acc.owner === PUMP_PROGRAM ? parsePumpCurveGlobal(this.web3, fromBase64(acc.data[0])) : null;
    if (!g) throw new SwingsError('provider-failed', "pump.fun's global configuration could not be read.");
    this.global = g;
    return g;
  }

  /** The bonding curve of a token against SOL, in either order, when it is still open for trading. */
  async getPools(a: TokenRef, b: TokenRef): Promise<LiquidityPool[]> {
    const ta = normalizeTokenRef('solana', a.address);
    const tb = normalizeTokenRef('solana', b.address);
    if (!ta || !tb || ta.address === tb.address) throw new SwingsError('invalid', 'Invalid token pair.');
    const mint = ta.address === WSOL ? tb.address : tb.address === WSOL ? ta.address : null;
    if (!mint) return [];
    const curve = this.curveAddress(mint);
    const [curveAcc, mintAcc] = await this.accounts([curve, mint]);
    if (!curveAcc || curveAcc.owner !== PUMP_PROGRAM || !mintAcc) return [];
    const s = parsePumpCurve(this.web3, fromBase64(curveAcc.data[0]));
    if (!s) return [];
    // Only SOL-priced curves are supported, and a completed curve has moved to PumpSwap.
    const solPriced = s.quoteMint === SYSTEM || s.quoteMint === WSOL;
    const open = !s.complete && solPriced && s.realTokens > 0n && s.virtualTokens > 0n && s.virtualSol > 0n;
    return [
      {
        ref: { chain: 'solana', dex: 'pump-curve', address: curve },
        model: 'constant-product',
        token0: { chain: 'solana', address: mint },
        token1: { chain: 'solana', address: WSOL },
        reserve0: s.virtualTokens,
        reserve1: s.virtualSol,
        feePpm: 0,
        updatedAt: this.now(),
        block: null,
        status: open ? 'active' : 'inactive',
        extra: { creator: s.creator, mayhem: s.mayhem ? '1' : '0', cashback: s.cashback ? '1' : '0', mintProgram: mintAcc.owner },
      },
    ];
  }
}

function u64le(v: bigint): Uint8Array {
  if (v < 0n || v >= 1n << 64n) throw new SwingsError('invalid', 'Amount out of range for a u64.');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/**
 * The instructions of one bonding-curve swap. Buying with SOL: the route builder has already wrapped the SOL, but the
 * program spends native SOL from the user, so the wrapped account is closed (its SOL returns to the user) and opened
 * again empty (so the route's own closing step still finds it), then `buy_exact_sol_in` runs. Selling the token calls
 * `sell`, which pays SOL straight to the user.
 */
export async function pumpCurveInstructions(web3: typeof Web3, adapter: PumpCurveAdapter, user: string, pool: LiquidityPool, tokenIn: TokenRef, inAccount: string, outAccount: string, amountIn: bigint, minOut: bigint): Promise<Web3.TransactionInstruction[]> {
  const x = pool.extra;
  if (!x || pool.ref.dex !== 'pump-curve') throw new SwingsError('invalid', 'This pool cannot be swapped by the bonding-curve builder.');
  if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  const mint = pool.token0.address;
  const selling = tokenIn.address === mint;
  if (!selling && tokenIn.address !== WSOL) throw new SwingsError('invalid', 'The input token is not in this curve.');
  const g = await adapter.globalConfig();
  const feeRecipient = x.mayhem === '1' ? g.reservedFeeRecipient : g.feeRecipient;
  const tokenProgram = x.mintProgram ?? TOKEN_PROGRAM_ID;
  const curve = pool.ref.address;
  const curveVault = ataAddress(web3, curve, mint, tokenProgram);
  const pk = (a: string): Web3.PublicKey => new web3.PublicKey(a);
  const meta = (a: string, isWritable = false, isSigner = false) => ({ pubkey: pk(a), isSigner, isWritable });
  const creatorVault = adapter.creatorVault(x.creator!);
  const userToken = selling ? inAccount : outAccount;
  const tail = [meta(adapter.curveV2(mint)), meta(g.buybackFeeRecipient, true)];
  const accountsFor = (buy: boolean) => {
    const head = [meta(adapter.globalAddress()), meta(feeRecipient, true), meta(mint), meta(curve, true), meta(curveVault, true), meta(userToken, true), meta(user, true, true), meta(SYSTEM)];
    // The two instructions list the token program and the creator vault in opposite orders.
    const mid = buy ? [meta(tokenProgram), meta(creatorVault, true)] : [meta(creatorVault, true), meta(tokenProgram)];
    const events = [meta(adapter.eventAuthority()), meta(PUMP_PROGRAM)];
    return buy
      ? [...head, ...mid, ...events, meta(adapter.globalVolumeAccumulator()), meta(adapter.userVolumeAccumulator(user), true), meta(adapter.feeConfig()), meta(PUMP_FEE_PROGRAM), ...tail]
      : [...head, ...mid, ...events, meta(adapter.feeConfig()), meta(PUMP_FEE_PROGRAM), ...(x.cashback === '1' ? [meta(adapter.userVolumeAccumulator(user), true)] : []), ...tail];
  };
  if (selling) {
    return [new web3.TransactionInstruction({ programId: pk(PUMP_PROGRAM), keys: accountsFor(false), data: Buffer.from(concat(DISC_SELL, u64le(amountIn), u64le(minOut))) })];
  }
  return [
    closeAccount(web3, inAccount, user, user),
    createAtaIdempotentInstruction(web3, user, inAccount, user, WSOL, TOKEN_PROGRAM_ID),
    // spendable_sol_in, min_tokens_out, track_volume = false, partial_fill = false
    new web3.TransactionInstruction({ programId: pk(PUMP_PROGRAM), keys: accountsFor(true), data: Buffer.from(concat(DISC_BUY_EXACT_SOL_IN, u64le(amountIn), u64le(minOut), Uint8Array.from([0, 0]))) }),
  ];
}

export { ATA_PROGRAM as PUMP_CURVE_ATA_PROGRAM };
