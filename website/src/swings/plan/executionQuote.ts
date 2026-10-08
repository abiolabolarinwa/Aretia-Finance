/**
 * The unified ExecutionQuote: one honest description of everything a plan will do, made from the quotes of its parts
 * (a ramp, a settlement, a swap) without hiding any of them.
 *
 * What it guarantees (tests enforce each):
 *  - legs connect: what one leg delivers is what the next leg takes, on the same chain and asset, and no leg takes more
 *    than the one before delivers; if they do not connect, no quote is made (fail closed);
 *  - fees are kept apart, per asset, and never added across assets into one number nobody can check;
 *  - an unknown amount stays unknown: if any leg has no price, the final amount is null and says why, never a guess;
 *  - the expiry is the earliest of the legs, the risk is the worst of the legs.
 */
import { CHAINS, SwingsError, type ChainId, type Quote } from '../core/types.js';
import type { RampQuote } from '../ramp/types.js';
import type { SettlementQuote } from '../settlement/types.js';

export type LegKind = 'ramp-buy' | 'settlement' | 'swap' | 'ramp-sell';
export type FeeKind = 'ramp' | 'settlement' | 'network' | 'dex' | 'aretia-buyback';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface AmountLine {
  /** `null` for money in a bank (fiat). */
  chain: ChainId | null;
  /** Lower-case token address, or `fiat:usd` for a currency. */
  assetKey: string;
  symbol: string;
  decimals: number;
  /** Raw units, or null when not known. */
  amount: bigint | null;
}

export interface FeeLine {
  label: string;
  kind: FeeKind;
  assetKey: string;
  symbol: string;
  decimals: number;
  /** Null when the fee is not known (for example shown only on a provider's page). */
  amount: bigint | null;
}

export interface ExecutionLeg {
  id: string;
  kind: LegKind;
  title: string;
  input: AmountLine;
  output: AmountLine;
  fees: FeeLine[];
  estimatedSeconds: number | null;
  risk: RiskLevel;
  signatures: number;
  expiresAt: number;
  notes: string[];
}

export interface FeeTotal {
  assetKey: string;
  symbol: string;
  decimals: number;
  /** Sum of the fees whose amount is known. */
  known: bigint;
  /** How many fees in this asset are not known, so the real total is higher by an unknown amount. */
  unknown: number;
}

export interface ExecutionQuote {
  id: string;
  legs: ExecutionLeg[];
  spend: AmountLine;
  /** What arrives at the end, or null when any leg has no price. */
  receive: AmountLine;
  feeTotals: FeeTotal[];
  totalSeconds: number | null;
  signatures: number;
  risk: RiskLevel;
  expiresAt: number;
  warnings: string[];
}

const RISK = { low: 0, medium: 1, high: 2 } as const;
const key = (a: string): string => a.toLowerCase();

const fiatLine = (code: string, amount: number | null): AmountLine => ({ chain: null, assetKey: `fiat:${code.toLowerCase()}`, symbol: code.toUpperCase(), decimals: 0, amount: amount === null ? null : BigInt(amount) });

export function legFromSettlement(q: SettlementQuote, symbol = 'USDC', decimals = 6): ExecutionLeg {
  const i = q.intent;
  const src = { chain: i.sourceChain, assetKey: key(i.sourceAsset.address), symbol, decimals };
  const fees: FeeLine[] = [{ label: 'Transfer fee', kind: 'settlement', assetKey: src.assetKey, symbol, decimals, amount: q.settlementFee.amount }];
  if (q.networkFees === null) fees.push({ label: 'Network fees (not estimated)', kind: 'network', assetKey: `native:${i.sourceChain}`, symbol: CHAINS[i.sourceChain].nativeSymbol, decimals: CHAINS[i.sourceChain].nativeDecimals, amount: null });
  else for (const f of q.networkFees) fees.push({ label: `Network fee on ${CHAINS[f.chain].name}`, kind: 'network', assetKey: `native:${f.chain}`, symbol: CHAINS[f.chain].nativeSymbol, decimals: CHAINS[f.chain].nativeDecimals, amount: f.amount });
  return {
    id: q.id,
    kind: 'settlement',
    title: `Move ${symbol} from ${CHAINS[i.sourceChain].name} to ${CHAINS[i.destinationChain].name}`,
    input: { ...src, amount: q.sourceAmount },
    output: { chain: i.destinationChain, assetKey: key(i.destinationAsset.address), symbol, decimals, amount: q.destinationAmount },
    fees,
    estimatedSeconds: q.estimatedSeconds,
    risk: q.risk.level,
    signatures: q.route.steps.filter((s) => s.requiresSignature).length,
    expiresAt: q.expiresAt,
    notes: [q.risk.trust, ...q.requirements],
  };
}

