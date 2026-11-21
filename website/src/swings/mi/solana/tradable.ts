/**
 * "Can someone buy this right now?" for Solana tokens, answered from Jupiter, the router the wallet's swap uses.
 *
 * The index lists pools, and a pool is not the same as something buyable: a pool of a worthless token can claim millions of dollars of
 * liquidity it does not hold, a drained pool keeps its old volume, and a token whose issuer can freeze accounts can be bought but not sold.
 * Jupiter reads each token's real liquidity and audits its mint, so a token is shown as buyable only when Jupiter knows it and:
 *  - it holds at least TRADABLE_MIN_LIQUIDITY_USD of liquidity (a swap of a few dollars goes through);
 *  - Jupiter has not flagged it as suspicious;
 *  - its freeze authority is switched off (nobody can lock a buyer's tokens).
 * Nothing else is judged: no score and no popularity, because a token minutes old has neither.
 *
 * It is only a filter. Verdicts are kept ten minutes and an older one is used for up to six hours when Jupiter will not answer (the free
 * service allows only a few requests at a time). With no verdict at all and Jupiter unreachable the answer is null and the list is shown as it
 * was, never emptied. A free key from portal.jup.ag (the `JUPITER_API_KEY` setting) raises the limit.
 */

export const TRADABLE_MIN_LIQUIDITY_USD = 1_000;
const FREE_BASE = 'https://lite-api.jup.ag/tokens/v2';
const KEYED_BASE = 'https://api.jup.ag/tokens/v2';
/** Jupiter's token service: the keyed one when a key is set (Jupiter's current docs), the free one otherwise. */
export const jupiterEndpoint = (apiKey?: string): string => (apiKey?.trim() ? KEYED_BASE : FREE_BASE);
/** Mints per request (the service takes up to a hundred). */
const BATCH = 100;
const TTL_MS = 10 * 60_000;
const STALE_MS = 6 * 3_600_000;
const FAILURE_PAUSE_MS = 60_000;

export interface Tradable {
  liquidityUsd: number;
  suspicious: boolean;
  /** True when the token's freeze authority is off; null when Jupiter did not say. */
  freezeOff: boolean | null;
  holders: number | null;
}

/** What the list needs to ask: the verdict of each mint, or null when the service could not be reached. */
export type TradableCheck = (mints: readonly string[]) => Promise<Map<string, Tradable | null> | null>;

export function isBuyable(t: Tradable | null | undefined): boolean {
  return Boolean(t) && t!.liquidityUsd >= TRADABLE_MIN_LIQUIDITY_USD && !t!.suspicious && t!.freezeOff !== false;
}

const known = new Map<string, { at: number; t: Tradable | null }>();
let pausedUntil = 0;

export function resetTradableMemory(): void {
  known.clear();
  pausedUntil = 0;
}

export function parseToken(v: unknown): { id: string; t: Tradable } | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string') return null;
  const audit = (typeof o.audit === 'object' && o.audit !== null ? o.audit : {}) as Record<string, unknown>;
  return {
    id: o.id,
    t: {
      liquidityUsd: typeof o.liquidity === 'number' && Number.isFinite(o.liquidity) ? o.liquidity : 0,
      suspicious: audit.isSus === true,
      freezeOff: typeof audit.freezeAuthorityDisabled === 'boolean' ? audit.freezeAuthorityDisabled : null,
      holders: typeof o.holderCount === 'number' ? o.holderCount : null,
    },
  };
}

/** When Jupiter will not answer: what was learned before (up to six hours old) for the mints that have a verdict, or null when none has. */
function older(mints: readonly string[], t0: number): Map<string, Tradable | null> | null {
  const out = new Map<string, Tradable | null>();
  for (const m of mints) {
    const k = known.get(m);
    if (k && t0 - k.at < STALE_MS) out.set(m, k.t);
  }
  return out.size > 0 ? out : null;
}

/** A checker over Jupiter's token search. Verdicts are kept ten minutes; a failure pauses asking for a minute. */
export function jupiterCheck(fetchImpl: typeof fetch, now: () => number, signal?: AbortSignal, apiKey?: string): TradableCheck {
  return async (mints) => {
    const t0 = now();
    const need = [...new Set(mints)].filter((m) => !(known.get(m) && t0 - known.get(m)!.at < TTL_MS));
    if (need.length > 0) {
      if (t0 < pausedUntil) return older(mints, t0);
      try {
        for (let i = 0; i < need.length; i += BATCH) {
          const batch = need.slice(i, i + BATCH);
          const key = apiKey?.trim();
          const res = await fetchImpl(`${jupiterEndpoint(key)}/search?query=${batch.join(',')}`, { signal, headers: { accept: 'application/json', ...(key ? { 'x-api-key': key } : {}) } });
          if (!res.ok) throw new Error(`Jupiter answered ${res.status}.`);
          const body = (await res.json()) as unknown;
          if (!Array.isArray(body)) throw new Error('Jupiter answered something unexpected.');
          const got = new Map<string, Tradable>();
          for (const item of body) {
            const p = parseToken(item);
            if (p) got.set(p.id, p.t);
          }
          // A mint Jupiter does not return is one it cannot route: remembered as unknown, so it is not asked again for ten minutes.
          for (const m of batch) known.set(m, { at: t0, t: got.get(m) ?? null });
        }
      } catch {
        pausedUntil = t0 + FAILURE_PAUSE_MS;
        return older(mints, t0);
      }
      if (known.size > 5_000) for (const [k, v] of known) if (t0 - v.at >= STALE_MS) known.delete(k);
    }
    return new Map(mints.map((m) => [m, known.get(m)?.t ?? null]));
  };
}
