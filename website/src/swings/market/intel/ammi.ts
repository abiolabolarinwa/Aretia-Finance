/**
 * AMMI: the Aretia Market Mood Index, 0 to 100:  0.30 T + 0.25 B + 0.20 V + 0.15 M + 0.10 L.
 *
 *  T  trend:     liquidity-weighted 24-hour log return of the eligible tokens, winsorized, through a logistic curve (flat = 50)
 *  B  breadth:   (rising + half the neutral) / eligible
 *  V  volume:    24-hour volume against the average of earlier days (stored snapshots), through a logistic curve of its log (normal = 50)
 *  M  momentum:  RSI(14) of the hourly changes of the market index (stored snapshots)
 *  L  liquidity: 0.6 depth + 0.4 stability (stability from stored snapshots)
 *
 * T and B come from the tokens alone. V, M and stability need history Aretia only has once it has been storing snapshots (a few days for V,
 * about 15 hours for M, a few hours for stability). Until then those parts are not available, and the index says so: with T and B present it is
 * "provisional", worked out from the parts that exist with their weights scaled to add to 1, and every part reports whether it was used. With T or B
 * missing, or too few eligible tokens, there is no index at all ("Insufficient market data"): a score is never made up.
 */
import { DEFAULT_CONFIG, clamp, quantile, rsiOfChanges, screenTokens, sigmoid, sum, weightedMean, winsorize, type IntelConfig, type IntelPool } from './common.js';
import { classify } from './arf.js';

export const AMMI_WEIGHTS = { T: 0.3, B: 0.25, V: 0.2, M: 0.15, L: 0.1 } as const;
export type ComponentKey = keyof typeof AMMI_WEIGHTS;

/** What the stored snapshots give the index. Every list may be empty. */
export interface IntelHistory {
  /** The 24-hour volume of the eligible pools as it stood about 1, 2, ... 7 days ago, one value per day. */
  dailyVolumes: number[];
  /** The liquidity-weighted 1-hour log return of the market, one per hour, oldest first. */
  hourlyReturns: number[];
  /** The total liquidity of the eligible pools over the last 24 hours, any spacing. */
  liquiditySamples: number[];
}

export const NO_HISTORY: IntelHistory = { dailyVolumes: [], hourlyReturns: [], liquiditySamples: [] };

/** Fewest earlier days of volume for V, hourly changes for M, and liquidity samples for stability. */
export const MIN_DAYS = 3;
export const RSI_PERIOD = 14;
export const MIN_LIQUIDITY_SAMPLES = 6;

export interface ComponentResult {
  /** 0 to 100, or null when it cannot be worked out. */
  score: number | null;
  weight: number;
  /** Whether it counted towards the index. */
  used: boolean;
  /** In words: what it was worked out from, or why it is missing. */
  note: string;
}

export interface AmmiResult {
  status: 'ok' | 'provisional' | 'insufficient';
  /** 0 to 100, rounded; null when status is insufficient. */
  score: number | null;
  label: string | null;
  components: Record<ComponentKey, ComponentResult>;
  /** The share of the full weight the used parts carry, 0 to 1. */
  weightUsed: number;
  eligible: number;
  considered: number;
}

export function moodLabel(score: number): string {
  if (score >= 80) return 'Very bullish';
  if (score >= 65) return 'Bullish';
  if (score >= 45) return 'Neutral';
  if (score >= 25) return 'Bearish';
  return 'Very bearish';
}

/** Weights for tokens: the square root of liquidity, capped at the 90th percentile, so one huge pool cannot be the market. */
function weightsOf(pools: readonly IntelPool[]): number[] {
  const roots = pools.map((p) => Math.sqrt(p.liquidityUsd ?? 0));
  const cap = quantile(roots, 0.9);
  return roots.map((r) => Math.min(r, cap));
}

/** The liquidity-weighted, winsorized mean log return of the tokens over a window, as a number such as 0.012 (1.2%); null with too few tokens. */
export function marketReturn(pools: readonly IntelPool[], window: 'h1' | 'h24', c: IntelConfig = DEFAULT_CONFIG): number | null {
  const s = screenTokens(pools, window, c).eligible;
  if (s.length < c.minEligible) return null;
  const r = winsorize(s.map((p) => Math.log(1 + p.change[window]! / 100)));
  return weightedMean(r, weightsOf(s));
}

/** The depth score, 0 to 100: for each eligible token how little a standard trade moves its price, weighted by its day's volume. */
export function depthScore(pools: readonly IntelPool[], c: IntelConfig = DEFAULT_CONFIG): number | null {
  const scores: number[] = [];
  const weights: number[] = [];
  for (const p of pools) {
    const liq = p.liquidityUsd ?? 0;
    const w = p.volumeUsd.h24 ?? 0;
    if (!(liq > 0) || !(w > 0)) continue;
    // A constant-product pool holds about half its liquidity on each side, so a trade of size s moves the price by about s / (half + s).
    const impact = c.depthTradeUsd / (liq / 2 + c.depthTradeUsd);
    scores.push(clamp(1 - impact / c.depthZeroImpact, 0, 1));
    weights.push(w);
  }
  const m = weightedMean(scores, weights);
  return m === null ? null : 100 * m;
}

