/**
 * Direct integration with the Virtuals launchpad on Base (Bonding V5), where AI-agent tokens trade from launch until their
 * curve fills and they move to Uniswap. Before this, such a token had no pool Aretia could read.
 *
 * Virtuals curves are priced in the VIRTUAL token, not in ETH, so this venue swaps VIRTUAL for an agent token and back.
 * Getting VIRTUAL from ETH is an ordinary swap that Aretia's other venues already make; it is a separate step.
 *
 * What the contracts say, from Virtuals' published source and checked against the live deployment:
 *  - the Bonding contract takes the user's call (`buy`, `sell`) and enforces the minimum output and a deadline;
 *  - the router that moves the money is the one that must be approved, and its tax is `buyTax` or `sellTax` percent of the
 *    trade, plus an extra anti-sniper tax for a while after a launch (up to 99%);
 *  - the output is read from the router's `getAmountsOut` on the amount left after tax.
 * Because the anti-sniper tax is time-dependent and not exposed, a token whose pair currently has that tax is not offered
 * at all, instead of quoting an amount the contract would not pay.
 *
 * Scope, stated plainly: tokens still on their curve (trading, launched, not yet on Uniswap), VIRTUAL against the token only.
 */
import type { EvmRead } from '../chains/evmSession.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError } from '../core/types.js';
import { address, encodeCall, uint, words, wordToAddress, wordToBigInt } from '../engine/abi.js';
import type { DexEntry } from '../engine/registry.js';
import type { EvmTxPlan } from '../execution/evmV2Builder.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const SIG = {
  info: 'tokenInfo(address)',
  pair: 'getPair(address,address)',
  antiSniper: 'hasAntiSniperTax(address)',
  buyTax: 'buyTax()',
  sellTax: 'sellTax()',
  out: 'getAmountsOut(address,address,uint256)',
  buy: 'buy(uint256,address,uint256,uint256)',
  sell: 'sell(uint256,address,uint256,uint256)',
} as const;
/** Word positions in `tokenInfo`'s answer: the flags sit after four addresses and six offsets of dynamic members. */
const W = { trading: 11, tradingOnUniswap: 12, launchExecuted: 16 } as const;

const isAddr = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);

export class EvmVirtualsAdapter {
  constructor(
    readonly entry: DexEntry,
    private readonly read: EvmRead,
  ) {
    if (entry.mechanism !== 'evm-launchpad-curve' || entry.protocol !== 'virtuals' || !entry.router || !entry.quoter || !entry.factory || !entry.quoteAsset) throw new SwingsError('invalid', `${entry.id} is not a Virtuals entry.`);
  }

  private async call(to: string, data: string, block?: bigint): Promise<string[]> {
    const out = await this.read('eth_call', [{ to, data }, block === undefined ? 'latest' : '0x' + block.toString(16)]);
    if (typeof out !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(out)) throw new SwingsError('invalid', 'The node returned malformed data.');
    return words(out);
  }

  /** The curve's pair for a token, when the token is open for trading on its curve and no anti-sniper tax applies. */
  private async openPair(token: string, block?: bigint): Promise<string | null> {
    if (!isAddr(token)) return null;
    try {
      const info = await this.call(this.entry.router!, encodeCall(SIG.info, [address(token)]), block);
      if (info.length <= W.launchExecuted) return null;
      if (wordToBigInt(info[W.trading]!) !== 1n || wordToBigInt(info[W.launchExecuted]!) !== 1n || wordToBigInt(info[W.tradingOnUniswap]!) !== 0n) return null;
      const [pairWord] = await this.call(this.entry.factory!, encodeCall(SIG.pair, [address(token), address(this.entry.quoteAsset!)]), block);
      const pair = wordToAddress(pairWord ?? '');
      if (pair === ZERO) return null;
      const [sniper] = await this.call(this.entry.quoter!, encodeCall(SIG.antiSniper, [address(pair)]), block);
      return sniper !== undefined && wordToBigInt(sniper) === 0n ? pair : null;
    } catch {
      return null;
    }
  }

  private async tax(sig: string, block?: bigint): Promise<bigint | null> {
    const [w] = await this.call(this.entry.factory!, encodeCall(sig, []), block);
    const t = w === undefined ? null : wordToBigInt(w);
    return t !== null && t < 99n ? t : null;
  }

