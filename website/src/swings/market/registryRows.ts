/**
 * Find Tokens' rows: the tokens in Aretia's own registry of newly detected tokens, with market numbers added from
 * DexScreener (price, market cap, transactions, volume, the 5-minute to 24-hour changes). A token DexScreener has not
 * indexed yet still gets a row, from what the registry knows, with the missing numbers shown as dashes.
 */
import { chooseDexPair, type DexPair } from '../charts/dexscreener.js';
import { DEXSCREENER_CHAIN } from '../charts/pool.js';
import { ageInfo } from '../tokens/registry.js';
import { RISK_LABELS } from '../tokens/risk.js';
import type { ChainId, TokenRecord } from '../core/types.js';
import type { MarketRow } from './types.js';
import { isFresh, rowNumbers } from './snapshot.js';

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** One registry token as a row, using DexScreener's pairs for it when there are any. Pure. */
export function rowFromRecord(r: TokenRecord, pairs: unknown, now: number): MarketRow {
  // Aretia's own fresh snapshot wins: no outside request was needed for it.
  if (isFresh(r.market, now)) {
    const st = r.risk?.status ?? 'unknown';
    const nums = rowNumbers(r.market, r.firstPoolAt, now);
    return {
      chain: r.ref.chain, address: r.ref.address, symbol: r.symbol, quoteSymbol: '', name: r.name, icon: r.logo, decimals: r.decimals,
      ...nums, ageMs: nums.ageMs ?? ageInfo(r, now).ms, traders24h: null, risk: { status: st, label: RISK_LABELS[st], score: r.risk?.score ?? null }, fresh: true,
    };
  }
  const chosen = chooseDexPair(r.ref.chain, r.ref.address, pairs);
  const p: DexPair | null = chosen?.isBase ? chosen.p : null;
  const age = ageInfo(r, now);
  const st = r.risk?.status ?? 'unknown';
  const t = p?.txns?.h24;
  const created = typeof p?.pairCreatedAt === 'number' ? now - p.pairCreatedAt : null;
  const price = num(p?.priceUsd);
  return {
    chain: r.ref.chain,
    address: r.ref.address,
    symbol: r.symbol,
    quoteSymbol: p?.quoteToken?.symbol ? [...p.quoteToken.symbol].filter((c) => c.charCodeAt(0) > 31).join('').slice(0, 20) : '',
    name: r.name,
    icon: r.logo ?? (typeof p?.info?.imageUrl === 'string' && /^https:\/\//.test(p.info.imageUrl) ? p.info.imageUrl : null),
    decimals: r.decimals,
    pool: p?.pairAddress ?? r.pools[0]?.address ?? '',
    priceUsd: price !== null && price > 0 ? price : null,
    capUsd: num(p?.marketCap) ?? num(p?.fdv),
    ageMs: created !== null && created >= 0 ? created : age.ms,
    txns24h: typeof t?.buys === 'number' && typeof t?.sells === 'number' ? t.buys + t.sells : null,
    volume24hUsd: num(p?.volume?.h24) ?? r.volume24hUsd,
    traders24h: null,
    change: { m5: num(p?.priceChange?.m5), h1: num(p?.priceChange?.h1), h6: num(p?.priceChange?.h6), h24: num(p?.priceChange?.h24) },
    liquidityUsd: num(p?.liquidity?.usd) ?? r.liquidityUsd,
    risk: { status: st, label: RISK_LABELS[st], score: r.risk?.score ?? null },
    fresh: true,
  };
}

/** Adds market numbers to registry tokens, 30 tokens per DexScreener request. A failing request leaves those rows plain. */
export async function rowsFromRecords(records: readonly TokenRecord[], fetchImpl: typeof fetch = (...a) => fetch(...a), now: () => number = Date.now): Promise<MarketRow[]> {
  const byChain = new Map<ChainId, TokenRecord[]>();
  const stamp = now();
  // Only tokens without a fresh snapshot of Aretia's own are looked up outside.
  for (const r of records.filter((x) => !isFresh(x.market, stamp))) byChain.set(r.ref.chain, [...(byChain.get(r.ref.chain) ?? []), r]);
  const pairsFor = new Map<string, unknown[]>();
  await Promise.all(
    [...byChain].flatMap(([chain, list]) =>
      Array.from({ length: Math.ceil(list.length / 30) }, (_, i) => list.slice(i * 30, i * 30 + 30)).map(async (batch) => {
        try {
          const res = await fetchImpl(`https://api.dexscreener.com/tokens/v1/${DEXSCREENER_CHAIN[chain]}/${batch.map((r) => encodeURIComponent(r.ref.address)).join(',')}`, { headers: { accept: 'application/json' } });
          if (!res.ok) return;
          const body = (await res.json()) as unknown;
          if (Array.isArray(body)) for (const r of batch) pairsFor.set(`${chain}:${r.ref.address}`, body);
        } catch {
          // these rows keep only what the registry knows
        }
      }),
    ),
  );
  const t = now();
  return records.map((r) => rowFromRecord(r, pairsFor.get(`${r.ref.chain}:${r.ref.address}`) ?? [], t));
}
