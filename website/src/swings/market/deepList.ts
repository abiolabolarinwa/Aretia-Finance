/**
 * Deeper Markets lists. The market feed gives about 200 tokens in one answer; its busiest-pool lists go ten pages of 20 deep for
 * each network, so asking every network for those pages (through Aretia's own cached endpoint, never the feed directly) brings a
 * list to well over a thousand tokens. Pure apart from `fetch`; a page that fails is skipped and the rest are kept.
 */
import { CHAIN_IDS, type ChainId } from '../core/types.js';
import type { MarketRow } from './types.js';

export const DEEP_PAGES = 10;
const PAGE_ROWS = 20;
const TTL_MS = 10 * 60_000;
const CONCURRENCY = 2;
/** The source allows about 30 requests a minute for everyone, so a page it refuses is asked again in a later round. */
const ROUNDS = 8;
const ROUND_GAP_MS = 20_000;
const cache = new Map<string, { at: number; rows: MarketRow[] }>();

export function resetDeepList(): void {
  cache.clear();
}

export async function fetchDeepRows(
  chain: '' | ChainId,
  window: string,
  now: number,
  opts: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; pages?: number; onProgress?: (rows: MarketRow[]) => void; isCurrent?: () => boolean } = {},
): Promise<MarketRow[]> {
  const key = `${chain}|${window}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.rows;
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const pages = Math.min(opts.pages ?? DEEP_PAGES, DEEP_PAGES);
  const chains = chain ? [chain] : CHAIN_IDS;
  // One job per network and page. A short page ends that network's walk; a refused page is asked again in a later round.
  const rows: MarketRow[] = [];
  const done = new Set<ChainId>();
  let pending = chains.flatMap((c) => Array.from({ length: pages }, (_, i) => ({ c, page: i + 1 })));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let round = 0; round < ROUNDS && pending.length > 0 && opts.isCurrent?.() !== false; round++) {
    if (round > 0) await sleep(ROUND_GAP_MS);
    const queue = pending;
    const failed: typeof pending = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < queue.length && opts.isCurrent?.() !== false) {
        const job = queue[next++]!;
        if (done.has(job.c)) continue;
        try {
          const res = await fetchImpl(`/api/swings-market?kind=top&chain=${job.c}&window=${window}&page=${job.page}`);
          if (!res.ok) {
            failed.push(job);
            continue;
          }
          const body = (await res.json()) as { rows?: MarketRow[] };
          const got = Array.isArray(body.rows) ? body.rows : [];
          rows.push(...got);
          if (got.length < PAGE_ROWS / 2) done.add(job.c);
          opts.onProgress?.(rows);
        } catch {
          failed.push(job);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    pending = failed.filter((j) => !done.has(j.c));
  }
  const out = [...rows].sort((a, b) => (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1));
  if (out.length > 0 && opts.isCurrent?.() !== false) cache.set(key, { at: now, rows: out });
  return out;
}
