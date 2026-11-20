/**
 * Fresh prices for the cards on screen, asked for every second.
 *
 * Aretia's live stream sends a price when its indexer has seen a trade, which is fast on a quiet day and can lag when the indexer's node is slow or
 * refusing requests. To keep the board moving whatever the server is doing, the cards on screen are also asked of DexScreener once a second: 30 tokens
 * to a request, one request per network that has a card on screen, at most four at a time. The price comes from the pair holding the most liquidity,
 * with the 5-minute, 1-hour, 6-hour and 24-hour changes. A refusal (too many requests) pauses that network for 20 seconds, and a request that is still
 * running when the next second comes is not doubled up.
 */
import type { ChainId } from '../swings/core/types.js';
import { DEXSCREENER_CHAIN } from '../swings/charts/pool.js';

export interface LivePrice {
  priceUsd: number;
  change: { m5?: number; h1?: number; h6?: number; h24?: number };
}

const BATCH = 30;
const PAUSE_MS = 20_000;
const TIMEOUT_MS = 3500;
const keyOf = (chain: ChainId, address: string): string => `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`;
const pausedUntil = new Map<ChainId, number>();

/** For tests. */
export function resetPricePauses(): void {
  pausedUntil.clear();
}

interface PairLike {
  baseToken?: { address?: unknown };
  liquidity?: { usd?: unknown };
  priceUsd?: unknown;
  priceChange?: { m5?: unknown; h1?: unknown; h6?: unknown; h24?: unknown };
}

const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** From DexScreener's pairs, the price and changes of each token (by lower-case address on the EVM networks), from its most liquid pair. */
export function pricesFromPairs(pairs: unknown, chain: ChainId): Map<string, LivePrice> {
  const best = new Map<string, { liq: number; v: LivePrice }>();
  if (!Array.isArray(pairs)) return new Map();
  for (const raw of pairs as PairLike[]) {
    const addr = typeof raw?.baseToken?.address === 'string' ? raw.baseToken.address : null;
    const price = typeof raw?.priceUsd === 'string' || typeof raw?.priceUsd === 'number' ? Number(raw.priceUsd) : NaN;
    if (!addr || !Number.isFinite(price) || price <= 0) continue;
    const pc = raw.priceChange ?? {};
    const v: LivePrice = { priceUsd: price, change: {} };
    for (const k of ['m5', 'h1', 'h6', 'h24'] as const) {
      const n = finite(pc[k]);
      if (n !== undefined) v.change[k] = n;
    }
    const liq = finite(raw.liquidity?.usd) ?? 0;
    const k = chain === 'solana' ? addr : addr.toLowerCase();
    const have = best.get(k);
    if (!have || liq > have.liq) best.set(k, { liq, v });
  }
  return new Map([...best].map(([k, x]) => [k, x.v]));
}

export interface PriceDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Asks for the prices of these tokens. Resolves with what came back, by `chain:address`; never throws. */
export async function fetchLivePrices(tokens: readonly { chain: ChainId; address: string }[], deps: PriceDeps = {}): Promise<Map<string, LivePrice>> {
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = deps.now ?? Date.now;
  const out = new Map<string, LivePrice>();
  const byChain = new Map<ChainId, Set<string>>();
  for (const t of tokens) {
    if ((pausedUntil.get(t.chain) ?? 0) > now() || !DEXSCREENER_CHAIN[t.chain]) continue;
    byChain.set(t.chain, (byChain.get(t.chain) ?? new Set<string>()).add(t.address));
  }
  const jobs: { chain: ChainId; batch: string[] }[] = [];
  for (const [chain, set] of byChain) {
    const list = [...set];
    for (let i = 0; i < list.length; i += BATCH) jobs.push({ chain, batch: list.slice(i, i + BATCH) });
  }
  await Promise.all(
    jobs.map(async (job) => {
      try {
        const res = await fetchImpl(`https://api.dexscreener.com/tokens/v1/${DEXSCREENER_CHAIN[job.chain]}/${job.batch.map(encodeURIComponent).join(',')}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) {
          if (res.status === 429) pausedUntil.set(job.chain, now() + PAUSE_MS);
          return;
        }
        const got = pricesFromPairs(await res.json().catch(() => null), job.chain);
        for (const address of job.batch) {
          const v = got.get(job.chain === 'solana' ? address : address.toLowerCase());
          if (v) out.set(keyOf(job.chain, address), v);
        }
      } catch {
        // Nothing changes for these cards this second.
      }
    }),
  );
  return out;
}
