/**
 * Market cap for the cards that the index could not give one.
 *
 * Aretia's own market cap is price times a token's total supply, read from the chain by the indexer. When that read fails (a node that refuses
 * requests, a token just found), the card has no market cap. DexScreener reports a market cap, or a fully diluted value, for most listed tokens
 * and needs no key and none of Aretia's nodes, so a card without one asks it, 30 tokens to a request, only for the cards on screen. What it
 * answers is kept for ten minutes (a miss for two), and a refusal (too many requests) pauses the asking for twenty seconds.
 */
import type { ChainId } from '../swings/core/types.js';
import { DEXSCREENER_CHAIN } from '../swings/charts/pool.js';
import type { MarketRow } from '../swings/market/types.js';

export interface CapFill {
  capUsd: number;
  /** True when the figure is a fully diluted value (the source had no market cap). */
  isFdv: boolean;
}

const BATCH = 30;
const HIT_MS = 600_000;
const MISS_MS = 120_000;
const PAUSE_MS = 20_000;
const CONCURRENCY = 3;
/** Above this a figure is not believed (the same limit the list uses for a fully diluted value). */
const MAX_CAP = 1e12;

const keyOf = (chain: ChainId, address: string): string => `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`;
const cache = new Map<string, { at: number; v: CapFill | null }>();
const pausedUntil = new Map<ChainId, number>();

/** For tests. */
export function resetCapCache(): void {
  cache.clear();
  pausedUntil.clear();
}

/** The market cap known for a row from an earlier answer, when the row has none of its own. */
export function knownCap(r: Pick<MarketRow, 'chain' | 'address' | 'capUsd'>, now: number = Date.now()): CapFill | null {
  if (r.capUsd !== null && r.capUsd !== undefined) return null;
  const hit = cache.get(keyOf(r.chain, r.address));
  return hit && hit.v && now - hit.at < HIT_MS ? hit.v : null;
}

interface PairLike {
  baseToken?: { address?: unknown };
  liquidity?: { usd?: unknown };
  marketCap?: unknown;
  fdv?: unknown;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_CAP ? v : null);

/** From DexScreener's pairs, the cap of each wanted token (lower-case address for the EVM networks), taken from the pair holding the most liquidity. */
export function capsFromPairs(pairs: unknown, chain: ChainId): Map<string, CapFill> {
  const best = new Map<string, { liq: number; v: CapFill }>();
  if (!Array.isArray(pairs)) return new Map();
  for (const raw of pairs as PairLike[]) {
    const addr = typeof raw?.baseToken?.address === 'string' ? raw.baseToken.address : null;
    if (!addr) continue;
    const cap = num(raw.marketCap);
    const fdv = num(raw.fdv);
    const v: CapFill | null = cap !== null ? { capUsd: cap, isFdv: false } : fdv !== null ? { capUsd: fdv, isFdv: true } : null;
    if (!v) continue;
    const liq = typeof raw.liquidity?.usd === 'number' && Number.isFinite(raw.liquidity.usd) ? raw.liquidity.usd : 0;
    const k = chain === 'solana' ? addr : addr.toLowerCase();
    const have = best.get(k);
    if (!have || liq > have.liq) best.set(k, { liq, v });
  }
  return new Map([...best].map(([k, x]) => [k, x.v]));
}

export interface CapDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Asks for the market cap of the rows that have none. Resolves with the caps found, by row key (`chain:address`); never throws. Rows already
 * answered (or missed) recently are not asked again.
 */
export async function fetchMissingCaps(rows: readonly Pick<MarketRow, 'chain' | 'address' | 'capUsd'>[], deps: CapDeps = {}): Promise<Map<string, CapFill>> {
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = deps.now ?? Date.now;
  const found = new Map<string, CapFill>();
  const need = new Map<ChainId, Set<string>>();
  for (const r of rows) {
    if (r.capUsd !== null && r.capUsd !== undefined) continue;
    const k = keyOf(r.chain, r.address);
    const hit = cache.get(k);
    if (hit && now() - hit.at < (hit.v ? HIT_MS : MISS_MS)) {
      if (hit.v) found.set(k, hit.v);
      continue;
    }
    if ((pausedUntil.get(r.chain) ?? 0) > now() || !DEXSCREENER_CHAIN[r.chain]) continue;
    need.set(r.chain, (need.get(r.chain) ?? new Set<string>()).add(r.address));
  }
  const jobs: { chain: ChainId; batch: string[] }[] = [];
  for (const [chain, set] of need) {
    const list = [...set];
    for (let i = 0; i < list.length; i += BATCH) jobs.push({ chain, batch: list.slice(i, i + BATCH) });
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = jobs[next++];
      if (!job) return;
      try {
        const res = await fetchImpl(`https://api.dexscreener.com/tokens/v1/${DEXSCREENER_CHAIN[job.chain]}/${job.batch.map(encodeURIComponent).join(',')}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) {
          if (res.status === 429) pausedUntil.set(job.chain, now() + PAUSE_MS);
          continue;
        }
        const caps = capsFromPairs(await res.json().catch(() => null), job.chain);
        const at = now();
        for (const address of job.batch) {
          const k = keyOf(job.chain, address);
          const v = caps.get(job.chain === 'solana' ? address : address.toLowerCase()) ?? null;
          cache.set(k, { at, v });
          if (v) found.set(k, v);
        }
      } catch {
        // These cards keep their dash; the next look asks again.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  return found;
}
