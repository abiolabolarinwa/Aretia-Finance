/**
 * Execution intelligence: plain, deterministic analysis that helps the user choose and helps Aretia notice trouble.
 * There is no model and no learning here. Every output is a fixed calculation on numbers that are in front of it, so
 * the same inputs always give the same words, and every number it states can be checked by hand.
 *
 *  - `compareSettlementQuotes` says what the choice between routes costs or saves, in the user's own terms;
 *  - `providerReliability` turns a provider's recent outcomes into a cautious score (a lower confidence bound, so a
 *    provider with two successes is not trusted like one with two hundred);
 *  - `quoteWarnings` points out anything unusual in a quote set (an outlier, a thin choice, high impact).
 * Advice never overrides the engines' checks and never executes anything.
 */
import { CHAINS } from '../core/types.js';
import { formatUnits, durationText } from '../crosschain/view.js';
import type { SettlementQuote } from '../settlement/types.js';

/** Wilson score lower bound for a success rate at ~95% confidence. 0 when there is no data. */
export function wilsonLowerBound(successes: number, total: number): number {
  if (total <= 0) return 0;
  const z = 1.96;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return Math.max(0, (centre - margin) / denom);
}

export interface Outcome {
  ok: boolean;
  at: number;
}

export interface Reliability {
  total: number;
  failures: number;
  /** 0 to 1, cautious. */
  score: number;
  label: 'no history' | 'limited history' | 'reliable' | 'unreliable';
  summary: string;
}

/** Recent outcomes for one provider, newest or oldest first (order does not matter), within `windowMs` of `now`. */
export function providerReliability(outcomes: readonly Outcome[], now: number, windowMs = 7 * 24 * 3_600_000): Reliability {
  const recent = outcomes.filter((o) => now - o.at <= windowMs);
  const failures = recent.filter((o) => !o.ok).length;
  const total = recent.length;
  const score = wilsonLowerBound(total - failures, total);
  if (total === 0) return { total, failures, score, label: 'no history', summary: 'No recent record of this provider.' };
  if (total < 10) return { total, failures, score, label: 'limited history', summary: `${failures} of the last ${total} attempts failed. That is too few to judge.` };
  return { total, failures, score, label: score >= 0.9 ? 'reliable' : 'unreliable', summary: `${failures} of the last ${total} attempts failed.` };
}

export interface Comparison {
  headline: string;
  details: string[];
}

/** What choosing the first quote costs or saves compared with each other quote. Quotes must be for the same request. */
export function compareSettlementQuotes(quotes: readonly SettlementQuote[], symbol = 'USDC', decimals = 6): Comparison | null {
  const [best, ...others] = quotes;
  if (!best) return null;
  const dst = CHAINS[best.intent.destinationChain].name;
  const details: string[] = [];
  for (const o of others) {
    const moreArrives = best.destinationAmount - o.destinationAmount;
    const faster = o.estimatedSeconds - best.estimatedSeconds;
    const parts: string[] = [];
    if (moreArrives > 0n) parts.push(`${formatUnits(moreArrives, decimals)} ${symbol} more arrives on ${dst}`);
    else if (moreArrives < 0n) parts.push(`${formatUnits(-moreArrives, decimals)} ${symbol} less arrives on ${dst}`);
    if (faster > 0) parts.push(`${durationText(faster).replace('about ', '')} faster`);
    else if (faster < 0) parts.push(`${durationText(-faster).replace('about ', '')} slower`);
    details.push(`Compared with ${o.route.mechanism}: ${parts.length > 0 ? parts.join(', ') : 'no difference in amount or time'}.`);
  }
  return { headline: `${best.route.mechanism}: ${formatUnits(best.destinationAmount, decimals)} ${symbol} arrives on ${dst} in ${durationText(best.estimatedSeconds)}.`, details };
}

export interface Warning {
  severity: 'info' | 'caution';
  text: string;
}

/** Anything unusual about a set of quotes for one request. */
export function quoteWarnings(quotes: readonly SettlementQuote[]): Warning[] {
  const w: Warning[] = [];
  if (quotes.length === 0) return [{ severity: 'caution', text: 'No route is available for this request.' }];
  if (quotes.length === 1) w.push({ severity: 'info', text: 'Only one route is available, so there is nothing to compare it with.' });
  const amounts = quotes.map((q) => q.destinationAmount).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const best = amounts[amounts.length - 1]!;
  for (const q of quotes) {
    const gapBps = best > 0n ? Number(((best - q.destinationAmount) * 10_000n) / best) : 0;
    if (gapBps > 100) w.push({ severity: 'info', text: `${q.route.mechanism} delivers ${(gapBps / 100).toFixed(2)}% less than the best route.` });
    if (q.risk.level !== 'low') w.push({ severity: 'caution', text: `${q.route.mechanism} is rated ${q.risk.level} risk.` });
    if (q.estimatedSeconds > 60 * 60) w.push({ severity: 'info', text: `${q.route.mechanism} takes ${durationText(q.estimatedSeconds)}.` });
  }
  return w;
}
