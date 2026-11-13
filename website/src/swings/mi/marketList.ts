/**
 * The Markets lists read straight from Aretia's own Market Indexer tables (mi_pools, mi_tokens), with real server-side paging.
 * Pure apart from the one `fetch` the reader makes; `api/_swingsMarketIndex.ts` adds the HTTP wrapper and the edge cache.
 *
 * Two ways of building a page, chosen by what the list ranks by:
 *  - SQL paging: new, by liquidity, top, and trending over 24 hours. The database orders (an existing index serves 24h volume and
 *    newest-first), cuts the page and counts the whole list, so any page of the whole list is reachable and the count is exact.
 *  - Candidate ranking: gainers, trending over 5 minutes / 1 hour / 6 hours, and a sort by price change. Those numbers live in the
 *    stats document, not in an indexed column, so the busiest CANDIDATE_CAP pools (by 24h volume) are read once, ranked here, and
 *    paged; the count says how many of those qualify.
 *
 * Rules that apply to every list (documented in docs/markets-from-index.md):
 *  - only active, unpaused pools whose liquidity is known in dollars and at least max(the chosen minimum, DUST_LIQUIDITY_USD);
 *  - trending, top and gainers need stored trades (vol24 > 0); a pool with liquidity only appears in New and By liquidity, with
 *    dashes for price change, volume and trades;
 *  - dropped as dead or unsafe-looking: price gone to nothing in every window (isDeadMarket), 20+ buys and no sell in 24 hours
 *    (nobody could sell: honeypot pattern), names the safe-text rules hide;
 *  - one row per token: the same token in several pools keeps its best-ranked pool.
 */
import { isBeyondCredible } from '../market/credible.js';
import type { MarketRow } from '../market/types.js';
import { isDeadMarket } from '../market/dead.js';
import { BULLISH_TEXT, isBullish } from '../market/bullish.js';
import { chainConfig, isMiChain, type MiChain } from './chains.js';
import { adapterById } from './dexes.js';
import { tokenDto } from './dto.js';
import { unitsToNumber } from './math.js';
import type { MiToken } from './types.js';

export type ListKind = 'trending' | 'top' | 'gainers' | 'new' | 'liquidity';
export type ListWindow = 'm5' | 'h1' | 'h6' | 'h24';
export type ListSort = 'rank' | 'liquidity' | 'volume' | 'new' | 'change';
export const LIST_KINDS: readonly ListKind[] = ['trending', 'top', 'gainers', 'new', 'liquidity'];
export const LIST_WINDOWS: readonly ListWindow[] = ['m5', 'h1', 'h6', 'h24'];
export const LIST_SORTS: readonly ListSort[] = ['rank', 'liquidity', 'volume', 'new', 'change'];
export const PAGE_SIZES: readonly number[] = [50, 100];
/** The deepest result reachable (page times size). */
export const MAX_RESULT = 10_000;
/** Pools below this liquidity are never listed: nobody can trade them in a meaningful size. */
export const DUST_LIQUIDITY_USD = 50;
/** Candidate ranking reads this many of the busiest pools. */
export const CANDIDATE_CAP = 600;
/** Honeypot pattern: this many buys in 24 hours and no sell at all. */
export const NO_SELL_BUYS = 20;
/** Gainers need a pool that has lived a little and traded a little (the same floors as the public API's gainers). */
export const GAINER_MIN_LIQUIDITY_USD = 1_000;
export const GAINER_MIN_TRADES = 5;
export const GAINER_MIN_AGE_MS = 10 * 60_000;

export interface ListQuery {
  kind: ListKind;
  chain: '' | MiChain;
  window: ListWindow;
  sort: ListSort;
  dir: 'asc' | 'desc';
  page: number;
  size: number;
  /** Dollars; 0 keeps every pool above the dust floor. */
  minLiquidityUsd: number;
  /** Only pools created within this many hours (0 = any age). */
  maxAgeHours: number;
  /** The "Bullish only" filter (market/bullish.ts): only rows that are up over both 1 hour and 24 hours, with enough trades, wallets and liquidity. */
  bullish?: boolean;
}