export function legFromRamp(q: RampQuote): ExecutionLeg {
  const i = q.intent;
  const token: Omit<AmountLine, 'amount'> = { chain: i.asset.chain, assetKey: key(i.asset.address), symbol: i.asset.symbol, decimals: i.asset.decimals };
  const fiat = fiatLine(i.fiat, i.fiatAmount);
  const buy = i.side === 'buy';
  return {
    id: q.id,
    kind: buy ? 'ramp-buy' : 'ramp-sell',
    title: buy ? `Buy ${i.asset.symbol} on ${CHAINS[i.asset.chain].name} with ${i.fiat.toUpperCase()}` : `Sell ${i.asset.symbol} on ${CHAINS[i.asset.chain].name} for ${i.fiat.toUpperCase()}`,
    input: buy ? fiat : { ...token, amount: null },
    output: buy ? { ...token, amount: q.cryptoAmount } : { ...fiat, amount: null },
    fees: q.fees.map((f) => ({ label: f.label, kind: 'ramp' as const, assetKey: fiat.assetKey, symbol: fiat.symbol, decimals: 0, amount: f.amount === null ? null : BigInt(f.amount) })),
    estimatedSeconds: q.estimatedMinutes === null ? null : q.estimatedMinutes * 60,
    risk: 'medium',
    signatures: 0,
    expiresAt: q.expiresAt,
    notes: q.disclosures,
  };
}

export interface TokenMeta {
  symbol: string;
  decimals: number;
}

export function legFromSwap(q: Quote, from: TokenMeta, to: TokenMeta): ExecutionLeg {
  const r = q.request;
  const fees: FeeLine[] = [];
  const meta = (address: string | null): TokenMeta & { key: string } => {
    if (address === null || key(address) === key(r.from.address)) return { ...from, key: key(r.from.address) };
    if (key(address) === key(r.to.address)) return { ...to, key: key(r.to.address) };
    return { symbol: address.slice(0, 6), decimals: 0, key: key(address) };
  };
  const cost = (label: string, kind: FeeKind, c: { amount: bigint; asset: { address: string } | null } | null): void => {
    if (c === null) fees.push({ label: `${label} (not itemised)`, kind, assetKey: key(r.from.address), symbol: from.symbol, decimals: from.decimals, amount: null });
    else {
      const m = meta(c.asset?.address ?? null);
      fees.push({ label, kind, assetKey: m.key, symbol: m.symbol, decimals: m.decimals, amount: c.amount });
    }
  };
  cost('Network fee', 'network', q.costs.network);
  cost('Venue fee', 'dex', q.costs.provider);
  if (q.costs.aretiaBuyback.amount > 0n) cost('ACT buyback allocation', 'aretia-buyback', q.costs.aretiaBuyback);
  return {
    id: q.id,
    kind: 'swap',
    title: `Swap ${from.symbol} for ${to.symbol} on ${CHAINS[r.chain].name}`,
    input: { chain: r.chain, assetKey: key(r.from.address), symbol: from.symbol, decimals: from.decimals, amount: q.inAmount },
    // The least the user can receive: a plan is only as good as its worst case.
    output: { chain: r.chain, assetKey: key(r.to.address), symbol: to.symbol, decimals: to.decimals, amount: q.minOut },
    fees,
    estimatedSeconds: null,
    risk: q.priceImpactBps !== null && q.priceImpactBps > 300 ? 'high' : q.priceImpactBps !== null && q.priceImpactBps > 100 ? 'medium' : 'low',
    signatures: 1,
    expiresAt: q.expiresAt,
    notes: q.priceImpactBps === null ? ['Price impact was not reported.'] : [],
  };
}

