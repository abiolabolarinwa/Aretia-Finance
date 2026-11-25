/**
 * The market part of the scheduled alert check (GET /api/swings-alerts-run): new launches, large buys of a favourite, and
 * liquidity taken out of a favourite's pool, read from Aretia's market index. The rules are in src/swings/notify/market.ts.
 *
 * The index runs on a small server, so a run asks it only a handful of small questions, each with a row limit and a deadline:
 * one for new pools on the networks people chose, one for their token names, and per network one for the favourites' pools and
 * one for their recent buys. Nothing is asked when nobody has a market alert switched on. Any failure here is caught by the
 * caller and leaves the price alerts untouched.
 */
import { supabaseBase, supabaseHeaders } from '../src/swings/tokens/supabaseAuth.js';
import { postgrestReader } from '../src/swings/mi/marketList.js';
import { isMiChain, type MiChain } from '../src/swings/mi/chains.js';
import {
  BUY_WINDOW_MS,
  cleanMarketPrefs,
  indexFavouriteKey,
  LAUNCH_WINDOW_MS,
  marketOn,
  matchBigBuys,
  matchLaunches,
  matchLiquidityDrops,
  nextMarks,
  planMarket,
  type IndexPool,
  type IndexTrade,
  type MarketEvent,
  type MarketPrefs,
  type PoolMark,
} from '../src/swings/notify/market.js';
import type { PlannedMessage } from '../src/swings/notify/plan.js';
import type { Rest } from './_swingsAccount.js';

export interface MarketAlertsEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  MI_DATA_URL?: string;
  MI_DATA_SERVICE_ROLE_KEY?: string;
}

export interface MarketRunInput {
  env: MarketAlertsEnv;
  fetchImpl: typeof fetch;
  /** The alerts database (Supabase): preferences, what was sent, pool marks. */
  db: Rest;
  now: number;
  /** Owners with at least one linked channel and alerts switched on. */
  owners: readonly string[];
  favourites(owner: string): readonly { chain: string; address: string; symbol: string }[];
  /** Hands one message to every channel of the owner; true when at least one took it. */
  send(owner: string, m: PlannedMessage): Promise<boolean>;
}

export interface MarketRunStats {
  marketOwners: number;
  launches: number;
  pools: number;
  buys: number;
  marketSent: number;
  marketFailed: number;
}

/** Favourite tokens whose pools are read per run, shared fairly between people (round-robin, rotating). */
export const MARKET_TOKEN_BUDGET = 60;
/** Pools read per favourite token: its deepest ones. */
const POOLS_PER_TOKEN = 2;
/** Events a person is checked against "already sent" for, per run. */
const CANDIDATES_PER_OWNER = 40;
const INDEX_DEADLINE_MS = 8_000;
const SENT_KEEP_MS = 48 * 3_600_000;
const POOL_COLS = 'key,chain,address,base,quote_decimals,created_at,liquidity_usd,reserve_base,reserve_quote,quote_usd:stats->quoteUsd';

const inList = (values: readonly string[]): string => encodeURIComponent(`(${values.map((v) => `"${v.replace(/["\\]/g, '')}"`).join(',')})`);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** A row of mi_pools as the index answers it, or null when it is not usable. */
export function poolFromRow(r: Record<string, unknown>, symbol = ''): IndexPool | null {
  const chain = r.chain;
  if (!isMiChain(chain) || typeof r.key !== 'string' || typeof r.address !== 'string' || typeof r.base !== 'string') return null;
  const quoteDecimals = num(r.quote_decimals);
  const createdAt = num(r.created_at);
  if (quoteDecimals === null || createdAt === null) return null;
  return { key: r.key, chain, address: r.address, base: r.base, quoteDecimals, createdAt, liquidityUsd: num(r.liquidity_usd), quoteUsd: num(r.quote_usd), reserveBase: num(r.reserve_base), reserveQuote: num(r.reserve_quote), symbol };
}

/** Which favourite tokens to read, round-robin across people so nobody's list crowds out the rest. */
export function fairFavourites(owners: readonly string[], keysOf: (owner: string) => string[], budget: number, rotate: number): string[] {
  if (owners.length === 0) return [];
  const start = ((rotate % owners.length) + owners.length) % owners.length;
  const lists = [...owners.slice(start), ...owners.slice(0, start)].map(keysOf);
  const out = new Set<string>();
  for (let round = 0; out.size < budget && lists.some((l) => l.length > round); round++) for (const l of lists) if (l[round] && out.size < budget) out.add(l[round]!);
  return [...out];
}

