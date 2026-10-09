/**
 * Direct integration with Flap, a bonding-curve launchpad on BNB Chain: where a token trades from its launch until its
 * curve fills and it moves to PancakeSwap. Before this, such a token had no pool Aretia could read.
 *
 * One contract, the Portal, is both quoter and counterparty: `getTokenV8Safe` says whether a token is still on its curve
 * and what it is priced in, `quoteExactInput` prices a trade, and `swapExactInput` makes it with a floor
 * (`minOutputAmount`) that the contract enforces. The address zero stands for BNB. The contract's docs say swaps work
 * only for tokens still on the curve, so the status is checked first and a migrated token is left to PancakeSwap.
 * Checked against the live contract by simulation (see `flap.live.ts`).
 *
 * Scope, stated plainly: BNB-priced curves of the current Portal that are still trading, swaps against native BNB only.
 */
import type { EvmRead } from '../chains/evmSession.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError } from '../core/types.js';
import { address, encodeCall, words, wordToAddress, wordToBigInt } from '../engine/abi.js';
import { decodeParams, encodeFunction } from '../engine/abiGeneric.js';
import type { DexEntry } from '../engine/registry.js';
import type { EvmTxPlan } from '../execution/evmV2Builder.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const SIG = {
  state: 'getTokenV8Safe(address)',
  quote: 'quoteExactInput((address,address,uint256))',
  swap: 'swapExactInput((address,address,uint256,uint256,bytes))',
} as const;
/** `TokenStatus.Tradable`: the token is on its curve and can be bought and sold. */
const STATUS_TRADABLE = 1n;

const isAddr = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);

export interface FlapQuote {
  amountOut: bigint;
}

export class EvmFlapAdapter {
  constructor(
    readonly entry: DexEntry,
    private readonly read: EvmRead,
  ) {
    if (entry.mechanism !== 'evm-launchpad-curve' || entry.protocol !== 'flap' || !entry.router) throw new SwingsError('invalid', `${entry.id} is not a Flap entry.`);
  }

  private async call(data: string, block?: bigint): Promise<string> {
    const out = await this.read('eth_call', [{ to: this.entry.router, data }, block === undefined ? 'latest' : '0x' + block.toString(16)]);
    if (typeof out !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(out)) throw new SwingsError('invalid', 'The node returned malformed data.');
    return out;
  }

  /** True when the token is still on its curve and priced in BNB. */
  async isOpen(token: string, block?: bigint): Promise<boolean> {
    if (!isAddr(token)) return false;
    try {
      const w = words(await this.call(encodeCall(SIG.state, [address(token)]), block));
      // Word 0 is the status and word 9 the quote token (zero for BNB), in the Safe layout of the V8 state.
      return w.length >= 12 && wordToBigInt(w[0]!) === STATUS_TRADABLE && wordToAddress(w[9]!) === ZERO;
    } catch {
      return false;
    }
  }

  private async quote(input: string, output: string, amount: bigint, block?: bigint): Promise<bigint | null> {
    try {
      const [out] = decodeParams(['uint256'], await this.call(encodeFunction(SIG.quote, [[input, output, amount]]), block)) as [bigint];
      return out > 0n ? out : null;
    } catch {
      return null;
    }
  }

  async quoteBuy(token: string, bnbIn: bigint, block?: bigint): Promise<FlapQuote | null> {
    if (bnbIn <= 0n || !(await this.isOpen(token, block))) return null;
    const out = await this.quote(ZERO, token, bnbIn, block);
    return out === null ? null : { amountOut: out };
  }

  async quoteSell(token: string, amount: bigint, block?: bigint): Promise<FlapQuote | null> {
    if (amount <= 0n || !(await this.isOpen(token, block))) return null;
    const out = await this.quote(token, ZERO, amount, block);
    return out === null ? null : { amountOut: out };
  }

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

export interface FlapSwapParams {
  token: string;
  buying: boolean;
  amountIn: bigint;
  minOut: bigint;
}

/**
 * `swapExactInput` with BNB attached to buy, or the token approved to the Portal to sell. The floor is enforced by the
 * contract. No permit data is sent: the Portal is approved with an ordinary approval for exactly the amount sold.
 */
export function buildFlapSwap(entry: DexEntry, p: FlapSwapParams): EvmTxPlan {
  if (entry.mechanism !== 'evm-launchpad-curve' || entry.protocol !== 'flap' || !entry.router) throw new SwingsError('invalid', `${entry.id} cannot build Flap swaps.`);
  if (!isAddr(p.token)) throw new SwingsError('invalid', 'Invalid token address.');
  if (p.amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (p.minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  const portal = entry.router.toLowerCase();
  const token = p.token.toLowerCase();
  const params = p.buying ? [ZERO, token, p.amountIn, p.minOut, '0x'] : [token, ZERO, p.amountIn, p.minOut, '0x'];
  return {
    chain: entry.chain,
    to: portal,
    data: encodeFunction(SIG.swap, [params]),
    value: p.buying ? p.amountIn : 0n,
    approval: p.buying ? null : { token, spender: portal, amount: p.amountIn },
    summary: p.buying ? `${entry.name}: spend ${p.amountIn} wei of BNB on ${token} for at least ${p.minOut} (raw) tokens, or the whole transaction fails.` : `${entry.name}: sell ${p.amountIn} (raw) of ${token} for at least ${p.minOut} wei of BNB, or the whole transaction fails.`,
  };
}
