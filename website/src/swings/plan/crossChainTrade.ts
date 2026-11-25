/**
 * Cross-chain trading: buy a token on one network and pay with a token on another, as one guided journey of up to three steps,
 * each signed by the user's own wallet:
 *
 *   1. swap the token you pay with into USDC on its network      (left out when you pay with USDC)
 *   2. move the USDC with Circle CCTP to the other network
 *   3. swap the USDC into the token you want there                (left out when you want USDC)
 *
 * This file is the pure part: which networks take part, the checks made before anything is quoted, the fee schedule shown up
 * front, the per-journey cap, how the steps' quotes are joined into one plan, and how a swap is proven by the user's balance.
 * Nothing here signs, sends or reads a chain.
 *
 * Owner decisions (2026-11-25): the fees are exactly what each step costs when done by hand (no new rate); Solana, Ethereum, Base
 * and Polygon (the networks Circle's move covers in the app); a cap of 10,000 USDC moved per journey; off behind the build flag
 * PUBLIC_CROSSCHAIN_SWAP_ENABLED until switched on.
 */
import { ARETIA_FEE_BPS, FEE_PERCENT, MOVE_FEE_BPS, MOVE_FEE_PERCENT } from '../core/fee.js';
import { isFeeAsset } from '../core/feeAssets.js';
import { CHAINS, SwingsError, type ChainId } from '../core/types.js';
import { MOVE_CAP_RAW } from '../settlement/cctp.js';
import { formatUnits } from '../crosschain/view.js';
import { assetKeyOf, combineLegs, type ExecutionLeg, type ExecutionQuote } from './executionQuote.js';

/** The networks a journey can start or end on: the ones Circle's USDC move covers in the app. */
export const CROSS_CHAIN_TRADE_CHAINS: readonly ChainId[] = ['solana', 'ethereum', 'base', 'polygon'];

/** The most USDC one journey may move while cross-chain trading is new: the same as a single Move USDC move (10,000 USDC). */
export const JOURNEY_CAP_RAW: bigint = MOVE_CAP_RAW;

/** The build flag. Only the exact value "1" switches it on. */
export const crossChainTradeOn = (flag: unknown): boolean => flag === '1';

export interface TradeToken {
  chain: ChainId;
  address: string;
  symbol: string;
  decimals: number;
}

const same = (chain: ChainId, a: string, b: string): boolean => assetKeyOf(chain, a) === assetKeyOf(chain, b);

/** The problems that stop a journey before anything is quoted, in plain words. Empty when it may be quoted. */
export function journeyProblems(from: TradeToken & { amount: bigint }, to: TradeToken, usdc: (c: ChainId) => string | null, enabled: (c: ChainId) => boolean = () => true): string[] {
  const out: string[] = [];
  for (const [side, c] of [['pay from', from.chain], ['buy on', to.chain]] as const) {
    if (!CROSS_CHAIN_TRADE_CHAINS.includes(c)) out.push(`Cross-chain trading does not cover ${CHAINS[c].name} yet (you chose to ${side} it). It works between ${CROSS_CHAIN_TRADE_CHAINS.map((x) => CHAINS[x].name).join(', ')}.`);
    else if (!enabled(c)) out.push(`${CHAINS[c].name} is not switched on for swaps right now.`);
  }
  if (from.chain === to.chain) out.push('Both tokens are on the same network. Use the ordinary swap for that: it is one step and cheaper.');
  if (from.amount <= 0n) out.push('Enter an amount above zero.');
  const ua = usdc(from.chain);
  const ub = usdc(to.chain);
  if (!ua || !ub) out.push('USDC is not known on one of these networks, so there is no way to carry the value across.');
  else if (from.chain !== to.chain && same(from.chain, from.address, ua) && same(to.chain, to.address, ub)) out.push('Moving USDC to USDC is the Move USDC screen: it is one step.');
  return out;
}

export interface FeeScheduleLine {
  step: string;
  /** Aretia's own rate for this step, as shown ("0.58%"), or "none". */
  rate: string;
  bps: number;
  why: string;
}

/**
 * Aretia's fees for the journey, step by step, before anything is quoted: exactly what each step costs when done by hand. The first
 * swap pays 0.58% only when it is paid with a network coin or a main stablecoin (the swap rule everywhere), the move pays 0.1%, and the
 * last swap is paid with USDC so it pays 0.58%. Circle's own transfer fee, the venues' fees and network fees come on top and are shown
 * in the review with their amounts.
 */
