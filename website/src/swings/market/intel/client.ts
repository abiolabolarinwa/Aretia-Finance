/**
 * The page's read of the market intelligence endpoint (api/_swingsMarketIntel.ts). One request per network choice, kept for a minute; a failed
 * read gives what was kept, or nothing (and the cards then say "Insufficient market data", never a made-up figure).
 */
import type { IntelResult } from './compute.js';

export const INTEL_URL = '/api/swings-market?src=intel';
const TTL_MS = 60_000;
const kept = new Map<string, { at: number; result: IntelResult | null; running: Promise<IntelResult | null> | null }>();

export function resetIntelClient(): void {
  kept.clear();
}

/** The answer if it has the shape the page draws, else null. */
export function validIntel(v: unknown): IntelResult | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Partial<IntelResult>;
  if (typeof r.asOf !== 'number' || !r.ammi || !r.arf || !r.adv || !r.confidence) return null;
  if (!r.arf.h24 || !r.arf.h6 || !r.arf.h1 || !r.arf.m5 || !Array.isArray(r.adv.venues)) return null;
  return r as IntelResult;
}

/** What is kept for this network choice now (null before the first read). */
export function intelNow(chain: string): IntelResult | null {
  return kept.get(chain)?.result ?? null;
}

export function fetchMarketIntel(chain: string, now: number, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<IntelResult | null> {
  let e = kept.get(chain);
  if (!e) kept.set(chain, (e = { at: -Infinity, result: null, running: null }));
  if (e.running) return e.running;
  if (now - e.at < TTL_MS) return Promise.resolve(e.result);
  const entry = e;
  entry.running = (async (): Promise<IntelResult | null> => {
    try {
      const res = await fetchImpl(`${INTEL_URL}${chain ? `&chain=${encodeURIComponent(chain)}` : ''}`, { headers: { accept: 'application/json' } });
      if (res.ok) {
        const got = validIntel(await res.json());
        if (got) {
          entry.result = got;
          entry.at = now;
        }
      }
    } catch {
      // keep what was kept
    }
    entry.running = null;
    return entry.result;
  })();
  return entry.running;
}
