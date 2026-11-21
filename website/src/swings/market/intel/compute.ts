/**
 * The whole market intelligence answer for one scope (all networks, or one): AMMI, ARF for each window, ADV, and a data-quality note for each,
 * from the pools and the stored history. Pure. This is what the public endpoint returns and the Markets page draws; the worker stores the
 * inputs (snapshot.ts) so the same answer can be worked out again.
 */
import { adv, type AdvResult } from './adv.js';
import { ammi, marketReturn, type AmmiResult, type IntelHistory } from './ammi.js';
import { arf, type ArfResult } from './arf.js';
import { DEFAULT_CONFIG, METHOD_VERSION, WINDOWS, type IntelConfig, type IntelPool, type Window } from './common.js';
import { poolsOfScope } from './snapshot.js';

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'none';

/**
 * A plain reading of how much data a figure stands on. It is a rule of thumb from coverage and from which parts were available, not a
 * statistical probability: nothing here has been calibrated against outcomes.
 */
export interface Confidence {
  level: ConfidenceLevel;
  /** Eligible tokens or pools, and how many pools were looked at. */
  eligible: number;
  considered: number;
  /** Eligible as a share of considered, 0 to 1. */
  coverage: number;
  /** What limits it, in words. */
  limits: string[];
}

export interface IntelResult {
  version: number;
  scope: string;
  /** ms: when the pools were read. */
  asOf: number;
  ammi: AmmiResult;
  arf: Record<Window, ArfResult>;
  adv: AdvResult;
  confidence: { ammi: Confidence; arf: Confidence; adv: Confidence };
  /** How much stored history the parts that need it had. */
  history: { days: number; hourlyReturns: number; liquiditySamples: number; venueGrowth: boolean };
}

/** How many venues the Busiest venues card lists: the ten with the most volume (the answer still carries the venue count and the total over all of them). */
export const VENUES_SHOWN = 10;
const share = (a: number, b: number): number => (b > 0 ? a / b : 0);

function ammiConfidence(a: AmmiResult): Confidence {
  const limits: string[] = [];
  for (const [k, p] of Object.entries(a.components)) if (!p.used) limits.push(`${k}: ${p.note}`);
  let level: ConfidenceLevel = 'none';
  if (a.status === 'ok') level = share(a.eligible, a.considered) >= 0.1 ? 'high' : 'medium';
  else if (a.status === 'provisional') level = a.weightUsed >= 0.55 && a.eligible >= 50 ? 'medium' : 'low';
  return { level, eligible: a.eligible, considered: a.considered, coverage: share(a.eligible, a.considered), limits };
}

function arfConfidence(r: ArfResult): Confidence {
  const limits: string[] = [];
  if (r.eligible < 30) limits.push(`only ${r.eligible} eligible tokens`);
  const level: ConfidenceLevel = r.eligible === 0 ? 'none' : r.eligible >= 100 ? 'high' : r.eligible >= 30 ? 'medium' : 'low';
  return { level, eligible: r.eligible, considered: r.considered, coverage: share(r.eligible, r.considered), limits };
}

function advConfidence(a: AdvResult, growth: boolean): Confidence {
  const limits: string[] = ['pool-level volume: a route through several pools counts in each'];
  if (!growth) limits.push('no stored figure from 24 hours ago, so no growth');
  if (a.excludedVolume24hUsd > 0) limits.push('volume of pools that failed the wash-trading checks is left out');
  const level: ConfidenceLevel = a.eligiblePools === 0 ? 'none' : a.eligiblePools >= 50 ? 'high' : a.eligiblePools >= 10 ? 'medium' : 'low';
  return { level, eligible: a.eligiblePools, considered: a.considered, coverage: share(a.eligiblePools, a.considered), limits };
}

export function computeIntel(allPools: readonly IntelPool[], scope: string, now: number, stored: { history: IntelHistory; venuesPrev: Map<string, number> | null }, c: IntelConfig = DEFAULT_CONFIG): IntelResult {
  const pools = poolsOfScope(allPools, scope);
  const arfs = {} as Record<Window, ArfResult>;
  for (const w of WINDOWS) arfs[w] = arf(pools, w, c);
  const a = adv(pools, stored.venuesPrev, VENUES_SHOWN, c);
  // The current hour's market return is the newest point of the hourly series.
  const r1h = marketReturn(pools, 'h1', c);
  const history: IntelHistory = { ...stored.history, hourlyReturns: r1h === null ? stored.history.hourlyReturns : [...stored.history.hourlyReturns, r1h] };
  const m = ammi(pools, a.totalVolume24hUsd, history, c);
  return {
    version: METHOD_VERSION,
    scope,
    asOf: now,
    ammi: m,
    arf: arfs,
    adv: a,
    confidence: { ammi: ammiConfidence(m), arf: arfConfidence(arfs.h24), adv: advConfidence(a, stored.venuesPrev !== null) },
    history: { days: stored.history.dailyVolumes.length, hourlyReturns: history.hourlyReturns.length, liquiditySamples: stored.history.liquiditySamples.length, venueGrowth: stored.venuesPrev !== null },
  };
}
