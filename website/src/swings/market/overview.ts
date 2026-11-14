/**
 * The numbers behind the overview band at the top of the Markets list (market mood, rising against falling, busiest venues, and the three
 * short lists: top gainers, newly listed, trending). The cards are worked out from a sample of the busiest pools (overviewSample.ts) and the three
 * short lists from the list's own rows; every figure says what it was worked out from. Pure.
 */
import type { MarketRow } from './types.js';

const vol = (r: MarketRow): number => r.volumeUsd?.h24 ?? r.volume24hUsd ?? 0;

export interface Mood {
  /** 0 to 100, 50 being an even market (see `marketMood`). */
  score: number;
  label: string;
  /** How many tokens it was worked out from. */
  basis: number;
}

/** Fewer tokens than this make a "mood" too thin to show. */
export const MOOD_MIN_ROWS = 10;
/** A 24-hour move smaller than this counts as no move: it is a pegged coin, or noise. */
export const MOOD_FLAT_PCT = 1;
/** Each token's move counts at most this much either way, so one token that went up a thousandfold cannot decide the day. */
export const MOOD_CAP_PCT = 50;

export function moodLabel(score: number): string {
  if (score < 20) return 'Very weak';
  if (score < 40) return 'Weak';
  if (score < 60) return 'Mixed';
  if (score < 80) return 'Strong';
  return 'Very strong';
}

/**
 * The market mood, from 0 to 100, in two equal halves, each weighted by the square root of the token's 24-hour traded value (so a big pool counts
 * more than a thin one without one pool deciding everything):
 *  - breadth: the weighted share of tokens that rose (against fell) by at least 1%, so a stablecoin's 0.02% is neither;
 *  - strength: 50 plus the weighted average move, each move capped at ±50%.
 * 100 therefore needs every token up and the average up 50%: it cannot come from a handful of lucky tokens. Null when too few tokens have both a
 * 24-hour change and a traded value.
 */
export function marketMood(rows: readonly MarketRow[]): Mood | null {
  let wUp = 0;
  let wDown = 0;
  let wAll = 0;
  let wMove = 0;
  let basis = 0;
  for (const r of rows) {
    const c = r.change.h24;
    const v = vol(r);
    if (c === null || !Number.isFinite(c) || !(v > 0)) continue;
    basis++;
    const w = Math.sqrt(v);
    wAll += w;
    wMove += w * Math.max(-MOOD_CAP_PCT, Math.min(MOOD_CAP_PCT, c));
    if (c >= MOOD_FLAT_PCT) wUp += w;
    else if (c <= -MOOD_FLAT_PCT) wDown += w;
  }
  if (basis < MOOD_MIN_ROWS || wAll <= 0) return null;
  const breadthScore = wUp + wDown > 0 ? (100 * wUp) / (wUp + wDown) : 50;
  const strengthScore = Math.max(0, Math.min(100, 50 + wMove / wAll));
  const score = Math.round((breadthScore + strengthScore) / 2);
  return { score, label: moodLabel(score), basis };
}

export interface Breadth {
  rising: number;
  falling: number;
  flat: number;
  /** The middle 24-hour change of the tokens that have one, in percent. */
  median: number | null;
}

export function breadth(rows: readonly MarketRow[]): Breadth {
  let rising = 0;
  let falling = 0;
  let flat = 0;
  const changes: number[] = [];
  for (const r of rows) {
    const c = r.change.h24;
    if (c === null || !Number.isFinite(c)) continue;
    changes.push(c);
    if (c >= MOOD_FLAT_PCT) rising++;
    else if (c <= -MOOD_FLAT_PCT) falling++;
    else flat++;
  }
  changes.sort((a, b) => a - b);
  const mid = changes.length >> 1;
  const median = changes.length === 0 ? null : changes.length % 2 ? changes[mid]! : (changes[mid - 1]! + changes[mid]!) / 2;
  return { rising, falling, flat, median };
}

export interface VenueRow {
  venue: string;
  volumeUsd: number;
  /** Share of the listed volume, 0 to 1. */
  share: number;
  /** The volume-weighted 24-hour change of the venue's tokens, in percent (null when none has one). */
  change: number | null;
  pools: number;
}

/** The venues (exchanges) with the most traded value among the rows, busiest first. */
export function busiestVenues(rows: readonly MarketRow[], n = 4): VenueRow[] {
  const by = new Map<string, { v: number; w: number; wc: number; pools: number }>();
  let total = 0;
  for (const r of rows) {
    const name = r.venue?.trim();
    const v = vol(r);
    if (!name || !(v > 0)) continue;
    total += v;
    const cur = by.get(name) ?? { v: 0, w: 0, wc: 0, pools: 0 };
    cur.v += v;
    cur.pools++;
    if (r.change.h24 !== null && Number.isFinite(r.change.h24)) {
      // A single wild outlier must not set a venue's figure: each token's change counts at most +/-500%.
      cur.w += v;
      cur.wc += v * Math.max(-500, Math.min(500, r.change.h24));
    }
    by.set(name, cur);
  }
  return [...by.entries()]
    .map(([venue, x]) => ({ venue, volumeUsd: x.v, share: total > 0 ? x.v / total : 0, change: x.w > 0 ? x.wc / x.w : null, pools: x.pools }))
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
    .slice(0, n);
}

/** The biggest 24-hour risers, with at least a little traded value so one thin trade cannot top the list. */
export function topGainers(rows: readonly MarketRow[], n = 3, minVolumeUsd = 1_000): MarketRow[] {
  return rows
    .filter((r) => r.change.h24 !== null && r.change.h24 > 0 && vol(r) >= minVolumeUsd)
    .sort((a, b) => b.change.h24! - a.change.h24!)
    .slice(0, n);
}

/** The newest pools that have traded at all. */
export function newlyListed(rows: readonly MarketRow[], n = 3): MarketRow[] {
  return rows
    .filter((r) => r.ageMs !== null && r.ageMs >= 0 && (r.txns24h ?? 0) > 0)
    .sort((a, b) => a.ageMs! - b.ageMs!)
    .slice(0, n);
}

/** The busiest right now: most traded value in the last hour (the day's, where the hour is not known). */
export function trendingNow(rows: readonly MarketRow[], n = 3): MarketRow[] {
  const hot = (r: MarketRow): number => r.volumeUsd?.h1 ?? vol(r);
  return rows
    .filter((r) => hot(r) > 0)
    .sort((a, b) => hot(b) - hot(a))
    .slice(0, n);
}

/**
 * A small price line for a row, from the price now and its changes over 5 minutes, 1, 6 and 24 hours (so it is drawn from real figures, not
 * invented points). Each point is [position 0 (24 hours ago) to 1 (now), price]. Null when fewer than three points can be worked out.
 */
export function sparkPoints(r: Pick<MarketRow, 'priceUsd' | 'change'>): [number, number][] | null {
  const now = r.priceUsd;
  if (now === null || !(now > 0)) return null;
  const pts: [number, number][] = [];
  for (const [minutes, change] of [[1440, r.change.h24], [360, r.change.h6], [60, r.change.h1], [5, r.change.m5]] as [number, number | null][]) {
    if (change === null || !Number.isFinite(change) || 1 + change / 100 <= 0) continue;
    pts.push([(1440 - minutes) / 1440, now / (1 + change / 100)]);
  }
  pts.push([1, now]);
  return pts.length >= 3 ? pts : null;
}