export async function runMarketAlerts(input: MarketRunInput): Promise<MarketRunStats> {
  const stats: MarketRunStats = { marketOwners: 0, launches: 0, pools: 0, buys: 0, marketSent: 0, marketFailed: 0 };
  const { db, now } = input;
  if (input.owners.length === 0) return stats;
  const wanted = new Set(input.owners);
  const prefRows = (await db.call('notify_market_prefs?select=owner,launch_chains,launch_min_liq,big_buy_usd,liq_drop_pct&limit=5000')) as { owner: string; launch_chains: string[] | null; launch_min_liq: number; big_buy_usd: number; liq_drop_pct: number }[];
  const prefs = new Map<string, MarketPrefs>();
  for (const r of prefRows) {
    if (!wanted.has(r.owner)) continue;
    const p = cleanMarketPrefs({ launchChains: r.launch_chains ?? [], launchMinLiqUsd: Number(r.launch_min_liq), bigBuyUsd: Number(r.big_buy_usd), liqDropPct: Number(r.liq_drop_pct) });
    if (marketOn(p)) prefs.set(r.owner, p);
  }
  // Rows older than two days are of no further use; cheap with its index, and harmless when it fails.
  await db.call(`notify_market_sent?at=lt.${now - SENT_KEEP_MS}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } }).catch(() => undefined);
  stats.marketOwners = prefs.size;
  if (prefs.size === 0) return stats;

  const own = Boolean(input.env.MI_DATA_URL?.trim() && input.env.MI_DATA_SERVICE_ROLE_KEY?.trim());
  const url = supabaseBase(own ? input.env.MI_DATA_URL : input.env.SUPABASE_URL);
  const key = (own ? input.env.MI_DATA_SERVICE_ROLE_KEY : input.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  if (!url || !key) return stats;
  const index = postgrestReader(url, supabaseHeaders(key), input.fetchImpl, AbortSignal.timeout(INDEX_DEADLINE_MS));
  const read = async (path: string): Promise<Record<string, unknown>[]> => (await index.get(path, false)).rows as Record<string, unknown>[];
  const all = [...prefs.entries()];

  // New launches: one question for every network anyone chose, from the lowest minimum anyone chose.
  const launchChains = [...new Set(all.flatMap(([, p]) => p.launchChains))];
  let launchPools: IndexPool[] = [];
  if (launchChains.length > 0) {
    const minLiq = Math.min(...all.filter(([, p]) => p.launchChains.length > 0).map(([, p]) => p.launchMinLiqUsd));
    const rows = await read(`mi_pools?chain=in.(${launchChains.join(',')})&state=eq.active&created_at=gte.${now - LAUNCH_WINDOW_MS}&liquidity_usd=${minLiq > 0 ? `gte.${minLiq}` : 'gt.0'}&select=${POOL_COLS}&order=created_at.desc&limit=100`);
    const bases = [...new Set(rows.filter((r) => isMiChain(r.chain) && typeof r.base === 'string').map((r) => `${String(r.chain)}:${String(r.base)}`))];
    const symbols = new Map<string, string>();
    if (bases.length > 0) for (const t of await read(`mi_tokens?key=in.${inList(bases)}&select=key,symbol&limit=100`)) symbols.set(String(t.key), String(t.symbol ?? ''));
    launchPools = rows.map((r) => poolFromRow(r, symbols.get(`${String(r.chain)}:${String(r.base)}`) ?? '')).filter((p): p is IndexPool => p !== null);
    stats.launches = launchPools.length;
  }

  // Favourites' pools, for large buys and liquidity drops.
  const favKeys = new Map<string, Set<string>>();
  const favSymbol = new Map<string, string>();
  for (const [owner, p] of all) {
    if (p.bigBuyUsd <= 0 && p.liqDropPct <= 0) continue;
    const keys = new Set<string>();
    for (const f of input.favourites(owner)) {
      const k = indexFavouriteKey(f.chain, f.address);
      if (!k) continue;
      keys.add(k);
      if (!favSymbol.has(k)) favSymbol.set(k, f.symbol);
    }
    favKeys.set(owner, keys);
  }
  const tokens = fairFavourites([...favKeys.keys()], (o) => [...(favKeys.get(o) ?? [])], MARKET_TOKEN_BUDGET, Math.floor(now / 60_000));
  const favPools: IndexPool[] = [];
  const byChain = new Map<MiChain, string[]>();
  for (const t of tokens) {
    const i = t.indexOf(':');
    const chain = t.slice(0, i);
    if (isMiChain(chain)) byChain.set(chain, [...(byChain.get(chain) ?? []), t.slice(i + 1)]);
  }
  for (const [chain, bases] of byChain) {
    const rows = await read(`mi_pools?chain=eq.${chain}&base=in.${inList(bases)}&state=eq.active&select=${POOL_COLS}&order=liquidity_usd.desc.nullslast&limit=${bases.length * 4}`);
    const per = new Map<string, number>();
    for (const r of rows) {
      const p = poolFromRow(r, favSymbol.get(`${chain}:${String(r.base)}`) ?? '');
      if (!p || (per.get(p.base) ?? 0) >= POOLS_PER_TOKEN) continue;
      per.set(p.base, (per.get(p.base) ?? 0) + 1);
      favPools.push(p);
    }
  }
  stats.pools = favPools.length;
  const poolMap = new Map(favPools.map((p) => [p.key, p]));

  // Recent buys in those pools, only when someone asked for large buys.
  const trades: IndexTrade[] = [];
  if (all.some(([, p]) => p.bigBuyUsd > 0)) {
    const poolsByChain = new Map<MiChain, string[]>();
    for (const p of favPools) poolsByChain.set(p.chain, [...(poolsByChain.get(p.chain) ?? []), p.address]);
    for (const [chain, addrs] of poolsByChain) {
      const rows = await read(`mi_trades?chain=eq.${chain}&pool=in.${inList(addrs)}&side=eq.buy&time=gte.${Math.floor((now - BUY_WINDOW_MS) / 1000)}&select=chain,pool,id,time,side,quote_amount&order=time.desc&limit=300`);
      for (const r of rows) if (isMiChain(r.chain) && (r.side === 'buy' || r.side === 'sell')) trades.push({ chain: r.chain, pool: String(r.pool), id: String(r.id), time: Number(r.time), side: r.side, quoteAmount: String(r.quote_amount) });
    }
    stats.buys = trades.length;
  }

  // Marks for liquidity drops, only when someone asked for them.
  const marks = new Map<string, PoolMark>();
  const wantDrops = all.some(([, p]) => p.liqDropPct > 0) && favPools.length > 0;
  if (wantDrops) {
    const rows = (await db.call(`notify_pool_marks?pool_key=in.${inList(favPools.map((p) => p.key))}&select=pool_key,reserve_base,reserve_quote,at`)) as { pool_key: string; reserve_base: number; reserve_quote: number; at: number }[];
    for (const r of rows) marks.set(r.pool_key, { reserveBase: Number(r.reserve_base), reserveQuote: Number(r.reserve_quote), at: Number(r.at) });
  }

  for (const [owner, p] of all) {
    const favs = favKeys.get(owner) ?? new Set<string>();
    const events: MarketEvent[] = [
      ...matchLiquidityDrops(favPools, marks, favs, p, now),
      ...matchBigBuys(trades, poolMap, favs, p, now),
      ...matchLaunches(launchPools, p, now),
    ].slice(0, CANDIDATES_PER_OWNER);
    if (events.length === 0) continue;
    const q = encodeURIComponent(owner);
    const seenRows = (await db.call(`notify_market_sent?owner=eq.${q}&or=(key.in.${inList(events.map((e) => e.key))},and(msg.is.true,at.gte.${now - 3_600_000}))&select=key,at,msg&limit=200`)) as { key: string; at: number; msg: boolean }[];
    const seen = new Set(seenRows.map((r) => r.key));
    const fresh = events.filter((e) => !seen.has(e.key));
    if (fresh.length === 0) continue;
    const sentLastHour = seenRows.filter((r) => r.msg && Number(r.at) >= now - 3_600_000).length;
    const plan = planMarket(fresh, sentLastHour, now);
    let delivered = plan.messages.length === 0;
    for (const m of plan.messages) {
      if (await input.send(owner, m)) {
        stats.marketSent++;
        delivered = true;
      } else stats.marketFailed++;
    }
    // Remembered only if something reached the person, so a failed send is tried again on the next run (within the window).
    if (!delivered) continue;
    await db.call('notify_market_sent?on_conflict=owner,key', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(plan.handled.map((h) => ({ owner, key: h.key, at: now, msg: h.msg }))) });
  }

  if (wantDrops) {
    const changed = nextMarks(favPools, marks, now);
    if (changed.size > 0) await db.call('notify_pool_marks?on_conflict=pool_key', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([...changed].map(([pool_key, m]) => ({ pool_key, reserve_base: m.reserveBase, reserve_quote: m.reserveQuote, at: m.at }))) });
  }
  return stats;
}
