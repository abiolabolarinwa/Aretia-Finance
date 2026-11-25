/**
 * Market alerts read from Aretia's own market index: new launches on a chosen network, large buys of a favourite, and a large
 * share of a favourite's liquidity taken out of its pool. Pure: given what the index holds and what each person chose, it says
 * which messages are owed and what to remember. The I/O lives in api/_swingsMarketAlerts.ts.
 *
 * A message only ever carries a title, a few numbers and a link to the token's page on Aretia. Nothing in it can move funds.
 */
import { CHAINS } from '../core/types.js';
import { isMiChain, MI_CHAINS, type MiChain } from '../mi/chains.js';
import { compactUsd } from '../market/types.js';
import { messageSymbol, type PlannedMessage } from './plan.js';

/** Minimum liquidity a new launch must have before it is reported (0 = any launch with some liquidity). */
export const LAUNCH_MIN_LIQ_CHOICES = [0, 1_000, 5_000, 10_000, 50_000] as const;
/** The smallest buy of a favourite worth a message, in dollars (0 = off). */
export const BIG_BUY_CHOICES = [0, 1_000, 5_000, 10_000, 50_000] as const;
/** The share of a pool's liquidity that has to leave before a message is sent, in percent (0 = off). */
export const LIQ_DROP_CHOICES = [0, 30, 50, 80] as const;

/** How far back a run looks for new pools and for buys. A run that comes later than this misses what happened before. */
export const LAUNCH_WINDOW_MS = 30 * 60_000;
export const BUY_WINDOW_MS = 15 * 60_000;
/** The liquidity a drop is measured from is the most seen in this long; after it, it starts again from what is there now. */
export const MARK_TTL_MS = 24 * 3_600_000;

/** Market messages one person can get in one run; more than this becomes one "N more" line. */
export const MAX_MARKET_PER_RUN = 4;
/** Market messages one person can get in an hour, the "N more" lines included. Past it, nothing more is sent that hour. */
export const MAX_MARKET_PER_HOUR = 12;
/** More new launches than this on one network in one run are sent as one line that counts them. */
export const LAUNCH_GROUP_OVER = 3;

export interface MarketPrefs {
  /** Networks to report new launches on (empty = off). */
  launchChains: MiChain[];
  launchMinLiqUsd: number;
  /** Smallest buy to report, in dollars (0 = off). */
  bigBuyUsd: number;
  /** Share of liquidity taken out to report, in percent (0 = off). */
  liqDropPct: number;
}

export const MARKET_PREFS_OFF: MarketPrefs = { launchChains: [], launchMinLiqUsd: 0, bigBuyUsd: 0, liqDropPct: 0 };

const oneOf = (v: unknown, choices: readonly number[], fallback: number): number => (typeof v === 'number' && choices.includes(v) ? v : fallback);

/** Market alert settings as the page (or the database) gives them, checked value by value; anything unknown falls back to off. */
export function cleanMarketPrefs(v: unknown): MarketPrefs {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const chains = Array.isArray(o.launchChains) ? o.launchChains : [];
  return {
    launchChains: MI_CHAINS.filter((c) => chains.includes(c)),
    launchMinLiqUsd: oneOf(o.launchMinLiqUsd, LAUNCH_MIN_LIQ_CHOICES, 0),
    bigBuyUsd: oneOf(o.bigBuyUsd, BIG_BUY_CHOICES, 0),
    liqDropPct: oneOf(o.liqDropPct, LIQ_DROP_CHOICES, 0),
  };
}

export const marketOn = (p: MarketPrefs): boolean => p.launchChains.length > 0 || p.bigBuyUsd > 0 || p.liqDropPct > 0;

/** A pool as the index holds it, with only what the rules need. Reserves are raw amounts (only their ratio over time is used). */
export interface IndexPool {
  key: string;
  chain: MiChain;
  address: string;
  /** The token the pool prices. */
  base: string;
  quoteDecimals: number;
  /** ms, block time of the pool's creation. */
  createdAt: number;
  liquidityUsd: number | null;
  /** What one whole quote token was worth in dollars when the index last computed the pool's numbers. */
  quoteUsd: number | null;
  reserveBase: number | null;
  reserveQuote: number | null;
  symbol: string;
}

export interface IndexTrade {
  chain: MiChain;
  pool: string;
  id: string;
  /** unix seconds */
  time: number;
  side: 'buy' | 'sell';
  /** raw */
  quoteAmount: string;
}

/** The most liquidity seen in a pool lately: what a drop is measured from. Shared by everyone, kept per pool. */
export interface PoolMark {
  reserveBase: number;
  reserveQuote: number;
  at: number;
}

export type MarketKind = 'launch' | 'buy' | 'liquidity';

