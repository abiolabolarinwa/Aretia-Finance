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
 * It is only a filter. If Jupiter cannot be reached the answer is null and the list is shown as it was, never emptied.
 */

export const TRADABLE_MIN_LIQUIDITY_USD = 1_000;
const ENDPOINT = 'https://lite-api.jup.ag/tokens/v2/search';
/** Mints per request (the service takes up to a hundred). */
const BATCH = 50;
const TTL_MS = 10 * 60_000;
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

function parse(v: unknown): { id: string; t: Tradable } | null {
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

/** A checker over Jupiter's token search. Verdicts are kept ten minutes; a failure pauses asking for a minute. */
export function jupiterCheck(fetchImpl: typeof fetch, now: () => number, signal?: AbortSignal): TradableCheck {
  return async (mints) => {
    const t0 = now();
    const need = [...new Set(mints)].filter((m) => !(known.get(m) && t0 - known.get(m)!.at < TTL_MS));
    if (need.length > 0) {
      if (t0 < pausedUntil) return null;
      try {
        for (let i = 0; i < need.length; i += BATCH) {
          const batch = need.slice(i, i + BATCH);
          const res = await fetchImpl(`${ENDPOINT}?query=${batch.join(',')}`, { signal, headers: { accept: 'application/json' } });
          if (!res.ok) throw new Error(`Jupiter answered ${res.status}.`);
          const body = (await res.json()) as unknown;
          if (!Array.isArray(body)) throw new Error('Jupiter answered something unexpected.');
          const got = new Map<string, Tradable>();
          for (const item of body) {
            const p = parse(item);
            if (p) got.set(p.id, p.t);
          }
          // A mint Jupiter does not return is one it cannot route: remembered as unknown, so it is not asked again for ten minutes.
          for (const m of batch) known.set(m, { at: t0, t: got.get(m) ?? null });
        }
      } catch {
        pausedUntil = t0 + FAILURE_PAUSE_MS;
        return null;
      }
      if (known.size > 5_000) for (const [k, v] of known) if (t0 - v.at >= TTL_MS) known.delete(k);
    }
    return new Map(mints.map((m) => [m, known.get(m)?.t ?? null]));
  };
}
