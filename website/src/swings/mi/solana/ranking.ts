/**
 * The order of Solana's Top and Trending lists, taken from Jupiter's own lists of what is traded and trending right now.
 *
 * Aretia's index ranks the pools it has read, but its history of long-established tokens is thin, so a list ranked by the index alone shows
 * little-known tokens and misses the ones people actually trade. Jupiter ranks by what its router sees across every venue. Only the ORDER
 * and the choice of tokens come from Jupiter: each row is still built from Aretia's index (its pool, its chart, its trades), so a token
 * with no pool in the index is left out rather than shown with someone else's numbers.
 *
 * If Jupiter cannot be reached the last list (up to an hour old) is used, and failing that the caller falls back to the index's own ranking.
 */
import { jupiterEndpoint, parseToken, type Tradable } from './tradable.js';

export type RankKind = 'top' | 'trending';
export type RankWindow = 'm5' | 'h1' | 'h6' | 'h24';

export interface Ranked {
  /** Mints in Jupiter's order, best first. */
  mints: string[];
  /** What Jupiter says of each, for the buyable check (no second request is needed). */
  byMint: Map<string, Tradable>;
}

export type RankingSource = (kind: RankKind, window: RankWindow) => Promise<Ranked | null>;

const PATH: Record<RankKind, string> = { top: 'toptraded', trending: 'toptrending' };
const INTERVAL: Record<RankWindow, string> = { m5: '5m', h1: '1h', h6: '6h', h24: '24h' };
const LIMIT = 100;
const FRESH_MS = 2 * 60_000;
const STALE_MS = 60 * 60_000;
const FAILURE_PAUSE_MS = 60_000;

const lists = new Map<string, { at: number; ranked: Ranked }>();
let pausedUntil = 0;

export function resetRankingMemory(): void {
  lists.clear();
  pausedUntil = 0;
}

export function jupiterRanking(fetchImpl: typeof fetch, now: () => number, signal?: AbortSignal, apiKey?: string): RankingSource {
  return async (kind, window) => {
    const key = `${kind}|${window}`;
    const t0 = now();
    const have = lists.get(key);
    if (have && t0 - have.at < FRESH_MS) return have.ranked;
    const older = (): Ranked | null => (have && t0 - have.at < STALE_MS ? have.ranked : null);
    if (t0 < pausedUntil) return older();
    try {
      const k = apiKey?.trim();
      const res = await fetchImpl(`${jupiterEndpoint(k)}/${PATH[kind]}/${INTERVAL[window]}?limit=${LIMIT}`, { signal, headers: { accept: 'application/json', ...(k ? { 'x-api-key': k } : {}) } });
      if (!res.ok) throw new Error(`Jupiter answered ${res.status}.`);
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) throw new Error('Jupiter answered something unexpected.');
      const mints: string[] = [];
      const byMint = new Map<string, Tradable>();
      for (const item of body) {
        const p = parseToken(item);
        if (p && !byMint.has(p.id)) {
          mints.push(p.id);
          byMint.set(p.id, p.t);
        }
      }
      if (mints.length === 0) throw new Error('Jupiter listed nothing.');
      const ranked = { mints, byMint };
      lists.set(key, { at: t0, ranked });
      return ranked;
    } catch {
      pausedUntil = t0 + FAILURE_PAUSE_MS;
      return older();
    }
  };
}
