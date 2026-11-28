/**
 * Tokens this person opened recently (their token page in Markets), kept in this browser only, newest first, at most ten. The search box
 * shows them when it opens empty, so going back to a token is one tap.
 */
import { CHAINS, type ChainId } from '../swings/core/types.js';

export interface RecentToken {
  chain: ChainId;
  address: string;
  symbol: string;
  name: string;
  icon: string | null;
}

export const RECENT_KEY = 'aretia.recent-tokens';
export const MAX_RECENT = 10;

interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const store = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? [...v].filter((c) => c.charCodeAt(0) > 31).join('').slice(0, max) : '');

/** The saved list, with anything malformed dropped. */
export function loadRecent(s: Store | null = store()): RecentToken[] {
  if (!s) return [];
  try {
    const raw: unknown = JSON.parse(s.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    const out: RecentToken[] = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      const chain = o.chain as ChainId;
      const address = clean(o.address, 64);
      if (!(chain in CHAINS) || !/^[A-Za-z0-9]{20,64}$/.test(address)) continue;
      const icon = clean(o.icon, 400);
      out.push({ chain, address, symbol: clean(o.symbol, 24) || '?', name: clean(o.name, 64), icon: /^https:\/\//.test(icon) ? icon : null });
    }
    return out.slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/** Puts a token at the top of the list (moving it if it was there already). */
export function rememberToken(t: RecentToken, s: Store | null = store()): RecentToken[] {
  const same = (r: RecentToken): boolean => r.chain === t.chain && r.address.toLowerCase() === t.address.toLowerCase();
  const list = [t, ...loadRecent(s).filter((r) => !same(r))].slice(0, MAX_RECENT);
  try {
    s?.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Storage full or blocked: the list simply is not kept.
  }
  return list;
}

export function clearRecent(s: Store | null = store()): void {
  try {
    s?.removeItem(RECENT_KEY);
  } catch {
    // Nothing to clear.
  }
}
