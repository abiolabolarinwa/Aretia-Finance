/**
 * The Aretia fee across a whole plan, and how every cost is shown. The rate and the on/off switch live in `core/fee.ts` and
 * nowhere else; this module only decides WHICH step of a plan carries the fee and how the costs are disclosed.
 *
 * Rules (tests enforce them):
 *  - there is exactly one Aretia charge, the 0.58% fee, paid in the asset the user is paying with (a coin or a stablecoin). It is never added on top of
 *    itself: a plan carries it on at most ONE step, so a multi-step plan does not pay it twice on the same money;
 *  - ramps and settlements carry no Aretia charge; their providers' fees are shown as the providers' own;
 *  - every cost is disclosed on its own line: the amount, the network fee, the venue fee, the settlement fee, the ramp
 *    fee and the Aretia fee, each in its own asset.
 */
import { LIVE_FEE_CONFIG, planAretiaFee } from '../core/fee.js';
import { CHAINS, type AretiaFeeConfig, type ChainId } from '../core/types.js';
import { formatUnits } from '../crosschain/view.js';
import type { ExecutionLeg, ExecutionQuote, FeeKind } from '../plan/executionQuote.js';

/** The rate the product runs, read from the one place it is set. */
export const configuredRateBps = (config: AretiaFeeConfig = LIVE_FEE_CONFIG): number => config.policy.rateBps;

export interface FeeAllocation {
  /** Index of the leg that carries the Aretia fee, or null if none does. */
  legIndex: number | null;
  chain: ChainId | null;
  /** Raw units of the leg's input asset taken as the fee. */
  amount: bigint;
  /** Why no leg carries it, when none does. */
  reason: string | null;
}

/**
 * Picks the one leg that carries the fee: the first swap on a network where the fee is on and ready. Everything else carries
 * none, so the same money is never charged twice.
 */
export function selectFee(legs: readonly ExecutionLeg[], chains: readonly (ChainId | null)[], config: AretiaFeeConfig = LIVE_FEE_CONFIG): FeeAllocation {
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    const chain = chains[i] ?? null;
    if (leg.kind !== 'swap' || !chain || leg.input.amount === null) continue;
    const plan = planAretiaFee(leg.input.amount, chain, config, leg.input.assetKey);
    if (plan.state === 'blocked') return { legIndex: null, chain, amount: 0n, reason: `The Aretia fee is blocked: ${plan.reasons.join(' ')}` };
    if (plan.state === 'ready') return { legIndex: i, chain, amount: plan.fee, reason: null };
  }
  return { legIndex: null, chain: null, amount: 0n, reason: config.policy.enabled ? 'No step in this plan is a swap on a network where the Aretia fee applies.' : 'The Aretia fee is switched off.' };
}

export interface DisclosureLine {
  kind: FeeKind | 'amount';
  label: string;
  value: string;
}

const ORDER: FeeKind[] = ['network', 'dex', 'settlement', 'ramp', 'aretia-fee'];
const TITLE: Record<FeeKind, string> = { network: 'Network fees', dex: 'Venue fees', settlement: 'Transfer fees', ramp: 'Provider fees (buy or sell)', 'aretia-fee': 'Aretia fee' };

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

export const chainNames = (chains: readonly ChainId[]): string => chains.map((c) => CHAINS[c].name).join(', ');
