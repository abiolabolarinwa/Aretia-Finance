/**
 * Aretia's own pool program (docs/ARETIA_POOL.md) as a Swings venue. DISABLED in the registry (dex/entries.ts), so nothing here runs until the
 * owner enables it, which needs an audit and a mainnet program first. The pair is always (token, SOL); SOL is native lamports inside the
 * program, so the swap instruction takes no wrapped-SOL account. When the router wraps SOL for a route anyway, the wrapped lamports are simply
 * not used and are closed by the router afterwards.
 *
 * Pricing is local and exact: the same integer maths as the program (walletAretiaPoolCore, replayed against the Rust crate in its tests), so no
 * simulation is needed to quote it.
 */
import type * as Web3 from '@solana/web3.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type TokenRef } from '../core/types.js';
import type { LiquidityPool } from '../engine/types.js';
import { atTime, parsePoolAccount, poolMathOf, buy, sell, type PoolMath } from '../../scripts/walletAretiaPoolCore.js';
import { buildSwap, poolAddress } from '../../scripts/walletAretiaPoolTx.js';
import type { SolRpc } from './raydiumCpmm.js';

export const WSOL = 'So11111111111111111111111111111111111111112';

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** The pool's numbers as a PoolMath, from the strings kept in `extra`. */
export function mathFromPool(pool: LiquidityPool): PoolMath {
  const e = pool.extra;
  if (!e || e.x === undefined) throw new SwingsError('invalid', 'This is not an Aretia pool.');
  return { x: BigInt(e.x), vx: BigInt(e.vx ?? 0), y: BigInt(e.y!), l: BigInt(e.l!), feeBps: Number(e.feeBps), acc: BigInt(e.acc!), feeReserve: BigInt(e.feeReserve!), feeStartBps: Number(e.feeStartBps ?? 0), decaySecs: Number(e.decaySecs ?? 0), startTs: BigInt(e.startTs ?? 0) };
}

/** Exact output of a swap, or 0n when the program would refuse it. `tokenIn` is SOL for a buy, the token for a sell. */
export function aretiaPoolQuote(pool: LiquidityPool, tokenIn: TokenRef, amountIn: bigint, nowSecs: bigint = BigInt(Math.floor(Date.now() / 1000))): bigint {
  // The fee in force now, which includes the creator's launch schedule while it lasts.
  const m = atTime(mathFromPool(pool), nowSecs);
  if (tokenIn.address === WSOL) return buy(m, amountIn)?.result.tokensOut ?? 0n;
  return sell(m, amountIn)?.result.net ?? 0n;
}

export class AretiaPoolAdapter {
  constructor(
    private readonly web3: typeof Web3,
    private readonly rpc: SolRpc,
    private readonly program: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The pool for a (token, SOL) pair, if one exists and is the program's. Any other pair has none. */
  async getPools(a: TokenRef, b: TokenRef): Promise<LiquidityPool[]> {
    const ta = normalizeTokenRef('solana', a.address);
    const tb = normalizeTokenRef('solana', b.address);
    if (!ta || !tb || ta.address === tb.address) throw new SwingsError('invalid', 'Invalid token pair.');
    const token = ta.address === WSOL ? tb : tb.address === WSOL ? ta : null;
    if (!token) return [];
    const address = poolAddress(this.web3, this.program, token.address);
    const r = await this.rpc<{ value: ({ data: [string, string]; owner: string } | null)[] }>('getMultipleAccounts', [[address], { encoding: 'base64', commitment: 'confirmed' }]);
    const acc = r.value[0];
    if (!acc || acc.owner !== this.program) return [];
    const state = parsePoolAccount(fromBase64(acc.data[0]), (bytes) => new this.web3.PublicKey(bytes).toBase58());
    if (!state || state.mint !== token.address) return [];
    const m = poolMathOf(state);
    return [
      {
        ref: { chain: 'solana', dex: 'aretia-pool', address },
        model: 'constant-product',
        curve: 'aretia-pool',
        token0: { chain: 'solana', address: token.address },
        token1: { chain: 'solana', address: WSOL },
        // The effective reserves the curve prices against: tokens, and real plus virtual SOL.
        reserve0: m.x + m.vx,
        reserve1: m.y + m.l,
        feePpm: m.feeBps * 100,
        updatedAt: this.now(),
        block: null,
        status: m.x > 0n && m.l > 0n ? 'active' : 'inactive',
        extra: { mint: token.address, x: String(m.x), vx: String(m.vx), y: String(m.y), l: String(m.l), feeBps: String(m.feeBps), acc: String(m.acc), feeReserve: String(m.feeReserve), feeStartBps: String(state.feeStartBps), decaySecs: String(state.decaySecs), startTs: String(state.createdAt) },
      },
    ];
  }
}

/** The one swap instruction. Native SOL is handled by the program, so the in and out accounts the router passes are not used. */
export function aretiaPoolSwapInstruction(web3: typeof Web3, program: string, user: string, pool: LiquidityPool, tokenIn: TokenRef, amountIn: bigint, minOut: bigint): Web3.TransactionInstruction {
  if (minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  return buildSwap(web3, program, { trader: user, mint: pool.extra!.mint!, isBuy: tokenIn.address === WSOL, amountIn, minOut });
}
