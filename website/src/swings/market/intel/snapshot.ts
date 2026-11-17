/**
 * Stored snapshots of the market intelligence inputs: what a calculation read at one moment, small enough to keep every five minutes for a
 * week. A snapshot is the history the volume, momentum and stability parts of the index need, the previous-24-hours volume of each venue, and
 * the evidence for any figure that was shown (the same pools and the same formulas give the same answer). Pure: building a snapshot, turning
 * stored rows into history, and the table's row shape. Reading and writing the table is in read.ts.
 */
import { adv, screenVenuePools } from './adv.js';
import { arf } from './arf.js';
import { depthScore, marketReturn, NO_HISTORY, type IntelHistory } from './ammi.js';
import { METHOD_VERSION, WINDOWS, screenTokens, sum, type IntelConfig, type IntelPool, DEFAULT_CONFIG, type Window } from './common.js';

export interface VenueSnapshot {
  venue: string;
  volume24h: number;
  swaps: number;
  pools: number;
}

export interface IntelSnapshot {
  v: number;
  scope: string;
  /** ms */
  at: number;
  /** Eligible tokens for the 24-hour return. */
  eligible: number;
  /** Liquidity-weighted log returns of the market over the last hour and the last 24 hours; null with too few tokens. */
  r1h: number | null;
  r24h: number | null;
  /** Total liquidity and total 24-hour volume of the pools that count for venue volume. */
  liquidity: number;
  volume24h: number;
  depth: number | null;
  arf: Record<Window, { rising: number; falling: number; neutral: number }>;
  venues: VenueSnapshot[];
}

/** The scope of a chain choice: `all` for every network. */
export const scopeOf = (chain: string): string => (chain === '' ? 'all' : chain);

export function poolsOfScope(pools: readonly IntelPool[], scope: string): IntelPool[] {
  return scope === 'all' ? [...pools] : pools.filter((p) => p.chain === scope);
}

export function buildSnapshot(allPools: readonly IntelPool[], scope: string, now: number, c: IntelConfig = DEFAULT_CONFIG): IntelSnapshot {
  const pools = poolsOfScope(allPools, scope);
  const venuePools = screenVenuePools(pools, c).eligible;
  const all = adv(pools, null, Number.MAX_SAFE_INTEGER, c);
  const arfs = {} as IntelSnapshot['arf'];
  for (const w of WINDOWS) {
    const a = arf(pools, w, c);
    arfs[w] = { rising: a.rising, falling: a.falling, neutral: a.neutral };
  }
  return {
    v: METHOD_VERSION,
    scope,
    at: now,
    eligible: screenTokens(pools, 'h24', c).eligible.length,
    r1h: marketReturn(pools, 'h1', c),
    r24h: marketReturn(pools, 'h24', c),
    liquidity: sum(venuePools.map((p) => p.liquidityUsd ?? 0)),
    volume24h: all.totalVolume24hUsd,
    depth: depthScore(venuePools, c),
    arf: arfs,
    venues: all.venues.map((v) => ({ venue: v.venue, volume24h: v.volume24hUsd, swaps: v.swaps24h, pools: v.pools })),
  };
}

// ------------------------------------------------------------------ the table

/** A row of mi_market_snapshots. */
export interface SnapshotRow {
  scope: string;
  at: number;
  v: number;
  eligible: number;
  r1h: number | null;
  r24h: number | null;
  liquidity: number;
  volume24h: number;
  depth: number | null;
  arf: IntelSnapshot['arf'];
  venues: VenueSnapshot[];
}

export const rowOf = (s: IntelSnapshot): SnapshotRow => ({ scope: s.scope, at: s.at, v: s.v, eligible: s.eligible, r1h: s.r1h, r24h: s.r24h, liquidity: s.liquidity, volume24h: s.volume24h, depth: s.depth, arf: s.arf, venues: s.venues });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The stored row closest to `target` within `tolerance` ms, or null. */
export function nearest<T extends { at: number }>(rows: readonly T[], target: number, tolerance: number): T | null {
  let best: T | null = null;
  for (const r of rows) {
    const d = Math.abs(r.at - target);
    if (d <= tolerance && (best === null || d < Math.abs(best.at - target))) best = r;
  }
  return best;
}

/**
 * The history the calculations read, from stored rows (any order, any spacing) as of `now`:
 *  - one 24-hour volume per day, from the row nearest to 1, 2, ... 7 days ago (within 30 minutes of it);
 *  - one return per hour for the last 14 hours or more, from the row nearest to each full hour back;
 *  - every liquidity sample of the last 24 hours;
 *  - the venue volumes from about 24 hours ago, for growth.
 * Rows of another methodology version are ignored: a stored figure is never read with a formula it was not made with.
 */
export function historyFrom(rows: readonly SnapshotRow[], now: number): { history: IntelHistory; venuesPrev: Map<string, number> | null } {
  const mine = rows.filter((r) => r.v === METHOD_VERSION && r.at < now);
  const dailyVolumes: number[] = [];
  for (let k = 1; k <= 7; k++) {
    const r = nearest(mine, now - k * DAY, 30 * 60_000);
    if (r && r.volume24h > 0) dailyVolumes.push(r.volume24h);
  }
  const hourlyReturns: number[] = [];
  for (let k = 24; k >= 1; k--) {
    const r = nearest(mine, now - k * HOUR, 10 * 60_000);
    if (r && r.r1h !== null && Number.isFinite(r.r1h)) hourlyReturns.push(r.r1h);
  }
  const liquiditySamples = mine.filter((r) => r.at >= now - DAY && r.liquidity > 0).map((r) => r.liquidity);
  const prev = nearest(mine, now - DAY, 30 * 60_000);
  const venuesPrev = prev ? new Map(prev.venues.map((v) => [v.venue, v.volume24h])) : null;
  return { history: { dailyVolumes, hourlyReturns, liquiditySamples }, venuesPrev };
}

export { NO_HISTORY };