export function journeyFeeSchedule(from: TradeToken, to: TradeToken, usdc: (c: ChainId) => string | null): { lines: FeeScheduleLine[]; maxBps: number; summary: string } {
  const lines: FeeScheduleLine[] = [];
  const ua = usdc(from.chain);
  const ub = usdc(to.chain);
  if (ua && !same(from.chain, from.address, ua)) {
    const pays = isFeeAsset(from.chain, from.address);
    lines.push({ step: `Swap ${from.symbol} for USDC on ${CHAINS[from.chain].name}`, rate: pays ? FEE_PERCENT : 'none', bps: pays ? ARETIA_FEE_BPS : 0, why: pays ? `Paid with ${from.symbol}, a coin or stablecoin, so the usual ${FEE_PERCENT} swap fee applies.` : `Selling ${from.symbol} (not a coin or stablecoin) carries no Aretia fee, the same as an ordinary swap.` });
  }
  lines.push({ step: `Move USDC from ${CHAINS[from.chain].name} to ${CHAINS[to.chain].name}`, rate: MOVE_FEE_PERCENT, bps: MOVE_FEE_BPS, why: `The usual Move USDC fee, added on top of the USDC moved. Circle's own transfer fee, if any, is shown in the review.` });
  if (ub && !same(to.chain, to.address, ub)) {
    const pays = isFeeAsset(to.chain, ub);
    lines.push({ step: `Swap USDC for ${to.symbol} on ${CHAINS[to.chain].name}`, rate: pays ? FEE_PERCENT : 'none', bps: pays ? ARETIA_FEE_BPS : 0, why: pays ? `Paid with USDC, so the usual ${FEE_PERCENT} swap fee applies.` : 'No Aretia fee on this swap.' });
  }
  const maxBps = lines.reduce((a, l) => a + l.bps, 0);
  const summary = `Aretia's fees for this trade: at most ${(maxBps / 100).toFixed(2)}% in total (${lines.map((l) => `${l.rate === 'none' ? 'no fee' : l.rate} on ${l.step.charAt(0).toLowerCase()}${l.step.slice(1)}`).join('; ')}). These are the same fees as doing each step yourself. Network fees, venue fees and Circle's transfer fee are extra and shown in the review.`;
  return { lines, maxBps, summary };
}

/** The cap check on the USDC a journey would move. An amount that cannot be estimated is refused, not assumed small. */
export function journeyCapProblem(usdcRaw: bigint | null, cap: bigint = JOURNEY_CAP_RAW): string | null {
  if (usdcRaw === null) return 'How much USDC this trade would move could not be worked out, so it is not started.';
  if (usdcRaw <= 0n) return 'This trade would move no USDC.';
  if (usdcRaw > cap) return `This trade would move about ${formatUnits(usdcRaw, 6)} USDC. While cross-chain trading is new, one trade may move at most ${formatUnits(cap, 6)} USDC. Lower the amount.`;
  return null;
}

/**
 * Joins the steps' quotes into one plan. `entered` is what the user typed: when the journey starts with the move (paying with USDC),
 * the move's input is set to exactly that, so the move later takes at most what was typed, fees included. Refuses a plan that would
 * move more than the cap, or whose steps do not connect.
 */
export function journeyQuote(id: string, parts: { first: ExecutionLeg | null; move: ExecutionLeg; last: ExecutionLeg | null }, entered: bigint, cap: bigint = JOURNEY_CAP_RAW): ExecutionQuote {
  if (parts.move.kind !== 'settlement') throw new SwingsError('invalid', 'The middle step of a cross-chain trade must be the USDC move.');
  if (parts.first && parts.first.kind !== 'swap') throw new SwingsError('invalid', 'The first step of a cross-chain trade must be a swap.');
  if (parts.last && parts.last.kind !== 'swap') throw new SwingsError('invalid', 'The last step of a cross-chain trade must be a swap.');
  const move: ExecutionLeg = parts.first ? parts.move : { ...parts.move, input: { ...parts.move.input, amount: entered } };
  const moved = move.input.amount;
  if (moved !== null && moved > cap) throw new SwingsError('invalid', journeyCapProblem(moved, cap)!);
  const legs = [parts.first, move, parts.last].filter((l): l is ExecutionLeg => l !== null);
  return combineLegs(id, legs);
}

/**
 * How much USDC the move should carry, from the first swap's worst case, such that the move's amount plus the fees added on top fit
 * inside it: amount + ceil(amount * bps / 10,000) + circleMax <= available. Null when nothing fits.
 */
export function moveAmountWithin(available: bigint, circleMaxFee: bigint = 0n): bigint | null {
  const room = available - circleMaxFee;
  if (room <= 0n) return null;
  // amount * (10,000 + bps) / 10,000 <= room, then step down until the rounded-up fee also fits.
  let amount = (room * 10_000n) / (10_000n + BigInt(MOVE_FEE_BPS));
  while (amount > 0n && amount + (amount * BigInt(MOVE_FEE_BPS) + 9_999n) / 10_000n > room) amount--;
  return amount > 0n ? amount : null;
}

/**
 * The amount the last swap takes: the USDC that landed on the destination since the move began, never more than the move said it
 * would deliver (so USDC the user already had or received from elsewhere is not swapped by mistake). Null when nothing landed yet.
 */
export function landedForSwap(baseline: bigint, now: bigint, settled: bigint | null): bigint | null {
  const landed = now - baseline;
  if (landed <= 0n) return null;
  return settled !== null && settled > 0n && settled < landed ? settled : landed;
}

/**
 * Whether a swap is proven by the user's own balance: the output rose by at least the least the signed quote promised. When the output
 * is the network's own coin, the network fee is paid from the same balance, so that fee (and 1% of the minimum, for rent and rounding)
 * is allowed for. A balance that could not be read proves nothing.
 */
export function swapProven(a: { baseline: bigint; now: bigint | null; min: bigint; outputIsNative: boolean; networkFee: bigint | null }): boolean {
  if (a.now === null) return false;
  if (a.min <= 0n) return a.now > a.baseline;
  const allowance = a.outputIsNative ? (a.networkFee ?? 0n) + a.min / 100n : 0n;
  const need = a.min - allowance;
  return a.now - a.baseline >= (need > 0n ? need : 1n);
}
