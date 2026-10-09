/**
 * Aretia's rating and burned-liquidity mark for the tokens on a Marketplace page. The lists themselves come from
 * GeckoTerminal; for the tokens on screen the page asks Aretia's registry (one request) what it has rated. A token the
 * registry has not rated stays unrated: "not rated" is shown, never a guess, and it is not a good sign or a bad one.
 */
import { RISK_LABELS } from '../tokens/risk.js';
import type { ChainId, RiskStatus } from '../core/types.js';
import type { MarketRow } from './types.js';

export interface Rating {
  chain: ChainId;
  address: string;
  status: RiskStatus | null;
  score: number | null;
  lockedPct: number | null;
}

const key = (chain: ChainId, address: string): string => `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`;

/** Pure. Fills in the rating (and the padlock) of every row the registry knows; others are left as they are. */
export function applyRatings(rows: readonly MarketRow[], ratings: readonly Rating[]): MarketRow[] {
  const by = new Map(ratings.map((r) => [key(r.chain, r.address), r]));
  return rows.map((row) => {
    const r = by.get(key(row.chain, row.address));
    if (!r) return row;
    return {
      ...row,
      risk: r.status ? { status: r.status, label: RISK_LABELS[r.status] ?? r.status, score: r.score } : row.risk,
      lockedPct: row.lockedPct ?? r.lockedPct,
    };
  });
}

/** One request for the rows on screen. Any failure gives no ratings, and the table still shows. */
export async function fetchRatings(rows: readonly MarketRow[], fetchImpl: typeof fetch = (...a) => fetch(...a), signal?: AbortSignal): Promise<Rating[]> {
  const addresses = [...new Set(rows.map((r) => r.address))].slice(0, 80);
  if (addresses.length === 0) return [];
  try {
    const res = await fetchImpl(`/api/swings-tokens?addresses=${encodeURIComponent(addresses.join(','))}`, { signal });
    if (!res.ok) return [];
    const body = (await res.json()) as { ratings?: Rating[] };
    return Array.isArray(body.ratings) ? body.ratings.filter((r) => r && typeof r.address === 'string' && typeof r.chain === 'string') : [];
  } catch {
    return [];
  }
}
