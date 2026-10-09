/**
 * Direct integration with Arena's token launcher on Avalanche, where a token trades from its launch until its curve fills
 * and it moves to Arena's own pool. Before this, such a token had no pool Aretia could read.
 *
 * What the contract does, from its verified source and checked against the live deployment:
 *  - tokens are known to the launcher by a numeric id, not by their address, so the token's id is found by reading the
 *    launcher's own records (`tokenParams`), newest first, in batches through Multicall3, and remembered;
 *  - curves are priced in the ARENA token, not in AVAX, so this venue swaps ARENA for a token and back;
 *  - amounts must be whole tokens. The price functions count them in whole tokens, while a buy or a sell must be given the
 *    same amount in raw units, a multiple of the contract's `GRANULARITY_SCALER` (10^18). A buy names how many tokens to
 *    buy and the most ARENA to spend on them; a sell names how many tokens to sell and the least ARENA to receive. The
 *    contract enforces both limits.
 * Because a buy is "this many tokens for at most this much", the quote finds the most whole tokens the user's ARENA pays
 * for, using the launcher's own cost function (`calculateCostWithFees`), narrowed in a few batched rounds.
 *
 * Scope, stated plainly: curves still open (no liquidity pool deployed), ARENA against the token only, whole tokens only
 * (a sell of less than one token, or the fraction of a token beyond a whole number, is not part of the swap).
 */
import type { EvmRead } from '../chains/evmSession.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError } from '../core/types.js';
import { encodeCall, uint, words, wordToAddress, wordToBigInt } from '../engine/abi.js';
import { decodeParams, encodeFunction } from '../engine/abiGeneric.js';
import type { DexEntry } from '../engine/registry.js';
import type { EvmTxPlan } from '../execution/evmV2Builder.js';

/** Multicall3 is deployed at this address on every chain Aretia supports. */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const UNIT = 10n ** 18n;
const SIG = {
  next: 'tokenIdentifier()',
  first: 'INITIAL_TOKEN_ID()',
  params: 'tokenParams(uint256)',
  max: 'getMaxTokensForSale(uint256)',
  cost: 'calculateCostWithFees(uint256,uint256)',
  reward: 'calculateRewardWithFees(uint256,uint256)',
  buy: 'buyAndCreateLpIfPossible(uint256,uint256,uint256)',
  sell: 'sell(uint256,uint256,uint256)',
} as const;
const SCAN_BATCH = 400;
const SCAN_LIMIT = 20_000;
const POINTS = 64;
const ROUNDS = 3;

const isAddr = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);

export class EvmArenaAdapter {
  private readonly ids = new Map<string, bigint>();
  /** Ids below this have already been read. */
  private scannedDownTo: bigint | null = null;
  private scannedFrom: bigint | null = null;

  constructor(
    readonly entry: DexEntry,
    private readonly read: EvmRead,
  ) {
    if (entry.mechanism !== 'evm-launchpad-curve' || entry.protocol !== 'arena' || !entry.router || !entry.quoteAsset) throw new SwingsError('invalid', `${entry.id} is not an Arena entry.`);
  }

  private async call(to: string, data: string, block?: bigint): Promise<string> {
    const out = await this.read('eth_call', [{ to, data }, block === undefined ? 'latest' : '0x' + block.toString(16)]);
    if (typeof out !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(out)) throw new SwingsError('invalid', 'The node returned malformed data.');
    return out;
  }

  /** Several calls to the launcher in one request. A call that reverts comes back null. */
  private async many(calls: string[], block?: bigint): Promise<(string | null)[]> {
    if (calls.length === 0) return [];
    const data = encodeFunction('aggregate3((address,bool,bytes)[])', [calls.map((c) => [this.entry.router, true, c])]);
    const [res] = decodeParams(['(bool,bytes)[]'], await this.call(MULTICALL3, data, block)) as [[boolean, string][]];
    return res.map(([ok, ret]) => (ok ? ret : null));
  }

