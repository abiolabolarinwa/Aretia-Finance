/**
 * Deeper Markets lists. The market feed gives about 200 tokens in one answer; its busiest-pool lists go ten pages of 20 deep
 * for each network, so asking every network for those pages (through Aretia's own cached endpoint, never the feed directly)
 * brings a list to about a thousand tokens. Pure apart from `fetch`; a page that fails is asked again in a later round.
 *
 * The walk takes a minute or two, so it belongs to the page, not to one drawing of the list: one walk runs at a time per
 * network choice, keeps what it has read so far (`deepSnapshot`), and carries on while the list on screen refreshes.
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

interface Entry {
  rows: MarketRow[];
  /** When the last walk finished; minus infinity while none has. */
  at: number;
  running: Promise<MarketRow[]> | null;
  listeners: Set<(rows: MarketRow[]) => void>;
}
const entries = new Map<string, Entry>();

const byVolume = (a: MarketRow, b: MarketRow): number => (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1);

export function resetDeepList(): void {
  entries.clear();
}

/** What the walk for this network choice has read so far (empty before it starts). */
export function deepSnapshot(chain: '' | ChainId): MarketRow[] {
  return entries.get(chain)?.rows ?? [];
}

export function fetchDeepRows(
  chain: '' | ChainId,
  now: number,
  opts: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; pages?: number; onProgress?: (rows: MarketRow[]) => void } = {},
): Promise<MarketRow[]> {
  let entry = entries.get(chain);
  if (!entry) entries.set(chain, (entry = { rows: [], at: -Infinity, running: null, listeners: new Set() }));
  if (opts.onProgress) entry.listeners.add(opts.onProgress);
  if (entry.running) return entry.running;
  if (now - entry.at < TTL_MS) return Promise.resolve(entry.rows);
  const e = entry;
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pages = Math.min(opts.pages ?? DEEP_PAGES, DEEP_PAGES);
  const chains = chain ? [chain] : CHAIN_IDS;
  e.running = (async (): Promise<MarketRow[]> => {
    const rows: MarketRow[] = [];
    const done = new Set<ChainId>();
    let pending = chains.flatMap((c) => Array.from({ length: pages }, (_, i) => ({ c, page: i + 1 })));
    for (let round = 0; round < ROUNDS && pending.length > 0; round++) {
      if (round > 0) await sleep(ROUND_GAP_MS);
      const queue = pending;
      const failed: typeof pending = [];
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < queue.length) {
          const job = queue[next++]!;
          if (done.has(job.c)) continue;
          try {
            const res = await fetchImpl(`/api/swings-market?kind=top&chain=${job.c}&window=h24&page=${job.page}`);
            if (!res.ok) {
              failed.push(job);
              continue;
            }
            const body = (await res.json()) as { rows?: MarketRow[] };
            const got = Array.isArray(body.rows) ? body.rows : [];
            rows.push(...got);
            if (got.length < PAGE_ROWS / 2) done.add(job.c);
            e.rows = [...rows].sort(byVolume);
            for (const fn of e.listeners) fn(e.rows);
          } catch {
            failed.push(job);
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      pending = failed.filter((j) => !done.has(j.c));
    }
    if (e.rows.length > 0) e.at = now;
    e.listeners.clear();
    e.running = null;
    return e.rows;
  })();
  return e.running;
}