/** Something that happened that some people may be owed a message about. `key` is what makes it "already sent" for a person. */
export interface MarketEvent {
  kind: MarketKind;
  key: string;
  chain: MiChain;
  token: string;
  symbol: string;
  /** launch: liquidity in dollars. buy: the buy in dollars. liquidity: the share taken out, in percent. */
  amount: number;
  /** ms */
  at: number;
}

const tokenUrl = (chain: string, token: string): string => `/token#/${chain}/${token}`;
const chainName = (c: MiChain): string => CHAINS[c]?.name ?? c;
const agoText = (now: number, at: number): string => {
  const min = Math.max(0, Math.round((now - at) / 60_000));
  return min < 1 ? 'just now' : `${min} min ago`;
};

/** New pools on the person's networks, opened within the window, with at least their minimum liquidity. Newest first. */
export function matchLaunches(pools: readonly IndexPool[], prefs: MarketPrefs, now: number, windowMs = LAUNCH_WINDOW_MS): MarketEvent[] {
  if (prefs.launchChains.length === 0) return [];
  return pools
    .filter((p) => prefs.launchChains.includes(p.chain) && p.createdAt >= now - windowMs && p.createdAt <= now + 60_000)
    .filter((p) => p.liquidityUsd !== null && p.liquidityUsd > 0 && p.liquidityUsd >= prefs.launchMinLiqUsd)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((p) => ({ kind: 'launch' as const, key: `launch:${p.key}`, chain: p.chain, token: p.base, symbol: p.symbol, amount: p.liquidityUsd ?? 0, at: p.createdAt }));
}

/** What a trade was worth in dollars, from its quote amount and the quote token's dollar price; null when not known. */
export function tradeUsd(t: Pick<IndexTrade, 'quoteAmount'>, pool: Pick<IndexPool, 'quoteDecimals' | 'quoteUsd'>): number | null {
  if (pool.quoteUsd === null || !(pool.quoteUsd > 0) || !/^\d{1,78}$/.test(t.quoteAmount)) return null;
  const v = (Number(t.quoteAmount) / 10 ** pool.quoteDecimals) * pool.quoteUsd;
  return Number.isFinite(v) ? v : null;
}