/** What a pool record holds after the narrow select (no whole stats document). */
export interface PoolRecord {
  key: string;
  chain: string;
  address: string;
  adapter_id: string;
  dex: string;
  base: string;
  quote: string;
  base_decimals: number | null;
  created_at: number | null;
  /** When the pool last traded (ms). The stored 24-hour figures are only as fresh as the last time they were computed, so this decides which windows are really empty. */
  last_trade_at?: number | null;
  liquidity_usd: number | null;
  vol24_usd: number | null;
  p_usd: number | null;
  rp?: number | null;
  chg: { m5: number | null; h1: number | null; h6: number | null; h24: number | null } | null;
  buys: Window4 | null;
  sells: Window4 | null;
  vol: { m5: number | null; h1: number | null; h6: number | null; h24: number | null } | null;
  ro: boolean | null;
  /** Distinct accounts that received the output of a swap in 24h (the index's best count of traders). */
  mk?: number | null;
  cp?: boolean | null;
}
interface Window4 {
  m5: number;
  h1: number;
  h6: number;
  h24: number;
}

/** How long each statistics window is, in ms. */
const WINDOW_MS: Record<ListWindow, number> = { m5: 300_000, h1: 3_600_000, h6: 21_600_000, h24: 86_400_000 };

/** Columns read from mi_pools and nothing else: the stats document is picked apart in the database, never sent whole. */
export const POOL_SELECT = 'key,chain,address,adapter_id,dex,base,quote,base_decimals,created_at,last_trade_at,liquidity_usd,vol24_usd,p_usd:stats->priceUsd,rp:stats->reservePriceUsd,chg:stats->change,buys:stats->buys,sells:stats->sells,vol:stats->volumeUsd,ro:stats->reservesOnly,mk:stats->makers24h,cp:stats->windowCapped';

const reservePrice = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = (bps: unknown): number | null => {
  const n = num(bps);
  return n === null ? null : n / 100;
};

/** True when the list ranks by something only the stats document holds, so it is built from the candidates. */
export function usesCandidates(q: ListQuery): boolean {
  if (q.kind === 'gainers' || q.sort === 'change' || q.bullish === true) return true;
  return q.kind === 'trending' && q.window !== 'h24';
}

/** The PostgREST filters every list shares. */
function baseFilters(q: ListQuery, now: number): string[] {
  const f = ['state=eq.active', 'paused=is.false'];
  if (q.chain) f.push(`chain=eq.${q.chain}`);
  f.push(`liquidity_usd=gte.${Math.max(q.minLiquidityUsd, DUST_LIQUIDITY_USD)}`);
  if (q.maxAgeHours > 0) f.push(`created_at=gte.${Math.floor(now - q.maxAgeHours * 3_600_000)}`);
  // Lists ranked by what traded in the last day hold only pools that did trade in it: a pool's stored 24-hour figures stay as they were
  // computed until it is next refreshed, so a pool that went quiet days ago would otherwise keep its old volume and sit at the top.
  if (q.kind === 'trending' || q.kind === 'top' || q.kind === 'gainers' || usesCandidates(q)) f.push('vol24_usd=gt.0', `last_trade_at=gte.${Math.floor(now - WINDOW_MS.h24)}`);
  return f;
}

/** The path (after /rest/v1/) for one SQL-paged list. The count comes back in the Content-Range header. */
export function sqlPath(q: ListQuery, now: number): string {
  const dir = q.sort === 'rank' ? undefined : q.dir;
  let order: string;
  if (q.sort === 'liquidity' || (q.sort === 'rank' && q.kind === 'liquidity')) order = `liquidity_usd.${dir ?? 'desc'}.nullslast,key.desc`;
  else if (q.sort === 'new' || (q.sort === 'rank' && q.kind === 'new')) order = `created_at.${dir ?? 'desc'}.nullslast,key.desc`;
  else order = `vol24_usd.${dir ?? 'desc'}.nullslast,key.desc`;
  return `mi_pools?select=${POOL_SELECT}&${baseFilters(q, now).join('&')}&order=${order}&limit=${q.size}&offset=${(q.page - 1) * q.size}`;
}

/** The path that reads the candidates for a ranked list (the busiest pools by 24h volume). */
export function candidatePath(q: ListQuery, now: number): string {
  return `mi_pools?select=${POOL_SELECT}&${baseFilters({ ...q, kind: 'top' }, now).join('&')}&order=vol24_usd.desc.nullslast,key.desc&limit=${CANDIDATE_CAP}`;
}

