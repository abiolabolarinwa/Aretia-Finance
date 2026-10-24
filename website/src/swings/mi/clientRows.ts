/**
 * Turns the Market Indexer's API answers into the rows and trades the wallet's existing tables already draw. Pure. Nothing is
 * invented: a number the index does not state stays null and is drawn as a dash.
 */
import type { MarketRow } from '../market/types.js';
import type { Trade } from '../charts/trades.js';
import type { ChainId } from '../core/types.js';
import type { PoolDto } from './dto.js';
import { formatUnits, parseRaw } from './math.js';

/** An EVM address (lower-case) or a Solana public key (base58, case-sensitive). */
const ADDRESS = /^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
/** An EVM transaction hash or a Solana signature. */
const TX_ID = /^(0x[0-9a-f]{64}|[1-9A-HJ-NP-Za-km-z]{64,100})$/;
const ago = (iso: string, now: number): number | null => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, now - t) : null;
};
const sum = (w: { m5: number; h1: number; h6: number; h24: number } | null | undefined): number | null => (w ? w.h24 : null);

/** Market rows for the Aretia Index lists. Entries that are not well-formed are dropped. */
export function marketRowsFromPools(list: unknown, now: number): MarketRow[] {
  if (!Array.isArray(list)) return [];
  const rows: MarketRow[] = [];
  for (const raw of list) {
    const p = raw as PoolDto | null;
    if (!p || typeof p !== 'object' || !ADDRESS.test(p.address ?? '') || !ADDRESS.test(p.base?.address ?? '')) continue;
    const buys = sum(p.txns?.buys);
    const sells = sum(p.txns?.sells);
    rows.push({
      chain: p.chain as ChainId,
      address: p.base.address,
      symbol: p.base.symbol || p.base.address.slice(0, 6),
      quoteSymbol: p.quote.symbol,
      name: p.base.name,
      icon: null,
      decimals: p.base.decimals,
      pool: p.address,
      priceUsd: p.price?.usd ?? null,
      capUsd: null,
      ageMs: ago(p.createdAt, now),
      txns24h: buys !== null && sells !== null ? buys + sells : null,
      volume24hUsd: p.volume?.usd?.h24 ?? null,
      traders24h: null,
      change: { m5: p.changePct?.m5 ?? null, h1: p.changePct?.h1 ?? null, h6: p.changePct?.h6 ?? null, h24: p.changePct?.h24 ?? null },
      liquidityUsd: p.liquidity?.usd ?? null,
      risk: null,
      fresh: true,
      indexed: { quoteIsDollar: p.quoteIsDollar === true, evidence: p.evidence },
    });
  }
  return rows;
}

interface TradeAnswer {
  data?: { id: string; unix: number; side: string; price: string; baseAmount: string; quoteAmount: string; account: string }[];
  meta?: { baseDecimals?: number; quoteDecimals?: number };
}

/**
 * Trades of an indexed pool in the shape the Transactions table draws. Amounts are converted from raw integers with exact
 * decimal arithmetic; the dollar value and price are given only when the pool is quoted in a dollar stablecoin.
 */
export function tradesFromIndexed(body: unknown, quoteIsDollar: boolean): Trade[] {
  const a = body as TradeAnswer | null;
  if (!a || !Array.isArray(a.data) || typeof a.meta?.baseDecimals !== 'number' || typeof a.meta.quoteDecimals !== 'number') return [];
  const out: Trade[] = [];
  for (const t of a.data) {
    const base = parseRaw(t.baseAmount);
    const quote = parseRaw(t.quoteAmount);
    if (base === null || quote === null || (t.side !== 'buy' && t.side !== 'sell') || !Number.isFinite(t.unix) || !ADDRESS.test(t.account ?? '')) continue;
    const txHash = t.id.split(':')[0] ?? '';
    if (!TX_ID.test(txHash)) continue;
    const quoteAmount = Number(formatUnits(quote, a.meta.quoteDecimals));
    out.push({
      t: t.unix * 1000,
      kind: t.side,
      usd: quoteIsDollar ? quoteAmount : Number.NaN,
      tokenAmount: Number(formatUnits(base, a.meta.baseDecimals)),
      quoteAmount,
      priceUsd: quoteIsDollar && Number.isFinite(Number(t.price)) ? Number(t.price) : null,
      trader: t.account,
      tx: txHash,
    });
  }
  return out;
}

export async function fetchIndexedTrades(chain: string, pool: string, quoteIsDollar: boolean, fetchImpl: typeof fetch = (...a) => fetch(...a), signal?: AbortSignal): Promise<Trade[]> {
  const res = await fetchImpl(`/api/v1/pools/${chain}/${pool}/trades?limit=100`, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(res.status === 429 ? 'The index is busy. The trades will appear shortly.' : 'The trades could not be loaded.');
  return tradesFromIndexed(await res.json(), quoteIsDollar);
}

export async function fetchIndexedRows(kind: 'new' | 'trending', chain: string, now: number, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<MarketRow[]> {
  const q = new URLSearchParams({ limit: '100' });
  if (chain) q.set('chain', chain);
  const res = await fetchImpl(`/api/v1/pools/${kind}?${q}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(res.status === 503 ? 'Aretia’s market index is not set up yet.' : 'Aretia’s market index is unavailable right now.');
  const body = (await res.json()) as { data?: unknown };
  const list = kind === 'trending' ? (body.data as { ranked?: unknown } | undefined)?.ranked : body.data;
  return marketRowsFromPools(list, now);
}

/**
 * Puts the index's markets into a list that came from elsewhere. A market the index read from the chain replaces the same pool in
 * the other list (the index's chain facts win over an outside feed); markets only the index has are added. Pure.
 */
export function mergeIndexed(rows: readonly MarketRow[], indexed: readonly MarketRow[]): MarketRow[] {
  const poolKey = (r: MarketRow): string => `${r.chain}:${r.chain === 'solana' ? r.pool : r.pool.toLowerCase()}`;
  const tokenKey = (r: MarketRow): string => `${r.chain}:${r.chain === 'solana' ? r.address : r.address.toLowerCase()}`;
  const mine = indexed.filter((r) => r.pool);
  const pools = new Set(mine.map(poolKey));
  const tokens = new Set(mine.map(tokenKey));
  // The other list loses the pool the index also has, and the token too (the index's market for it is shown instead of a second row).
  const kept = rows.filter((r) => !(r.pool && pools.has(poolKey(r))) && !tokens.has(tokenKey(r)));
  return [...kept, ...mine];
}

/** The index's markets for a list, or none when the index is unreachable or not set up: the list then shows what it always did. */
export async function indexedForList(kind: 'new' | 'trending', chain: string, now: number, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<MarketRow[]> {
  try {
    return await fetchIndexedRows(kind, chain, now, fetchImpl);
  } catch {
    return [];
  }
}
