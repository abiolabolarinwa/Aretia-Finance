/**
 * ARF: the Aretia Rising/Falling engine. Every eligible token is exactly one of rising, falling or neutral over the chosen window, so the three
 * counts add up to the eligible count and their percentages to 100. Net market breadth says how lopsided the two sides are.
 */
import { DEFAULT_CONFIG, screenTokens, type Exclusion, type IntelConfig, type IntelPool, type Window } from './common.js';

export type Direction = 'rising' | 'falling' | 'neutral';

/** The class of one return, in percent. Strictly beyond the threshold is a move; the threshold itself is neutral. */
export function classify(changePct: number, neutralPct: number = DEFAULT_CONFIG.neutralPct): Direction {
  if (changePct > neutralPct) return 'rising';
  if (changePct < -neutralPct) return 'falling';
  return 'neutral';
}

export interface ArfResult {
  window: Window;
  eligible: number;
  rising: number;
  falling: number;
  neutral: number;
  /** Percent of the eligible tokens; they add to 100 (up to rounding). Null when nothing is eligible. */
  risingPct: number | null;
  fallingPct: number | null;
  neutralPct: number | null;
  /** (rising - falling) / eligible x 100, from -100 to 100. */
  netBreadth: number | null;
  /** Fewer eligible tokens than the configured minimum: the counts are shown, but no conclusion should be drawn. */
  thin: boolean;
  considered: number;
  excluded: Partial<Record<Exclusion, number>>;
}

export function arf(pools: readonly IntelPool[], window: Window, c: IntelConfig = DEFAULT_CONFIG): ArfResult {
  const s = screenTokens(pools, window, c);
  let rising = 0;
  let falling = 0;
  let neutral = 0;
  for (const p of s.eligible) {
    const d = classify(p.change[window]!, c.neutralPct);
    if (d === 'rising') rising++;
    else if (d === 'falling') falling++;
    else neutral++;
  }
  const n = s.eligible.length;
  const pct = (k: number): number | null => (n > 0 ? (100 * k) / n : null);
  return {
    window,
    eligible: n,
    rising,
    falling,
    neutral,
    risingPct: pct(rising),
    fallingPct: pct(falling),
    neutralPct: pct(neutral),
    netBreadth: n > 0 ? (100 * (rising - falling)) / n : null,
    thin: n < Math.min(c.minEligible, 10),
    considered: s.considered,
    excluded: s.excluded,
  };
}