/** Joins legs into one quote, or throws if they do not connect. */
export function combineLegs(id: string, legs: ExecutionLeg[]): ExecutionQuote {
  const first = legs[0];
  const last = legs[legs.length - 1];
  if (!first || !last) throw new SwingsError('invalid', 'A plan needs at least one step.');
  const warnings: string[] = [];
  for (let n = 1; n < legs.length; n++) {
    const out = legs[n - 1]!.output;
    const inn = legs[n]!.input;
    if (out.assetKey !== inn.assetKey || out.chain !== inn.chain) throw new SwingsError('invalid', `Step ${n} delivers ${out.symbol}${out.chain ? ' on ' + CHAINS[out.chain].name : ''} but step ${n + 1} takes ${inn.symbol}${inn.chain ? ' on ' + CHAINS[inn.chain].name : ''}, so these steps do not connect.`);
    if (out.amount !== null && inn.amount !== null && inn.amount > out.amount) throw new SwingsError('invalid', `Step ${n + 1} takes more ${inn.symbol} than step ${n} delivers.`);
  }
  const unpriced = legs.some((l) => l.output.amount === null);
  if (unpriced) warnings.push('At least one step has no price yet, so the final amount cannot be stated. The provider shows it before you pay.');
  const totals = new Map<string, FeeTotal>();
  for (const l of legs) {
    for (const f of l.fees) {
      const t = totals.get(f.assetKey) ?? { assetKey: f.assetKey, symbol: f.symbol, decimals: f.decimals, known: 0n, unknown: 0 };
      if (f.amount === null) t.unknown++;
      else t.known += f.amount;
      totals.set(f.assetKey, t);
    }
  }
  const secs = legs.map((l) => l.estimatedSeconds);
  return {
    id,
    legs,
    spend: first.input,
    receive: unpriced ? { ...last.output, amount: null } : last.output,
    feeTotals: [...totals.values()],
    totalSeconds: secs.every((s): s is number => s !== null) ? secs.reduce((a, b) => a + b, 0) : null,
    signatures: legs.reduce((a, l) => a + l.signatures, 0),
    risk: legs.reduce<RiskLevel>((w, l) => (RISK[l.risk] > RISK[w] ? l.risk : w), 'low'),
    expiresAt: Math.min(...legs.map((l) => l.expiresAt)),
    warnings,
  };
}

/**
 * A settlement step whose amount is not known yet because it depends on what the step before delivers. It carries no
 * amounts and no fee figure, and says so, so the whole plan's final amount stays unknown until the step is really quoted.
 */
export function pendingSettlementLeg(id: string, from: { chain: ChainId; address: string }, to: { chain: ChainId; address: string }, estimatedSeconds: number | null, symbol = 'USDC', decimals = 6): ExecutionLeg {
  return {
    id,
    kind: 'settlement',
    title: `Move ${symbol} from ${CHAINS[from.chain].name} to ${CHAINS[to.chain].name}`,
    input: { chain: from.chain, assetKey: key(from.address), symbol, decimals, amount: null },
    output: { chain: to.chain, assetKey: key(to.address), symbol, decimals, amount: null },
    fees: [{ label: 'Transfer fee (quoted when the money arrives)', kind: 'settlement', assetKey: key(from.address), symbol, decimals, amount: null }, { label: 'Network fees (not estimated)', kind: 'network', assetKey: `native:${from.chain}`, symbol: CHAINS[from.chain].nativeSymbol, decimals: CHAINS[from.chain].nativeDecimals, amount: null }],
    estimatedSeconds,
    risk: 'low',
    signatures: 3,
    expiresAt: Number.MAX_SAFE_INTEGER,
    notes: ['This step is priced and checked again when the money has arrived, from the amount that actually arrived.'],
  };
}