/** Stability, 0 to 100: how steady the total liquidity was over the last day (a coefficient of variation of 25% or more is 0). Null with too few samples. */
export function stabilityScore(samples: readonly number[]): number | null {
  const xs = samples.filter((v) => Number.isFinite(v) && v > 0);
  if (xs.length < MIN_LIQUIDITY_SAMPLES) return null;
  const mean = sum(xs) / xs.length;
  const sd = Math.sqrt(sum(xs.map((v) => (v - mean) ** 2)) / xs.length);
  return 100 * clamp(1 - sd / mean / 0.25, 0, 1);
}

export function ammi(pools: readonly IntelPool[], volume24hUsd: number, history: IntelHistory = NO_HISTORY, c: IntelConfig = DEFAULT_CONFIG): AmmiResult {
  const s = screenTokens(pools, 'h24', c);
  const none = (note: string): ComponentResult => ({ score: null, weight: 0, used: false, note });
  const blank = (): Record<ComponentKey, ComponentResult> => ({ T: none(''), B: none(''), V: none(''), M: none(''), L: none('') });
  const parts = blank();
  for (const k of Object.keys(AMMI_WEIGHTS) as ComponentKey[]) parts[k] = { score: null, weight: AMMI_WEIGHTS[k], used: false, note: '' };
  const n = s.eligible.length;
  if (n < c.minEligible) {
    for (const k of Object.keys(parts) as ComponentKey[]) parts[k].note = `needs at least ${c.minEligible} eligible tokens (have ${n})`;
    return { status: 'insufficient', score: null, label: null, components: parts, weightUsed: 0, eligible: n, considered: s.considered };
  }

  const rm = marketReturn(pools, 'h24', c);
  if (rm !== null) {
    parts.T.score = 100 * sigmoid(rm / 0.05);
    parts.T.note = `liquidity-weighted 24-hour return of ${n} tokens: ${(100 * (Math.exp(rm) - 1)).toFixed(2)}%`;
  }
  let up = 0;
  let flat = 0;
  for (const p of s.eligible) {
    const d = classify(p.change.h24!, c.neutralPct);
    if (d === 'rising') up++;
    else if (d === 'neutral') flat++;
  }
  parts.B.score = (100 * (up + 0.5 * flat)) / n;
  parts.B.note = `${up} rising, ${flat} neutral of ${n} tokens`;

  const days = history.dailyVolumes.filter((v) => Number.isFinite(v) && v > 0);
  if (days.length >= MIN_DAYS && volume24hUsd > 0) {
    const avg = sum(days) / days.length;
    parts.V.score = 100 * sigmoid(Math.log(volume24hUsd / avg));
    parts.V.note = `24-hour volume is ${(volume24hUsd / avg).toFixed(2)} times the average of ${days.length} earlier day${days.length === 1 ? '' : 's'}`;
  } else parts.V.note = `needs ${MIN_DAYS} earlier days of stored volume (have ${days.length})`;

  const rsi = rsiOfChanges(history.hourlyReturns, RSI_PERIOD);
  if (rsi !== null) {
    parts.M.score = rsi;
    parts.M.note = `RSI(${RSI_PERIOD}) of the market index, hourly`;
  } else parts.M.note = `needs ${RSI_PERIOD} hourly changes of the stored index (have ${history.hourlyReturns.length})`;

  const depth = depthScore(pools, c);
  const stability = stabilityScore(history.liquiditySamples);
  if (depth !== null && stability !== null) {
    parts.L.score = 0.6 * depth + 0.4 * stability;
    parts.L.note = `0.6 depth (${depth.toFixed(0)}) + 0.4 stability (${stability.toFixed(0)})`;
  } else if (depth !== null) {
    // Depth alone is a real measurement, but not the whole of L: the note says so.
    parts.L.score = depth;
    parts.L.note = `depth of the pools (${depth.toFixed(0)}); stability needs ${MIN_LIQUIDITY_SAMPLES} stored samples (have ${history.liquiditySamples.length})`;
  } else parts.L.note = 'no pool with both liquidity and volume';

  // T and B are the core; without both there is no index.
  if (parts.T.score === null || parts.B.score === null) {
    return { status: 'insufficient', score: null, label: null, components: parts, weightUsed: 0, eligible: n, considered: s.considered };
  }
  let used = 0;
  let acc = 0;
  for (const k of Object.keys(parts) as ComponentKey[]) {
    const p = parts[k];
    if (p.score === null) continue;
    p.used = true;
    used += p.weight;
    acc += p.weight * clamp(p.score, 0, 100);
  }
  const score = Math.round(clamp(acc / used, 0, 100));
  const complete = Object.values(parts).every((p) => p.used) && parts.L.note.includes('stability (');
  return { status: complete ? 'ok' : 'provisional', score, label: moodLabel(score), components: parts, weightUsed: used, eligible: n, considered: s.considered };
}