/** Buys of the person's favourites within the window worth at least their threshold. Largest first. */
export function matchBigBuys(trades: readonly IndexTrade[], pools: ReadonlyMap<string, IndexPool>, favourites: ReadonlySet<string>, prefs: MarketPrefs, now: number, windowMs = BUY_WINDOW_MS): MarketEvent[] {
  if (prefs.bigBuyUsd <= 0) return [];
  const out: MarketEvent[] = [];
  for (const t of trades) {
    if (t.side !== 'buy' || t.time * 1000 < now - windowMs) continue;
    const pool = pools.get(`${t.chain}:${t.pool}`);
    if (!pool || !favourites.has(`${pool.chain}:${pool.base}`)) continue;
    const usd = tradeUsd(t, pool);
    if (usd === null || usd < prefs.bigBuyUsd) continue;
    out.push({ kind: 'buy', key: `buy:${t.chain}:${t.id}`, chain: pool.chain, token: pool.base, symbol: pool.symbol, amount: usd, at: t.time * 1000 });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

/**
 * The share of a pool's liquidity that has left since its mark, as a fraction 0..1. Liquidity leaves when both sides of the pool
 * shrink together; a heavy sell shrinks only the quote side (and grows the token side), so it does not count. null when not known.
 */
export function liquidityDrop(pool: Pick<IndexPool, 'reserveBase' | 'reserveQuote'>, mark: PoolMark | undefined): number | null {
  if (!mark || pool.reserveBase === null || pool.reserveQuote === null || !(mark.reserveBase > 0) || !(mark.reserveQuote > 0)) return null;
  const kept = Math.max(pool.reserveBase / mark.reserveBase, pool.reserveQuote / mark.reserveQuote);
  return Math.min(1, Math.max(0, 1 - kept));
}

/**
 * The marks to keep after this run: a pool seen for the first time, one whose mark is older than a day, or one with more on both
 * sides than its mark, is marked at what it holds now. Otherwise the mark stays, so a slow drain is measured from the top.
 */
export function nextMarks(pools: readonly IndexPool[], marks: ReadonlyMap<string, PoolMark>, now: number): Map<string, PoolMark> {
  const changed = new Map<string, PoolMark>();
  for (const p of pools) {
    if (p.reserveBase === null || p.reserveQuote === null || !(p.reserveBase > 0) || !(p.reserveQuote > 0)) continue;
    const m = marks.get(p.key);
    if (!m || now - m.at > MARK_TTL_MS || (p.reserveBase > m.reserveBase && p.reserveQuote > m.reserveQuote)) changed.set(p.key, { reserveBase: p.reserveBase, reserveQuote: p.reserveQuote, at: now });
  }
  return changed;
}

/** Favourites' pools that have lost at least the person's share of liquidity since their mark. Each mark is reported once per person. */
export function matchLiquidityDrops(pools: readonly IndexPool[], marks: ReadonlyMap<string, PoolMark>, favourites: ReadonlySet<string>, prefs: MarketPrefs, now: number): MarketEvent[] {
  if (prefs.liqDropPct <= 0) return [];
  const out: MarketEvent[] = [];
  for (const p of pools) {
    if (!favourites.has(`${p.chain}:${p.base}`)) continue;
    const mark = marks.get(p.key);
    if (!mark || now - mark.at > MARK_TTL_MS) continue;
    const drop = liquidityDrop(p, mark);
    if (drop === null || drop * 100 < prefs.liqDropPct) continue;
    out.push({ kind: 'liquidity', key: `liq:${p.key}:${mark.at}`, chain: p.chain, token: p.base, symbol: p.symbol, amount: Math.round(drop * 100), at: now });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

export function eventMessage(e: MarketEvent, now: number): PlannedMessage {
  const sym = messageSymbol(e.symbol);
  const url = tokenUrl(e.chain, e.token);
  if (e.kind === 'launch') return { kind: 'launch', title: `New on ${chainName(e.chain)}: ${sym}`, body: `Liquidity ${compactUsd(e.amount)}, opened ${agoText(now, e.at)}.`, url };
  if (e.kind === 'buy') return { kind: 'buy', title: `${sym}: ${compactUsd(e.amount)} buy`, body: `On ${chainName(e.chain)}, ${agoText(now, e.at)}.`, url };
  return { kind: 'liquidity', title: `${sym}: ${e.amount}% of liquidity removed`, body: `On ${chainName(e.chain)}, since the most it held in the last day.`, url };
}

export interface MarketPlan {
  messages: PlannedMessage[];
  /** Events to remember as handled for this person (`msg`: it was sent as its own message, which counts toward the hourly limit). */
  handled: { key: string; msg: boolean }[];
}

/**
 * What one person is sent this run. `events` are theirs, already without the ones sent before. Liquidity first (it matters most),
 * then buys, then launches; many launches on one network become one line. At most `MAX_MARKET_PER_RUN` messages, and nothing once
 * `sentLastHour` reaches `MAX_MARKET_PER_HOUR`. Everything considered is remembered as handled, sent or not, so a busy hour does
 * not come back as a pile later.
 */
export function planMarket(events: readonly MarketEvent[], sentLastHour: number, now: number, perRun = MAX_MARKET_PER_RUN, perHour = MAX_MARKET_PER_HOUR): MarketPlan {
  const room = Math.max(0, Math.min(perRun, perHour - sentLastHour));
  const handled = events.map((e) => ({ key: e.key, msg: false }));
  if (room === 0 || events.length === 0) return { messages: [], handled };

  const order: MarketKind[] = ['liquidity', 'buy', 'launch'];
  const items: { message: PlannedMessage; keys: string[] }[] = [];
  for (const kind of order) {
    const of = events.filter((e) => e.kind === kind);
    if (kind !== 'launch') {
      for (const e of of) items.push({ message: eventMessage(e, now), keys: [e.key] });
      continue;
    }
    for (const chain of MI_CHAINS) {
      const here = of.filter((e) => e.chain === chain);
      if (here.length === 0) continue;
      if (here.length > LAUNCH_GROUP_OVER) items.push({ message: { kind: 'launch', title: `${here.length} new launches on ${chainName(chain)}`, body: `The newest: ${here.slice(0, 3).map((e) => messageSymbol(e.symbol)).join(', ')}.`, url: '/' }, keys: here.map((e) => e.key) });
      else for (const e of here) items.push({ message: eventMessage(e, now), keys: [e.key] });
    }
  }

  const take = items.length > room ? items.slice(0, room - 1) : items;
  const rest = items.slice(take.length);
  const messages = take.map((i) => i.message);
  if (rest.length > 0) messages.push({ kind: rest[0]!.message.kind, title: `${rest.length} more market alert${rest.length === 1 ? '' : 's'}`, body: 'Open Aretia to see them.', url: '/' });
  // Each message, the "N more" line included, counts once against the hour: it is remembered on the first key it stands for.
  const counted = new Set([...take.map((i) => i.keys[0]!), ...(rest[0] ? [rest[0].keys[0]!] : [])]);
  return { messages, handled: handled.map((h) => ({ key: h.key, msg: counted.has(h.key) })) };
}

/** Chains a list of favourites spans that the index covers, and each favourite's key as the index writes it. */
export function indexFavouriteKey(chain: string, address: string): string | null {
  if (!isMiChain(chain)) return null;
  return `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`;
}
