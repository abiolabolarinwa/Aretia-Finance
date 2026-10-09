/**
 * Direct integration with Four.meme, the bonding-curve launchpad of BNB Chain: where a token trades from its launch
 * until its curve fills and it moves to PancakeSwap. Before this, such a token had no pool Aretia could read.
 *
 * The launchpad's own helper contract is the quoter (`getTokenInfo`, `tryBuy`, `trySell`), and the launchpad's token
 * manager is the counterparty: `buyTokenAMAP` spends BNB for tokens and `sellToken` pays BNB for tokens, each with a
 * floor the contract enforces itself (it reverts with "Slippage"). Both were checked against the live contracts by
 * simulation (see `fourMeme.live.ts`).
 *
 * Scope, stated plainly: tokens priced in BNB whose curve is open and managed by the current token manager. Tokens
 * priced in another coin, tokens of older managers and tokens that have already moved to PancakeSwap are not offered
 * here (the last are served by PancakeSwap itself). Only swaps against BNB are covered.
 */
import type { EvmRead } from '../chains/evmSession.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError } from '../core/types.js';
import { address, encodeCall, uint, words, wordToAddress, wordToBigInt } from '../engine/abi.js';
import type { DexEntry } from '../engine/registry.js';
import type { EvmTxPlan } from '../execution/evmV2Builder.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const SIG = {
  info: 'getTokenInfo(address)',
  tryBuy: 'tryBuy(address,uint256,uint256)',
  trySell: 'trySell(address,uint256)',
  buy: 'buyTokenAMAP(address,uint256,uint256)',
  sell: 'sellToken(uint256,address,uint256,uint256,uint256,address)',
} as const;

export interface FourMemeInfo {
  version: bigint;
  tokenManager: string;
  quote: string;
  liquidityAdded: boolean;
  offersLeft: bigint;
}

export interface FourMemeQuote {
  amountOut: bigint;
  info: FourMemeInfo;
}

const isAddr = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);

export class EvmFourMemeAdapter {
  constructor(
    readonly entry: DexEntry,
    private readonly read: EvmRead,
  ) {
    if (entry.mechanism !== 'evm-launchpad-curve' || !entry.router || !entry.quoter) throw new SwingsError('invalid', `${entry.id} is not a launchpad curve entry.`);
  }

  private async call(to: string, data: string, block?: bigint): Promise<string[]> {
    const out = await this.read('eth_call', [{ to, data }, block === undefined ? 'latest' : '0x' + block.toString(16)]);
    if (typeof out !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(out)) throw new SwingsError('invalid', 'The node returned malformed data.');
    return words(out);
  }

  /** The launchpad's record of a token, or null when it is not an open BNB-priced curve of the supported token manager. */
  async info(token: string, block?: bigint): Promise<FourMemeInfo | null> {
    if (!isAddr(token)) return null;
    try {
      const w = await this.call(this.entry.quoter!, encodeCall(SIG.info, [address(token)]), block);
      if (w.length < 12) return null;
      const info: FourMemeInfo = { version: wordToBigInt(w[0]!), tokenManager: wordToAddress(w[1]!), quote: wordToAddress(w[2]!), liquidityAdded: wordToBigInt(w[11]!) !== 0n, offersLeft: wordToBigInt(w[7]!) };
      if (info.tokenManager !== this.entry.router!.toLowerCase() || info.quote !== ZERO || info.liquidityAdded || info.offersLeft === 0n) return null;
      return info;
    } catch {
      return null;
    }
  }

  /** Tokens `bnbIn` buys, as the launchpad itself estimates (fee included). Null when it refuses. */
  async quoteBuy(token: string, bnbIn: bigint, block?: bigint): Promise<FourMemeQuote | null> {
    const info = await this.info(token, block);
    if (!info || bnbIn <= 0n) return null;
    try {
      const w = await this.call(this.entry.quoter!, encodeCall(SIG.tryBuy, [address(token), uint(0n), uint(bnbIn)]), block);
      const out = wordToBigInt(w[2] ?? '0');
      // The helper must name the same manager and a BNB-priced curve, or the numbers belong to something else.
      if (wordToAddress(w[0] ?? '') !== this.entry.router!.toLowerCase() || wordToAddress(w[1] ?? '') !== ZERO) return null;
      return out > 0n ? { amountOut: out, info } : null;
    } catch {
      return null;
    }
  }

