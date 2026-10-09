/**
 * Direct integration with Boop (boop.fun), a Solana launchpad: where a token trades from its launch until its curve fills
 * and it graduates to Raydium. Before this, such a token had no pool Aretia could read.
 *
 * The curve account of a token is found by the program's own address derivation (seeds "bonding_curve" and the mint),
 * parsed against the layout of the program's on-chain IDL, and swapped with `buy_token` and `sell_token`. As with the
 * pump.fun curve, the program itself is the quoter: a swap is simulated from the user's account and the amount delivered
 * is the price, and the program enforces the minimum output.
 *
 * Boop spends and pays native SOL directly, not wrapped SOL. The route builder wraps SOL for every route that starts in
 * SOL, so a buy first unwraps that SOL again (the wrapped account is closed, then opened empty so the route's own closing
 * step still finds it); a sell pays SOL straight to the user and the builder's own unwrap closes the empty wSOL account.
 *
 * Scope, stated plainly: curves in their trading state only. A graduated token trades on Raydium, which is another venue.
 */
import type * as Web3 from '@solana/web3.js';
import { createAtaIdempotentInstruction, TOKEN_PROGRAM_ID } from '../../scripts/walletTools.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type TokenRef } from '../core/types.js';
import type { LiquidityPool } from '../engine/types.js';
import { closeAccount } from './builder.js';
import { type SolRpc } from './raydiumCpmm.js';

export const BOOP_PROGRAM = 'boop8hVGQGqehUK2iVEMEnMrL5RbjywRzHKBmBE7ry4';
const WSOL = 'So11111111111111111111111111111111111111112';
const SYSTEM = '11111111111111111111111111111111';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const DISC_BUY = Uint8Array.from([138, 127, 14, 91, 38, 87, 115, 105]);
const DISC_SELL = Uint8Array.from([109, 61, 40, 187, 230, 176, 135, 174]);
const DISC_CURVE = Uint8Array.from([23, 183, 248, 55, 96, 216, 172, 96]);

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export interface BoopCurve {
  creator: string;
  mint: string;
  virtualSol: bigint;
  virtualTokens: bigint;
  solReserves: bigint;
  tokenReserves: bigint;
  /** 0 while the curve trades; anything else means it has graduated or is being migrated. */
  status: number;
}