  /** Agent tokens `virtualIn` buys, after the router's tax. */
  async quoteBuy(token: string, virtualIn: bigint, block?: bigint): Promise<{ amountOut: bigint } | null> {
    if (virtualIn <= 0n || (await this.openPair(token, block)) === null) return null;
    try {
      const tax = await this.tax(SIG.buyTax, block);
      if (tax === null) return null;
      const net = virtualIn - (virtualIn * tax) / 100n;
      const [w] = await this.call(this.entry.quoter!, encodeCall(SIG.out, [address(token), address(this.entry.quoteAsset!), uint(net)]), block);
      const out = w === undefined ? 0n : wordToBigInt(w);
      return out > 0n ? { amountOut: out } : null;
    } catch {
      return null;
    }
  }

  /** VIRTUAL that selling `amount` agent tokens pays, after the router's tax. */
  async quoteSell(token: string, amount: bigint, block?: bigint): Promise<{ amountOut: bigint } | null> {
    if (amount <= 0n || (await this.openPair(token, block)) === null) return null;
    try {
      const tax = await this.tax(SIG.sellTax, block);
      if (tax === null) return null;
      const [w] = await this.call(this.entry.quoter!, encodeCall(SIG.out, [address(token), address(ZERO), uint(amount)]), block);
      const gross = w === undefined ? 0n : wordToBigInt(w);
      const net = gross - (gross * tax) / 100n;
      return net > 0n ? { amountOut: net } : null;
    } catch {
      return null;
    }
  }

  async bestRoute(tokenIn: string, tokenOut: string, amountIn: bigint, block?: bigint): Promise<{ token: string; buying: boolean; amountOut: bigint } | null> {
    const asset = this.entry.quoteAsset!.toLowerCase();
    const a = normalizeTokenRef(this.entry.chain, tokenIn);
    const b = normalizeTokenRef(this.entry.chain, tokenOut);
    if (!a || !b || a.address === b.address) throw new SwingsError('invalid', 'Invalid token pair for this network.');
    if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
    if (a.address === asset) {
      const q = await this.quoteBuy(b.address, amountIn, block);
      return q ? { token: b.address, buying: true, amountOut: q.amountOut } : null;
    }
    if (b.address === asset) {
      const q = await this.quoteSell(a.address, amountIn, block);
      return q ? { token: a.address, buying: false, amountOut: q.amountOut } : null;
    }
    return null;
  }
}

export interface VirtualsSwapParams {
  token: string;
  buying: boolean;
  amountIn: bigint;
  minOut: bigint;
  /** Unix seconds after which the contract refuses the swap. */
  deadline: number;
}

/**
 * `buy(amountIn, token, minOut, deadline)` or `sell(...)` on the Bonding contract. The money is moved by the router, so
 * that is what the sold asset (VIRTUAL when buying, the agent token when selling) is approved to, for exactly the amount.
 */
export function buildVirtualsSwap(entry: DexEntry, p: VirtualsSwapParams): EvmTxPlan {
  if (entry.mechanism !== 'evm-launchpad-curve' || entry.protocol !== 'virtuals' || !entry.router || !entry.quoter || !entry.quoteAsset) throw new SwingsError('invalid', `${entry.id} cannot build Virtuals swaps.`);
  if (!isAddr(p.token)) throw new SwingsError('invalid', 'Invalid token address.');
  if (p.amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (p.minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  if (!Number.isInteger(p.deadline) || p.deadline <= 0) throw new SwingsError('invalid', 'A swap needs a deadline.');
  const token = p.token.toLowerCase();
  const sold = p.buying ? entry.quoteAsset.toLowerCase() : token;
  return {
    chain: entry.chain,
    to: entry.router.toLowerCase(),
    data: encodeCall(p.buying ? SIG.buy : SIG.sell, [uint(p.amountIn), address(token), uint(p.minOut), uint(BigInt(p.deadline))]),
    value: 0n,
    approval: { token: sold, spender: entry.quoter.toLowerCase(), amount: p.amountIn },
    summary: p.buying ? `${entry.name}: spend ${p.amountIn} (raw) VIRTUAL on ${token} for at least ${p.minOut} (raw) tokens, or the whole transaction fails.` : `${entry.name}: sell ${p.amountIn} (raw) of ${token} for at least ${p.minOut} (raw) VIRTUAL, or the whole transaction fails.`,
  };
}
