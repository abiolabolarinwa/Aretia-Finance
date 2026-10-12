/**
 * Pool hints for the Solana venues that cannot derive a token's pool from its address: Aretia's own scan first
 * (/api/swings-pools, read from the chain), then DexScreener only when that gives nothing. Either way the venue adapter
 * checks every address on-chain before using it.
 */
const MAX_CANDIDATES = 8;

/** Candidate pool addresses for a token, from DexScreener. Unverified: every one is checked on-chain before use. */
export type PoolHints = (mint: string) => Promise<string[]>;

export function dexScreenerPoolHints(fetchImpl: typeof fetch = (...a) => fetch(...a)): PoolHints {
  return async (mint) => {
    try {
      const res = await fetchImpl(`https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(mint)}`, { headers: { accept: 'application/json' } });
      if (!res.ok) return [];
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return [];
      const out: string[] = [];
      for (const p of body) {
        const a = (p as { pairAddress?: unknown }).pairAddress;
        if (typeof a === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && !out.includes(a)) out.push(a);
        if (out.length >= MAX_CANDIDATES) break;
      }
      return out;
    } catch {
      return [];
    }
  };
}

export function aretiaPoolHints(fetchImpl: typeof fetch = (...a) => fetch(...a), fallback: PoolHints = dexScreenerPoolHints(fetchImpl)): PoolHints {
  return async (mint) => {
    try {
      const res = await fetchImpl(`/api/swings-pools?mint=${encodeURIComponent(mint)}`);
      if (res.ok) {
        const body = (await res.json()) as { pools?: unknown };
        const pools = Array.isArray(body.pools) ? body.pools.filter((p): p is string => typeof p === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p)) : [];
        if (pools.length > 0) return pools.slice(0, 8);
      }
    } catch {
      // not reachable (a script, an offline page): fall through to the outside source
    }
    return fallback(mint);
  };
}
