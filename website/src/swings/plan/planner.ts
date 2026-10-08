/**
 * The planner: given where the user's money is and where they want it, it finds the ordered steps that get there, using
 * only what is really possible right now (a ramp that lists the token, a settlement route that exists, a pool that can
 * be swapped). USDC is the bridge asset: it is the one thing both ramps and settlement handle.
 *
 * It plans; it does not quote or execute. Each step is later quoted by its own engine, and the quotes are joined into
 * one ExecutionQuote (`executionQuote.ts`) that refuses steps which do not connect.
 *
 * It returns every plan it can find, fewest steps first, and the reasons when it finds none. It never invents a step
 * to make a plan work: a step exists only if the capabilities say so.
 */
import type { ChainId } from '../core/types.js';
import type { LegKind } from './executionQuote.js';

export interface TokenSpot {
  chain: ChainId;
  address: string;
  symbol: string;
  decimals: number;
}

export type PlanSource = { kind: 'fiat'; fiat: string; amount: number } | ({ kind: 'token'; amount: bigint } & TokenSpot);
export type PlanTarget = { kind: 'fiat'; fiat: string } | ({ kind: 'token' } & TokenSpot);

export interface PlanGoal {
  from: PlanSource;
  to: PlanTarget;
  /** Needed for ramps; null makes any ramp step impossible (fail closed). */
  country: string | null;
}

export interface Capabilities {
  /** Chains where a ramp lists USDC for this side, currency and country. */
  rampChains(side: 'buy' | 'sell', fiat: string, country: string | null): Promise<ChainId[]>;
  canSettle(from: ChainId, to: ChainId): Promise<boolean>;
  canSwap(chain: ChainId, from: string, to: string): Promise<boolean>;
  usdc(chain: ChainId): string | null;
}

export interface PlanStepSpec {
  kind: LegKind;
  /** Where this step happens (for a settlement, the source chain). */
  chain: ChainId;
  /** For a settlement, the destination chain. */
  toChain?: ChainId;
  /** Token addresses: what goes in and what comes out (lower-case). Fiat is described by `fiat`. */
  inAddress: string | null;
  outAddress: string | null;
  fiat?: string;
}

export interface PlanCandidate {
  steps: PlanStepSpec[];
}

export interface PlanResult {
  plans: PlanCandidate[];
  /** Why nothing was found, in plain words, when `plans` is empty. */
  reasons: string[];
}

const lc = (a: string): string => a.toLowerCase();