/** Reads a bonding-curve account. Null when it is too short or is not one. */
export function parseBoopCurve(web3: typeof Web3, data: Uint8Array): BoopCurve | null {
  if (data.length < 125 || !DISC_CURVE.every((b, i) => data[i] === b)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pk = (o: number): string => new web3.PublicKey(data.subarray(o, o + 32)).toBase58();
  return { creator: pk(8), mint: pk(40), virtualSol: view.getBigUint64(72, true), virtualTokens: view.getBigUint64(80, true), solReserves: view.getBigUint64(104, true), tokenReserves: view.getBigUint64(112, true), status: data[124]! };
}

export class BoopAdapter {
  private readonly program: Web3.PublicKey;

  constructor(
    private readonly web3: typeof Web3,
    private readonly rpc: SolRpc,
    private readonly now: () => number = Date.now,
  ) {
    this.program = new web3.PublicKey(BOOP_PROGRAM);
  }

  private pda(seeds: Uint8Array[]): string {
    return this.web3.PublicKey.findProgramAddressSync(seeds, this.program)[0].toBase58();
  }
  private key = (a: string): Uint8Array => new this.web3.PublicKey(a).toBytes();

  curve = (mint: string): string => this.pda([enc('bonding_curve'), this.key(mint)]);
  tradingFeesVault = (mint: string): string => this.pda([enc('trading_fees_vault'), this.key(mint)]);
  tokenVault = (mint: string): string => this.pda([enc('bonding_curve_vault'), this.key(mint)]);
  solVault = (mint: string): string => this.pda([enc('bonding_curve_sol_vault'), this.key(mint)]);
  config = (): string => this.pda([enc('config')]);
  vaultAuthority = (): string => this.pda([enc('vault_authority')]);

  private async accounts(addresses: string[]): Promise<({ data: [string, string]; owner: string } | null)[]> {
    if (addresses.length === 0) return [];
    return (await this.rpc<{ value: ({ data: [string, string]; owner: string } | null)[] }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }])).value;
  }

  /** The curve of a token against SOL, in either order, while it is trading. */
  async getPools(a: TokenRef, b: TokenRef): Promise<LiquidityPool[]> {
    const ta = normalizeTokenRef('solana', a.address);
    const tb = normalizeTokenRef('solana', b.address);
    if (!ta || !tb || ta.address === tb.address) throw new SwingsError('invalid', 'Invalid token pair.');
    const mint = ta.address === WSOL ? tb.address : tb.address === WSOL ? ta.address : null;
    if (!mint) return [];
    const address = this.curve(mint);
    const [acc] = await this.accounts([address]);
    if (!acc || acc.owner !== BOOP_PROGRAM) return [];
    const s = parseBoopCurve(this.web3, fromBase64(acc.data[0]));
    if (!s || s.mint !== mint) return [];
    return [
      {
        ref: { chain: 'solana', dex: 'boop', address },
        model: 'constant-product',
        token0: { chain: 'solana', address: mint },
        token1: { chain: 'solana', address: WSOL },
        reserve0: s.virtualTokens,
        reserve1: s.virtualSol,
        feePpm: 0,
        updatedAt: this.now(),
        block: null,
        status: s.status === 0 && s.tokenReserves > 0n && s.virtualSol > 0n ? 'active' : 'inactive',
        extra: {},
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
 * The instructions of one Boop swap. Buying with SOL: the wrapped SOL the route builder prepared is closed (its SOL
 * returns to the user) and opened again empty, then `buy_token` spends native SOL. Selling: `sell_token`, which pays SOL
 * straight to the user.
 */
export function boopSwapInstructions(web3: typeof Web3, adapter: BoopAdapter, user: string, pool: LiquidityPool, tokenIn: TokenRef, inAccount: string, outAccount: string, amountIn: bigint, minOut: bigint): Web3.TransactionInstruction[] {
  if (pool.ref.dex !== 'boop') throw new SwingsError('invalid', 'This pool cannot be swapped by the Boop builder.');
  if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  const mint = pool.token0.address;
  const selling = tokenIn.address === mint;
  if (!selling && tokenIn.address !== WSOL) throw new SwingsError('invalid', 'The input token is not in this curve.');
  const pk = (a: string): Web3.PublicKey => new web3.PublicKey(a);
  const meta = (a: string, isWritable = false, isSigner = false) => ({ pubkey: pk(a), isSigner, isWritable });
  const curve = pool.ref.address;
  const shared = [meta(mint), meta(curve, true), meta(adapter.tradingFeesVault(mint), true), meta(adapter.tokenVault(mint), true), meta(adapter.solVault(mint), true)];
  if (selling) {
    const keys = [...shared, meta(inAccount, true), meta(user, true, true), meta(user, true), meta(adapter.config()), meta(SYSTEM), meta(TOKEN_PROGRAM_ID), meta(ATA_PROGRAM)];
    return [new web3.TransactionInstruction({ programId: pk(BOOP_PROGRAM), keys, data: Buffer.from(concat(DISC_SELL, u64le(amountIn), u64le(minOut))) })];
  }
  const keys = [...shared, meta(outAccount, true), meta(user, true, true), meta(adapter.config()), meta(adapter.vaultAuthority()), meta(WSOL), meta(SYSTEM), meta(TOKEN_PROGRAM_ID), meta(ATA_PROGRAM)];
  return [
    closeAccount(web3, inAccount, user, user),
    createAtaIdempotentInstruction(web3, user, inAccount, user, WSOL, TOKEN_PROGRAM_ID),
    new web3.TransactionInstruction({ programId: pk(BOOP_PROGRAM), keys, data: Buffer.from(concat(DISC_BUY, u64le(amountIn), u64le(minOut))) }),
  ];
}