  /** BNB that selling `amount` tokens pays, after the launchpad's fee. Null when it refuses. */
  async quoteSell(token: string, amount: bigint, block?: bigint): Promise<FourMemeQuote | null> {
    const info = await this.info(token, block);
    if (!info || amount <= 0n) return null;
    try {
      const w = await this.call(this.entry.quoter!, encodeCall(SIG.trySell, [address(token), uint(amount)]), block);
      const out = wordToBigInt(w[2] ?? '0');
      if (wordToAddress(w[0] ?? '') !== this.entry.router!.toLowerCase() || wordToAddress(w[1] ?? '') !== ZERO) return null;
      return out > 0n ? { amountOut: out, info } : null;
    } catch {
      return null;
    }
  }

  /** The best this venue offers for a swap between BNB and a token, or null. */
  async bestRoute(tokenIn: string, tokenOut: string, amountIn: bigint, block?: bigint): Promise<{ token: string; buying: boolean; amountOut: bigint } | null> {
    const wrapped = this.entry.wrappedNative!.toLowerCase();
    const a = normalizeTokenRef(this.entry.chain, tokenIn);
    const b = normalizeTokenRef(this.entry.chain, tokenOut);
    if (!a || !b || a.address === b.address) throw new SwingsError('invalid', 'Invalid token pair for this network.');
    if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
    if (a.address === wrapped) {
      const q = await this.quoteBuy(b.address, amountIn, block);
      return q ? { token: b.address, buying: true, amountOut: q.amountOut } : null;
    }
    if (b.address === wrapped) {
      const q = await this.quoteSell(a.address, amountIn, block);
      return q ? { token: a.address, buying: false, amountOut: q.amountOut } : null;
    }
    return null;
  }
}

export interface FourMemeSwapParams {
  token: string;
  buying: boolean;
  amountIn: bigint;
  minOut: bigint;
}

/**
 * Buying: `buyTokenAMAP(token, funds, minAmount)` with the BNB attached. Selling: `sellToken(0, token, amount, minFunds,
 * 0, 0x0)`, the form that carries a floor (the shorter form has none). The token manager is approved to take exactly
 * the tokens sold. No referral fee is set, and the floor is enforced by the contract.
 */
export function buildFourMemeSwap(entry: DexEntry, p: FourMemeSwapParams): EvmTxPlan {
  if (entry.mechanism !== 'evm-launchpad-curve' || !entry.router) throw new SwingsError('invalid', `${entry.id} cannot build launchpad swaps.`);
  if (!isAddr(p.token)) throw new SwingsError('invalid', 'Invalid token address.');
  if (p.amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (p.minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  const manager = entry.router.toLowerCase();
  const token = p.token.toLowerCase();
  if (p.buying) {
    return { chain: entry.chain, to: manager, data: encodeCall(SIG.buy, [address(token), uint(p.amountIn), uint(p.minOut)]), value: p.amountIn, approval: null, summary: `${entry.name}: spend ${p.amountIn} wei of BNB on ${token} for at least ${p.minOut} (raw) tokens, or the whole transaction fails.` };
  }
  return {
    chain: entry.chain,
    to: manager,
    data: encodeCall(SIG.sell, [uint(0n), address(token), uint(p.amountIn), uint(p.minOut), uint(0n), address(ZERO)]),
    value: 0n,
    approval: { token, spender: manager, amount: p.amountIn },
    summary: `${entry.name}: sell ${p.amountIn} (raw) of ${token} for at least ${p.minOut} wei of BNB, or the whole transaction fails.`,
  };
}