export function tokenPath(keys: readonly string[], withSupply = false): string {
  const list = keys.map((k) => `"${k.replace(/[^A-Za-z0-9:._-]/g, '')}"`).join(',');
  return `mi_tokens?key=in.(${list})&select=key,symbol,name,decimals${withSupply ? ',total_supply' : ''}&limit=${keys.length}`;
}

/** The most a fully diluted value may be to be shown: a larger one comes from a price or supply that cannot be trusted. */
export const FDV_MAX_USD = 1e12;

/** Price x total supply, in dollars; null when either is unknown or the result is not plausible. This is a fully diluted value, never a market cap. */
export function fdvOf(priceUsd: number | null, supply: string | null | undefined, decimals: number | null): number | null {
  if (priceUsd === null || !(priceUsd > 0) || decimals === null || typeof supply !== 'string' || !/^[0-9]{1,78}$/.test(supply)) return null;
  const v = priceUsd * unitsToNumber(BigInt(supply), decimals);
  return Number.isFinite(v) && v > 0 && v <= FDV_MAX_USD ? v : null;
}

type TokenInfo = Pick<MiToken, 'symbol' | 'name' | 'decimals'> & { total_supply?: string | null };

/** A pool record as a Markets row. A number the index does not state stays null (drawn as a dash), never zero. */
export function rowFromRecord(p: PoolRecord, tokens: ReadonlyMap<string, TokenInfo>, now: number): MarketRow | null {
  if (!isMiChain(p.chain) || !p.base || !p.address) return null;
  const chain = p.chain;
  const cfg = chainConfig(chain);
  const base = tokens.get(`${chain}:${p.base}`);
  const quote = tokens.get(`${chain}:${p.quote}`);
  const baseDto = tokenDto(base ? { key: `${chain}:${p.base}`, chain, address: p.base, symbol: base.symbol, name: base.name, decimals: base.decimals, firstSeenAt: 0, firstTradeAt: null, launchboxKey: null } : undefined, p.base, p.base_decimals ?? 0);
  // A name the safe-text rules hide is hidden from every list.
  if (base && baseDto.symbol === '' && baseDto.name === '') return null;
  const traded = p.ro !== true && p.chg !== null && p.buys !== null && p.sells !== null;
  // A window that closed after the pool's last trade holds no trade, whatever the stored figures (computed earlier) still say.
  const last = num(p.last_trade_at);
  const quiet = (w: ListWindow): boolean => traded && last !== null && now - last >= WINDOW_MS[w];
  const sum = (w: ListWindow): number | null => (traded ? (quiet(w) ? 0 : p.buys![w] + p.sells![w]) : null);
  const win = (pick: (w: ListWindow) => number | null): { m5: number | null; h1: number | null; h6: number | null; h24: number | null } => ({ m5: pick('m5'), h1: pick('h1'), h6: pick('h6'), h24: pick('h24') });
  const quoteUsdRole = cfg.quoteTokens.some((q) => q.address === p.quote && q.role === 'usd');
  const created = num(p.created_at);
  const priceUsd = traded ? num(p.p_usd) : reservePrice(p.rp);
  const fdv = fdvOf(priceUsd, base?.total_supply, p.base_decimals ?? base?.decimals ?? null);
  return {
    chain,
    address: p.base,
    symbol: baseDto.symbol || p.base.slice(0, 6),
    quoteSymbol: quote?.symbol ?? cfg.quoteTokens.find((q) => q.address === p.quote)?.symbol ?? '',
    name: baseDto.name,
    icon: null,
    decimals: p.base_decimals,
    pool: p.address,
    // A pool with no stored trade shows the price read from its reserves, marked as such; a traded price is never replaced by it.
    priceUsd,
    ...(!traded && reservePrice(p.rp) !== null ? { priceFromReserves: true } : {}),
    capUsd: fdv,
    ...(fdv !== null ? { capIsFdv: true } : {}),
    ageMs: created !== null && created > 0 ? Math.max(0, now - created) : null,
    txns24h: sum('h24'),
    ...(p.cp === true ? { txnsCapped: true } : {}),
    volume24hUsd: traded ? (quiet('h24') ? 0 : num(p.vol?.h24)) : null,
    traders24h: traded && !quiet('h24') ? num(p.mk) : null,
    volumeUsd: win((w) => (traded ? (quiet(w) ? 0 : num(p.vol?.[w])) : null)),
    txns: win(sum),
    change: win((w) => (traded && !quiet(w) ? pct(p.chg?.[w]) : null)),
    liquidityUsd: num(p.liquidity_usd),
    risk: null,
    fresh: false,
    indexed: { quoteIsDollar: quoteUsdRole, evidence: adapterById(p.adapter_id)?.evidence ?? 'planned' },
    source: 'index',
    venue: adapterById(p.adapter_id)?.name ?? p.dex,
  };
}