  /** The launcher's id for a token, found by reading its records newest first. Null when it is not one of the launcher's tokens. */
  async idOf(token: string, block?: bigint): Promise<bigint | null> {
    const key = token.toLowerCase();
    const known = this.ids.get(key);
    if (known !== undefined) return known;
    const [nextWord] = words(await this.call(this.entry.router!, encodeCall(SIG.next, []), block));
    const [firstWord] = words(await this.call(this.entry.router!, encodeCall(SIG.first, []), block));
    if (nextWord === undefined || firstWord === undefined) return null;
    const next = wordToBigInt(nextWord);
    const first = wordToBigInt(firstWord);
    // Records are read from the newest down. Ids made since an earlier call are read first, then older ones, resuming
    // below where the last call stopped; a read that finds the token stops there and remembers how far it got.
    const batches: { top: bigint; floor: bigint; fresh: boolean }[] = [];
    if (this.scannedFrom !== null && next > this.scannedFrom) batches.push({ top: next, floor: this.scannedFrom, fresh: true });
    const start = this.scannedDownTo ?? next;
    const floor = first > start - BigInt(SCAN_LIMIT) ? first : start - BigInt(SCAN_LIMIT);
    if (start > floor) batches.push({ top: start, floor, fresh: false });
    for (const range of batches) {
      for (let top = range.top; top > range.floor; top -= BigInt(SCAN_BATCH)) {
        const bottom = top - BigInt(SCAN_BATCH) > range.floor ? top - BigInt(SCAN_BATCH) : range.floor;
        const ids: bigint[] = [];
        for (let id = top - 1n; id >= bottom; id--) ids.push(id);
        const rets = await this.many(ids.map((id) => encodeCall(SIG.params, [uint(id)])), block);
        rets.forEach((ret, i) => {
          const w = ret === null ? [] : words(ret);
          if (w.length >= 10) this.ids.set(wordToAddress(w[9]!), ids[i]!);
        });
        if (!range.fresh) this.scannedDownTo = bottom;
        if (this.ids.has(key)) break;
      }
      if (this.ids.has(key)) break;
    }
    this.scannedFrom = next;
    return this.ids.get(key) ?? null;
  }

  /** The id of a token whose curve is open (no pool deployed yet), or null. */
  private async openId(token: string, block?: bigint): Promise<bigint | null> {
    if (!isAddr(token)) return null;
    try {
      const id = await this.idOf(token, block);
      if (id === null) return null;
      const w = words(await this.call(this.entry.router!, encodeCall(SIG.params, [uint(id)]), block));
      // Word 3 is `lpDeployed`; word 9 is the token's own address, which must match.
      return w.length >= 10 && wordToBigInt(w[3]!) === 0n && wordToAddress(w[9]!) === token.toLowerCase() ? id : null;
    } catch {
      return null;
    }
  }

  /** The launcher's cost in ARENA of each whole-token amount; null where the contract refuses (beyond what is for sale). */
  private async costs(id: bigint, amounts: bigint[], block?: bigint): Promise<(bigint | null)[]> {
    const rets = await this.many(amounts.map((a) => encodeCall(SIG.cost, [uint(a), uint(id)])), block);
    return rets.map((r) => (r === null ? null : wordToBigInt(words(r)[0] ?? '0')));
  }

  /** The most whole tokens `arenaIn` pays for (the price functions count whole tokens), and their id. */
  async quoteBuy(token: string, arenaIn: bigint, block?: bigint): Promise<{ amountOut: bigint; ref: string } | null> {
    if (arenaIn <= 0n) return null;
    const id = await this.openId(token, block);
    if (id === null) return null;
    try {
      const [maxWord] = words(await this.call(this.entry.router!, encodeCall(SIG.max, [uint(id)]), block));
      let hi = maxWord === undefined ? 0n : wordToBigInt(maxWord) / UNIT;
      if (hi < 1n) return null;
      let lo = 0n;
      for (let round = 0; round < ROUNDS && hi > lo + 1n; round++) {
        const span = Number(hi - lo);
        // The first round spreads its points geometrically (the range can span ten orders of magnitude); the others evenly.
        const amounts = [...new Set(Array.from({ length: POINTS }, (_, k) => lo + BigInt(Math.max(1, k === POINTS - 1 ? span : round === 0 ? Math.floor(Math.exp((Math.log(span) * (k + 1)) / POINTS)) : Math.floor((span * (k + 1)) / POINTS)))))].filter((a) => a > lo && a <= hi).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const cost = await this.costs(id, amounts, block);
        let best = lo;
        let over = hi;
        for (let i = 0; i < amounts.length; i++) {
          if (cost[i] !== null && cost[i]! <= arenaIn) best = amounts[i]!;
          else {
            over = amounts[i]!;
            break;
          }
        }
        lo = best;
        hi = over > lo ? over : lo + 1n;
        if (best === hi) break;
      }
      return lo >= 1n ? { amountOut: lo * UNIT, ref: id.toString() } : null;
    } catch {
      return null;
    }
  }

