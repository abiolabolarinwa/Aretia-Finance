/**
 * Everything the token page's info panel shows about one trading pair: prices, liquidity, value, the changes over four
 * windows, buys and sells, volume and the project's own links. Read from DexScreener's pair service, one pair at a time.
 * Anything the service does not report stays null, never zero. Only https links are ever kept.
 */
import { SwingsError, type ChainId } from '../core/types.js';
import { DEXSCREENER_CHAIN } from './pool.js';

export type Win = 'm5' | 'h1' | 'h6' | 'h24';

export interface PairDetail {
  pair: string;
  dex: string | null;
  baseSymbol: string;
  quoteSymbol: string;
  name: string;
  icon: string | null;
  priceUsd: number | null;
  priceNative: number | null;
  liquidityUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  change: Record<Win, number | null>;
  buys: Record<Win, number | null>;
  sells: Record<Win, number | null>;
  volumeUsd: Record<Win, number | null>;
  /** Pair age in milliseconds. */
  ageMs: number | null;
  links: { label: string; url: string }[];
}

const WINS: Win[] = ['m5', 'h1', 'h6', 'h24'];
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const text = (v: unknown, max: number): string => (typeof v === 'string' ? [...v].filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127).join('').trim().slice(0, max) : '');
const httpsOnly = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 300) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
};
const byWindow = <T>(read: (w: Win) => T): Record<Win, T> => ({ m5: read('m5'), h1: read('h1'), h6: read('h6'), h24: read('h24') });

interface RawPair {
  dexId?: string;
  pairAddress?: string;
  baseToken?: { symbol?: string; name?: string };
  quoteToken?: { symbol?: string };
  priceUsd?: string | number;
  priceNative?: string | number;
  liquidity?: { usd?: number | string };
  fdv?: number | string;
  marketCap?: number | string;
  priceChange?: Partial<Record<Win, number | string>>;
  txns?: Partial<Record<Win, { buys?: number; sells?: number }>>;
  volume?: Partial<Record<Win, number | string>>;
  pairCreatedAt?: number;
  info?: { imageUrl?: string; websites?: { label?: string; url?: string }[]; socials?: { type?: string; url?: string }[] };
}

/** Reads DexScreener's answer for one pair. Pure. */
export function parsePairDetail(body: unknown, now: number): PairDetail | null {
  const p = (body as { pairs?: RawPair[] } | null)?.pairs?.[0];
  if (!p || typeof p.pairAddress !== 'string' || !p.baseToken || !p.quoteToken) return null;
  const links: PairDetail['links'] = [];
  for (const w of p.info?.websites ?? []) {
    const url = httpsOnly(w.url);
    if (url) links.push({ label: text(w.label, 20) || 'Website', url });
  }
  for (const s of p.info?.socials ?? []) {
    const url = httpsOnly(s.url);
    const type = text(s.type, 20);
    if (url && type) links.push({ label: type.charAt(0).toUpperCase() + type.slice(1), url });
  }
  const price = num(p.priceUsd);
  const image = p.info?.imageUrl;
  return {
    pair: p.pairAddress,
    dex: text(p.dexId, 30) || null,
    baseSymbol: text(p.baseToken.symbol, 20) || 'Token',
    quoteSymbol: text(p.quoteToken.symbol, 20) || 'Token',
    name: text(p.baseToken.name, 60),
    icon: typeof image === 'string' && /^https:\/\//.test(image) ? image : null,
    priceUsd: price !== null && price > 0 ? price : null,
    priceNative: num(p.priceNative),
    liquidityUsd: num(p.liquidity?.usd),
    fdvUsd: num(p.fdv),
    marketCapUsd: num(p.marketCap),
    change: byWindow((w) => num(p.priceChange?.[w])),
    buys: byWindow((w) => (typeof p.txns?.[w]?.buys === 'number' ? p.txns[w]!.buys! : null)),
    sells: byWindow((w) => (typeof p.txns?.[w]?.sells === 'number' ? p.txns[w]!.sells! : null)),
    volumeUsd: byWindow((w) => num(p.volume?.[w])),
    ageMs: typeof p.pairCreatedAt === 'number' && p.pairCreatedAt <= now ? now - p.pairCreatedAt : null,
    links: links.slice(0, 8),
  };
}

export async function fetchPairDetail(chain: ChainId, pair: string, fetchImpl: typeof fetch = (...a) => fetch(...a), now: () => number = Date.now, signal?: AbortSignal): Promise<PairDetail> {
  if (!/^[A-Za-z0-9]{20,}$/.test(pair)) throw new SwingsError('invalid', 'That is not a valid pool address.');
  let res: Response;
  try {
    res = await fetchImpl(`https://api.dexscreener.com/latest/dex/pairs/${DEXSCREENER_CHAIN[chain]}/${encodeURIComponent(pair)}`, { headers: { accept: 'application/json' }, signal });
  } catch {
    throw new SwingsError('provider-failed', 'The price service could not be reached. It may be busy; try again in a minute.');
  }
  if (!res.ok) throw new SwingsError('provider-failed', res.status === 429 ? 'The price service is busy. Try again in a minute.' : `The price service answered ${res.status}.`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SwingsError('provider-failed', 'The price service returned something unreadable.');
  }
  const d = parsePairDetail(body, now());
  if (!d) throw new SwingsError('no-route', 'No details were found for this pool.');
  return d;
}

export const WINDOWS: readonly Win[] = WINS;