/** True for a row that should never be listed: a price gone to nothing, or the pattern of a token nobody can sell. */
export function isUnsafeLooking(r: MarketRow, p: PoolRecord): boolean {
  if (isDeadMarket(r)) return true;
  return p.ro !== true && p.buys !== null && p.sells !== null && p.buys.h24 >= NO_SELL_BUYS && p.sells.h24 === 0;
}

const tokenKey = (r: MarketRow): string => `${r.chain}:${r.chain === 'solana' ? r.address : r.address.toLowerCase()}`;

/** One row per token, in the order given: the first (best-ranked) pool of a token stays. */
export function dedupeTokens<T extends { row: MarketRow }>(list: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of list) {
    const k = tokenKey(x.row);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/** The value a candidate list ranks by, or null when the pool has no such number (it then goes last, and out of gainers). */
function merit(q: ListQuery, r: MarketRow): number | null {
  if (q.sort === 'liquidity') return r.liquidityUsd;
  if (q.sort === 'new') return r.ageMs === null ? null : -r.ageMs;
  if (q.sort === 'volume') return r.volumeUsd?.[q.window] ?? null;
  if (q.sort === 'change' || q.kind === 'gainers') return r.change[q.window];
  return r.volumeUsd?.[q.window] ?? null;
}

/** Ranks the candidates for a gainers / windowed-trending / change-sorted list. Pure. */
export function rankCandidates(q: ListQuery, rows: readonly { row: MarketRow; rec: PoolRecord }[]): { row: MarketRow; rec: PoolRecord }[] {
  let kept = rows.filter((x) => !isUnsafeLooking(x.row, x.rec));
  if (q.bullish) kept = kept.filter((x) => isBullish(x.row));
  if (q.kind === 'gainers') {
    kept = kept.filter((x) => {
      const c = x.row.change[q.window];
      return c !== null && c > 0 && !isBeyondCredible(c) && (x.row.liquidityUsd ?? 0) >= GAINER_MIN_LIQUIDITY_USD && (x.row.txns24h ?? 0) >= GAINER_MIN_TRADES && (x.row.ageMs ?? 0) >= GAINER_MIN_AGE_MS;
    });
  } else if (q.kind === 'trending') {
    kept = kept.filter((x) => (x.row.volumeUsd?.[q.window] ?? 0) > 0);
  }
  const sign = q.sort !== 'rank' && q.dir === 'asc' ? 1 : -1;
  const ordered = kept
    .map((x, i) => ({ x, i, v: merit(q, x.row) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      return (a.v - b.v) * sign || a.i - b.i;
    })
    .map((o) => o.x);
  return dedupeTokens(ordered.map((x) => ({ ...x, row: x.row }))) as { row: MarketRow; rec: PoolRecord }[];
}

export interface ListAnswer {
  rows: MarketRow[];
  /** Pools in the whole list (every page). */
  total: number;
  page: number;
  size: number;
  pages: number;
  /** For a candidate-ranked list: the busiest pools it was ranked among. Absent for SQL paging. */
  rankedAmong?: number;
  /** A one-line reason this list is shorter than the others, for the page to show. */
  note: string;
}

export interface Reader {
  /** GET a PostgREST path; returns the parsed rows and the Content-Range total when asked for. */
  get(path: string, wantCount: boolean): Promise<{ rows: unknown[]; total: number | null }>;
}

/** The note a tab shows when it has fewer rows than the others, in words. */
export function listNote(q: ListQuery, total: number, rankedAmong?: number): string {
  if (q.bullish) return `${BULLISH_TEXT} Among the ${rankedAmong ?? total} busiest pools, ${total} fit.`;
  const floor = `$${Math.max(q.minLiquidityUsd, DUST_LIQUIDITY_USD).toLocaleString('en-US')}`;
  const liq = `Pools with under ${floor} of liquidity, or none known in dollars, are left out.`;
  if (q.kind === 'new') return `${liq} Newest pools first, including pools with liquidity but no trade yet (their price change, volume and trades show a dash).`;
  if (q.kind === 'liquidity') return `${liq} Largest pools first, including pools with no trade yet (shown with a dash where the index has no number).`;
  const trades = 'Only pools with a stored trade in the last 24 hours are ranked here; pools with liquidity but no trade are in New and By liquidity.';
  if (q.kind === 'gainers') return `${trades} Gainers also need ${'$' + GAINER_MIN_LIQUIDITY_USD.toLocaleString('en-US')}+ of liquidity, ${GAINER_MIN_TRADES}+ trades and a pool older than 10 minutes. ${total} of the ${rankedAmong ?? total} busiest pools are up in this window. ${liq}`;
  if (q.kind === 'trending' && rankedAmong !== undefined) return `${trades} Ranked among the ${rankedAmong} busiest pools. ${liq}`;
  return `${trades} ${liq}`;
}

let supplyColumnMissingUntil = 0;
/** Test hook. */
export const resetSupplyColumnMemory = (): void => {
  supplyColumnMissingUntil = 0;
};

export async function readList(reader: Reader, q: ListQuery, now: number): Promise<ListAnswer> {
  const wrap = (rows: MarketRow[], total: number, rankedAmong?: number): ListAnswer => ({ rows, total, page: q.page, size: q.size, pages: Math.max(1, Math.ceil(total / q.size)), ...(rankedAmong === undefined ? {} : { rankedAmong }), note: listNote(q, total, rankedAmong) });
  const toRows = async (records: PoolRecord[]): Promise<{ row: MarketRow; rec: PoolRecord }[]> => {
    const keys = new Set<string>();
    for (const p of records) {
      keys.add(`${p.chain}:${p.base}`);
      keys.add(`${p.chain}:${p.quote}`);
    }
    const tokens = new Map<string, TokenInfo>();
    const all = [...keys];
    for (let i = 0; i < all.length; i += 50) {
      let got: { rows: unknown[] };
      if (supplyColumnMissingUntil > now) got = await reader.get(tokenPath(all.slice(i, i + 50)), false);
      else {
        try {
          got = await reader.get(tokenPath(all.slice(i, i + 50), true), false);
        } catch {
          // The database has not got the supply column yet (migration 0022 not applied): list without market caps, and do not ask again for a while.
          supplyColumnMissingUntil = now + 300_000;
          got = await reader.get(tokenPath(all.slice(i, i + 50)), false);
        }
      }
      for (const t of got.rows as { key: string; symbol: string; name: string; decimals: number; total_supply?: string | null }[]) tokens.set(t.key, t);
    }
    const out: { row: MarketRow; rec: PoolRecord }[] = [];
    for (const rec of records) {
      const row = rowFromRecord(rec, tokens, now);
      if (row) out.push({ row, rec });
    }
    return out;
  };
  if (usesCandidates(q)) {
    const got = await reader.get(candidatePath(q, now), false);
    const ranked = rankCandidates(q, await toRows(got.rows as PoolRecord[]));
    const start = (q.page - 1) * q.size;
    return wrap(ranked.slice(start, start + q.size).map((x) => x.row), ranked.length, got.rows.length);
  }
  const got = await reader.get(sqlPath(q, now), true);
  const built = await toRows(got.rows as PoolRecord[]);
  // The page keeps the order the database gave it; unsafe-looking and repeated tokens are dropped from it.
  const safe = dedupeTokens(built.filter((x) => !isUnsafeLooking(x.row, x.rec)));
  return wrap(safe.map((x) => x.row), got.total ?? safe.length);
}

/** A Reader over PostgREST (the Market Indexer's database). */
export function postgrestReader(base: string, headers: Record<string, string>, fetchImpl: typeof fetch, signal?: AbortSignal): Reader {
  return {
    async get(path, wantCount) {
      const res = await fetchImpl(`${base.replace(/\/$/, '')}/rest/v1/${path}`, { signal, headers: { ...headers, accept: 'application/json', ...(wantCount ? { prefer: 'count=exact' } : {}) } });
      if (!res.ok) throw new Error(`The Market Indexer database answered ${res.status}.`);
      const rows = (await res.json()) as unknown[];
      const total = wantCount ? /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] : undefined;
      return { rows: Array.isArray(rows) ? rows : [], total: total ? Number(total) : null };
    },
  };
}