export async function planRoutes(goal: PlanGoal, cap: Capabilities): Promise<PlanResult> {
  const plans: PlanCandidate[] = [];
  const reasons: string[] = [];

  /** Steps that turn USDC on `at` into the target token on `dest` (settle, then swap), or null with a reason. */
  const fromUsdc = async (at: ChainId, dest: TokenSpot): Promise<PlanStepSpec[] | null> => {
    const usdcAt = cap.usdc(at);
    const usdcDest = cap.usdc(dest.chain);
    if (!usdcAt) return (reasons.push(`USDC is not known on this network.`), null);
    const steps: PlanStepSpec[] = [];
    if (at !== dest.chain) {
      if (!usdcDest) return (reasons.push('USDC is not known on the destination network.'), null);
      if (!(await cap.canSettle(at, dest.chain))) return (reasons.push(`No settlement route exists between these two networks for USDC.`), null);
      steps.push({ kind: 'settlement', chain: at, toChain: dest.chain, inAddress: lc(usdcAt), outAddress: lc(usdcDest) });
    }
    if (usdcDest && lc(dest.address) !== lc(usdcDest)) {
      if (!(await cap.canSwap(dest.chain, usdcDest, dest.address))) return (reasons.push('No swap route exists from USDC to that token on its network.'), null);
      steps.push({ kind: 'swap', chain: dest.chain, inAddress: lc(usdcDest), outAddress: lc(dest.address) });
    }
    return steps;
  };

  /** Steps that turn `src` into USDC on `at` (swap, then settle). */
  const toUsdc = async (src: TokenSpot, at: ChainId): Promise<PlanStepSpec[] | null> => {
    const usdcSrc = cap.usdc(src.chain);
    const usdcAt = cap.usdc(at);
    if (!usdcSrc || !usdcAt) return (reasons.push('USDC is not known on one of the networks.'), null);
    const steps: PlanStepSpec[] = [];
    if (lc(src.address) !== lc(usdcSrc)) {
      if (!(await cap.canSwap(src.chain, src.address, usdcSrc))) return (reasons.push('No swap route exists from that token to USDC on its network.'), null);
      steps.push({ kind: 'swap', chain: src.chain, inAddress: lc(src.address), outAddress: lc(usdcSrc) });
    }
    if (src.chain !== at) {
      if (!(await cap.canSettle(src.chain, at))) return (reasons.push('No settlement route exists between these two networks for USDC.'), null);
      steps.push({ kind: 'settlement', chain: src.chain, toChain: at, inAddress: lc(usdcSrc), outAddress: lc(usdcAt) });
    }
    return steps;
  };

  if (goal.from.kind === 'fiat' && goal.to.kind === 'token') {
    const buyChains = await cap.rampChains('buy', goal.from.fiat, goal.country);
    if (!goal.country) reasons.push('Your country is needed to know what a provider can offer.');
    else if (buyChains.length === 0) reasons.push('No provider offers USDC for that currency in your country right now.');
    for (const x of buyChains) {
      const usdc = cap.usdc(x);
      if (!usdc) continue;
      const rest = await fromUsdc(x, goal.to);
      if (rest) plans.push({ steps: [{ kind: 'ramp-buy', chain: x, inAddress: null, outAddress: lc(usdc), fiat: goal.from.fiat }, ...rest] });
    }
  } else if (goal.from.kind === 'token' && goal.to.kind === 'fiat') {
    const sellChains = await cap.rampChains('sell', goal.to.fiat, goal.country);
    if (!goal.country) reasons.push('Your country is needed to know what a provider can offer.');
    else if (sellChains.length === 0) reasons.push('No provider buys USDC for that currency in your country right now.');
    for (const x of sellChains) {
      const usdc = cap.usdc(x);
      if (!usdc) continue;
      const first = await toUsdc(goal.from, x);
      if (first) plans.push({ steps: [...first, { kind: 'ramp-sell', chain: x, inAddress: lc(usdc), outAddress: null, fiat: (goal.to as { fiat: string }).fiat }] });
    }
  } else if (goal.from.kind === 'token' && goal.to.kind === 'token') {
    const dest: TokenSpot = goal.to;
    const src = goal.from;
    if (src.chain === dest.chain) {
      if (await cap.canSwap(src.chain, src.address, dest.address)) plans.push({ steps: [{ kind: 'swap', chain: src.chain, inAddress: lc(src.address), outAddress: lc(dest.address) }] });
      else reasons.push('No swap route exists between those tokens.');
    } else {
      const usdcDest = cap.usdc(dest.chain);
      const usdcSrc = cap.usdc(src.chain);
      if (!usdcSrc || !usdcDest) reasons.push('USDC is not known on one of the networks, so there is no way to bridge between them.');
      else {
        const first = await toUsdc(src, src.chain);
        const rest = first ? await fromUsdc(src.chain, dest) : null;
        if (first && rest) plans.push({ steps: [...first, ...rest] });
      }
    }
  } else reasons.push('Buying and selling in one step (money to money) is not something Aretia does.');

  plans.sort((a, b) => a.steps.length - b.steps.length || a.steps.map((s) => s.chain).join() .localeCompare(b.steps.map((s) => s.chain).join()));
  return { plans, reasons: plans.length > 0 ? [] : [...new Set(reasons)] };
}
