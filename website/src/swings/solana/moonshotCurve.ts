/**
 * Direct integration with Moonit (formerly Moonshot), a Solana launchpad: where a token trades from its launch until its
 * curve fills and it migrates to a normal pool. Before this, such a token had no pool Aretia could read.
 *
 * The curve account of a token is found by the program's own address derivation (seeds "token" and the mint), parsed
 * against the layout of the program's on-chain IDL, and swapped with `buy` and `sell`. As with the pump.fun curve, the
 * program itself is the quoter: a swap is simulated from the user's account and the amount delivered is the price.
 *
 * The program spends and pays native SOL directly, not wrapped SOL, so a buy first unwraps the SOL the route builder
 * wrapped (the wrapped account is closed, then opened empty so the route's own closing step still finds it), and a sell
 * pays SOL straight to the user.
 *
 * Scope, stated plainly: curves that exist and are priced in SOL. A token that has migrated no longer has a curve here and
 * is served by the pool it migrated to.
 */
import type * as Web3 from '@solana/web3.js';
import { ataAddress, createAtaIdempotentInstruction, TOKEN_PROGRAM_ID } from '../../scripts/walletTools.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type TokenRef } from '../core/types.js';
import type { LiquidityPool } from '../engine/types.js';
import { closeAccount } from './builder.js';
import { type SolRpc } from './raydiumCpmm.js';

export const MOONSHOT_PROGRAM = 'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG';
const WSOL = 'So11111111111111111111111111111111111111112';
const SYSTEM = '11111111111111111111111111111111';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const DISC_BUY = Uint8Array.from([102, 6, 61, 18, 1, 218, 235, 234]);
const DISC_SELL = Uint8Array.from([51, 230, 133, 164, 1, 127, 131, 173]);
const DISC_CURVE = Uint8Array.from([8, 91, 83, 28, 132, 216, 248, 22]);

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export interface MoonshotCurve {
  totalSupply: bigint;
  /** Tokens still for sale on the curve. */
  curveAmount: bigint;
  mint: string;
  decimals: number;
  /** 0 = SOL, the only collateral the program has. */
  collateral: number;
}

