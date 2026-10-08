/**
 * ACT economics across a whole plan. The rate and the on/off switch live in `core/fee.ts` and nowhere else; this module
 * only decides WHICH step of a plan carries the allocation and how every cost is shown.
 *
 * Rules (tests enforce them):
 *  - there is no second, generic Aretia fee: the only Aretia charge is the ACT allocation, and it is never added on top
 *    of itself: a plan carries it on at most ONE step, so a multi-step plan does not pay it twice on the same money;
 *  - ramps and settlements carry no Aretia charge; their providers' fees are shown as the providers' own;
 *  - every cost is disclosed on its own line: the amount, the network fee, the venue fee, the settlement fee, the ramp
 *    fee and the ACT allocation, each in its own asset;
 *  - an automatic (unattended) buyback never runs unless production configuration explicitly allows it. Today the
 *    allocation is part of a transaction the user signs; nothing runs unattended.
 */
import { LIVE_FEE_CONFIG, planBuyback } from '../core/fee.js';
import { CHAINS, type AretiaFeeConfig, type ChainId } from '../core/types.js';
import { formatUnits } from '../crosschain/view.js';
import type { ExecutionLeg, ExecutionQuote, FeeKind } from '../plan/executionQuote.js';

/** The rate the product runs, read from the one place it is set. */
export const configuredRateBps = (config: AretiaFeeConfig = LIVE_FEE_CONFIG): number => config.policy.rateBps;

export interface Allocation {
  /** Index of the leg that carries the ACT allocation, or null if none does. */
  legIndex: number | null;
  chain: ChainId | null;
  /** Raw units of the leg's input asset set aside to buy ACT. */
  amount: bigint;
  /** Why no leg carries it, when none does. */
  reason: string | null;
}

/**
 * Picks the one leg that carries the allocation: the first swap whose network has the buyback switched on and ready.
 * Everything else carries none, so the same money is never charged twice.
 */
export function selectAllocation(legs: readonly ExecutionLeg[], chains: readonly (ChainId | null)[], config: AretiaFeeConfig = LIVE_FEE_CONFIG): Allocation {
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    const chain = chains[i] ?? null;
    if (leg.kind !== 'swap' || !chain || leg.input.amount === null) continue;
    const plan = planBuyback(leg.input.amount, chain, config);
    if (plan.state === 'blocked') return { legIndex: null, chain, amount: 0n, reason: `The ACT allocation is blocked: ${plan.reasons.join(' ')}` };
    if (plan.state === 'ready') return { legIndex: i, chain, amount: plan.amount, reason: null };
  }
  return { legIndex: null, chain: null, amount: 0n, reason: config.policy.enabled ? 'No step in this plan is a swap on a network where the ACT allocation applies.' : 'The ACT allocation is switched off.' };
}

export interface DisclosureLine {
  kind: FeeKind | 'amount';
  label: string;
  value: string;
}

const ORDER: FeeKind[] = ['network', 'dex', 'settlement', 'ramp', 'aretia-buyback'];
const TITLE: Record<FeeKind, string> = { network: 'Network fees', dex: 'Venue fees', settlement: 'Transfer fees', ramp: 'Provider fees (buy or sell)', 'aretia-buyback': 'ACT allocation' };

/** Every cost on its own line, in its own asset. Nothing is merged and no generic "fee" is invented. */
export function disclose(q: ExecutionQuote): DisclosureLine[] {
  const out: DisclosureLine[] = [];
  const unit = (amount: bigint | null, decimals: number, symbol: string): string => (amount === null ? 'not known: shown by the provider' : `${formatUnits(amount, decimals)} ${symbol}`);
  out.push({ kind: 'amount', label: 'You spend', value: unit(q.spend.amount, q.spend.decimals, q.spend.symbol) });
  out.push({ kind: 'amount', label: q.legs.some((l) => l.output.amount === null) ? 'You receive' : 'You receive at least', value: q.receive.amount === null ? 'not known until the provider shows its price' : unit(q.receive.amount, q.receive.decimals, q.receive.symbol) });
  for (const kind of ORDER) {
    for (const leg of q.legs) {
      for (const f of leg.fees.filter((x) => x.kind === kind)) out.push({ kind, label: `${TITLE[kind]}: ${f.label}`, value: unit(f.amount, f.decimals, f.symbol) });
    }
  }
  return out;
}

/**
 * Guard for any future unattended buyback. It refuses unless production configuration explicitly allows it. Nothing
 * calls this yet: the allocation today rides inside the user's own signed swap.
 */
export function assertAutomaticBuybackAllowed(env: { SWINGS_AUTOMATIC_BUYBACK?: string; SWINGS_BUYBACK_EXECUTOR?: string }): void {
  if (env.SWINGS_AUTOMATIC_BUYBACK !== 'on') throw new Error('Automatic buybacks are off. They need SWINGS_AUTOMATIC_BUYBACK=on in production configuration.');
  if (!env.SWINGS_BUYBACK_EXECUTOR?.trim()) throw new Error('Automatic buybacks need an executor address in production configuration.');
}

export const chainNames = (chains: readonly ChainId[]): string => chains.map((c) => CHAINS[c].name).join(', ');