  /** ARENA that selling the whole tokens within `amount` pays, after fees. */
  async quoteSell(token: string, amount: bigint, block?: bigint): Promise<{ amountOut: bigint; ref: string } | null> {
    const whole = amount / UNIT;
    if (whole < 1n) return null;
    const id = await this.openId(token, block);
    if (id === null) return null;
    try {
      const [w] = words(await this.call(this.entry.router!, encodeCall(SIG.reward, [uint(whole), uint(id)]), block));
      const out = w === undefined ? 0n : wordToBigInt(w);
      return out > 0n ? { amountOut: out, ref: id.toString() } : null;
    } catch {
      return null;
    }
  }

  async bestRoute(tokenIn: string, tokenOut: string, amountIn: bigint, block?: bigint): Promise<{ token: string; buying: boolean; amountOut: bigint; ref: string } | null> {
    const asset = this.entry.quoteAsset!.toLowerCase();
    const a = normalizeTokenRef(this.entry.chain, tokenIn);
    const b = normalizeTokenRef(this.entry.chain, tokenOut);
    if (!a || !b || a.address === b.address) throw new SwingsError('invalid', 'Invalid token pair for this network.');
    if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
    if (a.address === asset) {
      const q = await this.quoteBuy(b.address, amountIn, block);
      return q ? { token: b.address, buying: true, ...q } : null;
    }
    if (b.address === asset) {
      const q = await this.quoteSell(a.address, amountIn, block);
      return q ? { token: a.address, buying: false, ...q } : null;
    }
    return null;
  }
}

export interface ArenaSwapParams {
  token: string;
  buying: boolean;
  amountIn: bigint;
  minOut: bigint;
  /** The launcher's id for the token, from the quote. */
  ref: string;
}

/**
 * Buying: `buyAndCreateLpIfPossible(wholeTokens, id, maxArenaToSpend)`, where the whole tokens are the least the user
 * accepts (the minimum output, rounded down) and the most ARENA is the amount the user chose. Selling:
 * `sell(wholeTokens, id, minArenaToReceive)`. The launcher is approved to take exactly the asset that is sold.
 */
export function buildArenaSwap(entry: DexEntry, p: ArenaSwapParams): EvmTxPlan {
  if (entry.mechanism !== 'evm-launchpad-curve' || entry.protocol !== 'arena' || !entry.router || !entry.quoteAsset) throw new SwingsError('invalid', `${entry.id} cannot build Arena swaps.`);
  if (!isAddr(p.token)) throw new SwingsError('invalid', 'Invalid token address.');
  if (!/^[0-9]{1,30}$/.test(p.ref)) throw new SwingsError('invalid', 'The token has no launcher id.');
  if (p.amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (p.minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  const id = BigInt(p.ref);
  const launcher = entry.router.toLowerCase();
  const token = p.token.toLowerCase();
  if (p.buying) {
    const whole = p.minOut / UNIT;
    if (whole < 1n) throw new SwingsError('invalid', 'This swap buys less than one whole token, which the launcher cannot sell.');
    return {
      chain: entry.chain,
      to: launcher,
      data: encodeFunction(SIG.buy, [whole * UNIT, id, p.amountIn]),
      value: 0n,
      approval: { token: entry.quoteAsset.toLowerCase(), spender: launcher, amount: p.amountIn },
      summary: `${entry.name}: buy ${whole} whole tokens of ${token} for at most ${p.amountIn} (raw) ARENA, or the whole transaction fails.`,
    };
  }
  const whole = p.amountIn / UNIT;
  if (whole < 1n) throw new SwingsError('invalid', 'This swap sells less than one whole token, which the launcher cannot buy.');
  return {
    chain: entry.chain,
    to: launcher,
    data: encodeFunction(SIG.sell, [whole * UNIT, id, p.minOut]),
    value: 0n,
    approval: { token, spender: launcher, amount: whole * UNIT },
    summary: `${entry.name}: sell ${whole} whole tokens of ${token} for at least ${p.minOut} (raw) ARENA, or the whole transaction fails.`,
  };
}