/** Reads a curve account. Null when it is too short or is not one. */
export function parseMoonshotCurve(web3: typeof Web3, data: Uint8Array): MoonshotCurve | null {
  if (data.length < 82 || !DISC_CURVE.every((b, i) => data[i] === b)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { totalSupply: view.getBigUint64(8, true), curveAmount: view.getBigUint64(16, true), mint: new web3.PublicKey(data.subarray(24, 56)).toBase58(), decimals: data[56]!, collateral: data[57]! };
}

/** The two fee accounts a trade must name, from the program's config account. Null when it is too short. */
export function parseMoonshotConfig(web3: typeof Web3, data: Uint8Array): { helioFee: string; dexFee: string } | null {
  if (data.length < 168) return null;
  return { helioFee: new web3.PublicKey(data.subarray(104, 136)).toBase58(), dexFee: new web3.PublicKey(data.subarray(136, 168)).toBase58() };
}

export class MoonshotAdapter {
  private readonly program: Web3.PublicKey;
  private fees: { helioFee: string; dexFee: string } | null = null;

  constructor(
    private readonly web3: typeof Web3,
    private readonly rpc: SolRpc,
    private readonly now: () => number = Date.now,
  ) {
    this.program = new web3.PublicKey(MOONSHOT_PROGRAM);
  }

  private pda(seeds: Uint8Array[]): string {
    return this.web3.PublicKey.findProgramAddressSync(seeds, this.program)[0].toBase58();
  }
  private key = (a: string): Uint8Array => new this.web3.PublicKey(a).toBytes();

  curve = (mint: string): string => this.pda([enc('token'), this.key(mint)]);
  config = (): string => this.pda([enc('config_account')]);

  private async accounts(addresses: string[]): Promise<({ data: [string, string]; owner: string } | null)[]> {
    if (addresses.length === 0) return [];
    return (await this.rpc<{ value: ({ data: [string, string]; owner: string } | null)[] }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }])).value;
  }

  async feeAccounts(): Promise<{ helioFee: string; dexFee: string }> {
    if (this.fees) return this.fees;
    const [acc] = await this.accounts([this.config()]);
    const f = acc && acc.owner === MOONSHOT_PROGRAM ? parseMoonshotConfig(this.web3, fromBase64(acc.data[0])) : null;
    if (!f) throw new SwingsError('provider-failed', "The launchpad's configuration could not be read.");
    this.fees = f;
    return f;
  }

  /** The curve of a token against SOL, in either order, while it still exists with tokens for sale. */
  async getPools(a: TokenRef, b: TokenRef): Promise<LiquidityPool[]> {
    const ta = normalizeTokenRef('solana', a.address);
    const tb = normalizeTokenRef('solana', b.address);
    if (!ta || !tb || ta.address === tb.address) throw new SwingsError('invalid', 'Invalid token pair.');
    const mint = ta.address === WSOL ? tb.address : tb.address === WSOL ? ta.address : null;
    if (!mint) return [];
    const address = this.curve(mint);
    const [acc] = await this.accounts([address]);
    if (!acc || acc.owner !== MOONSHOT_PROGRAM) return [];
    const s = parseMoonshotCurve(this.web3, fromBase64(acc.data[0]));
    if (!s || s.mint !== mint) return [];
    return [
      {
        ref: { chain: 'solana', dex: 'moonshot', address },
        model: 'constant-product',
        token0: { chain: 'solana', address: mint },
        token1: { chain: 'solana', address: WSOL },
        reserve0: s.curveAmount,
        reserve1: 0n,
        feePpm: 0,
        updatedAt: this.now(),
        block: null,
        status: s.collateral === 0 && s.curveAmount > 0n ? 'active' : 'inactive',
        extra: { curveVault: ataAddress(this.web3, address, mint, TOKEN_PROGRAM_ID) },
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
 * The instructions of one swap. Buying with SOL: the wrapped SOL is unwrapped, then `buy` is called with the SOL to spend
 * fixed (exact in) and the least tokens accepted. Selling: `sell` with the tokens to sell fixed and the least SOL accepted.
 * The program enforces the floor. No extra slippage tolerance is added on top of the floor.
 */
export async function moonshotSwapInstructions(web3: typeof Web3, adapter: MoonshotAdapter, user: string, pool: LiquidityPool, tokenIn: TokenRef, inAccount: string, outAccount: string, amountIn: bigint, minOut: bigint): Promise<Web3.TransactionInstruction[]> {
  if (pool.ref.dex !== 'moonshot' || !pool.extra?.curveVault) throw new SwingsError('invalid', 'This pool cannot be swapped by the launchpad builder.');
  if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  const mint = pool.token0.address;
  const selling = tokenIn.address === mint;
  if (!selling && tokenIn.address !== WSOL) throw new SwingsError('invalid', 'The input token is not in this curve.');
  const fees = await adapter.feeAccounts();
  const pk = (a: string): Web3.PublicKey => new web3.PublicKey(a);
  const meta = (a: string, isWritable = false, isSigner = false) => ({ pubkey: pk(a), isSigner, isWritable });
  const userToken = selling ? inAccount : outAccount;
  const keys = [meta(user, true, true), meta(userToken, true), meta(pool.ref.address, true), meta(pool.extra.curveVault, true), meta(fees.dexFee, true), meta(fees.helioFee, true), meta(mint), meta(adapter.config()), meta(TOKEN_PROGRAM_ID), meta(ATA_PROGRAM), meta(SYSTEM)];
  // TradeParams: tokenAmount, collateralAmount, fixedSide (0 = exact in), slippageBps
  const params = selling ? concat(u64le(amountIn), u64le(minOut), Uint8Array.from([0]), u64le(0n)) : concat(u64le(minOut), u64le(amountIn), Uint8Array.from([0]), u64le(0n));
  const swap = new web3.TransactionInstruction({ programId: pk(MOONSHOT_PROGRAM), keys, data: Buffer.from(concat(selling ? DISC_SELL : DISC_BUY, params)) });
  if (selling) return [swap];
  return [closeAccount(web3, inAccount, user, user), createAtaIdempotentInstruction(web3, user, inAccount, user, WSOL, TOKEN_PROGRAM_ID), swap];
}
