/**
 * Recent trades of one pool, for the Transactions table under the chart: what GeckoTerminal reports for a pool (its last
 * 24 hours, up to 300 trades), read into rows the page can draw. Shared by the server route that fetches and caches them
 * (api/_swingsTrades.ts) and by the page, which reads the server's answer and falls back to GeckoTerminal itself where
 * the route is not available (local development).
 *
 * Everything here is untrusted text from outside, so a row is kept only if every field has the expected shape, and the
 * addresses and hashes that become links are checked against a strict pattern before they can be used in one.
 */
import type { ChainId } from '../core/types.js';
import { GECKO_NETWORK } from './pool.js';
import { spaced } from './geckoGate.js';
import { allowEvery, markRouteDown, markRouteUp, routeIsDown } from './upstreamHealth.js';

/** The name this route is remembered under while it is failing. */
const ROUTE = 'trades';
/** Direct reads of GeckoTerminal for one pool's trades are at most this far apart. */
const DIRECT_GAP_MS = 15_000;

export interface Trade {
  /** When the trade was confirmed, in milliseconds. */
  t: number;
  /** From the point of view of the token being looked at: it was bought or sold. */
  kind: 'buy' | 'sell';
  /** Value of the trade in US dollars. */
  usd: number;
  /** Amount of the token being looked at, and of the other side of the pool. */
  tokenAmount: number;
  quoteAmount: number;
  /** Price of the token being looked at in this trade, in US dollars. */
  priceUsd: number | null;
  /** The wallet that sent the transaction, and the transaction's hash or signature. */
  trader: string;
  tx: string;
}

/** Which token of the pool is being looked at: the first ("base") or the second ("quote"). */
export type TradeSide = 'base' | 'quote';

/** Solana signatures and addresses are base58; EVM ones are hex. Nothing else may become part of a link. */
const SAFE_ID = /^[A-Za-z0-9]{20,100}$/;
export const MAX_TRADES = 300;

interface RawTrade {
  attributes?: {
    block_timestamp?: unknown;
    tx_hash?: unknown;
    tx_from_address?: unknown;
    from_token_amount?: unknown;
    to_token_amount?: unknown;
    price_from_in_usd?: unknown;
    price_to_in_usd?: unknown;
    kind?: unknown;
    volume_in_usd?: unknown;
  };
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * Reads GeckoTerminal's trade list. Its "kind" is about the pool's first token: a buy is the first token coming out of the
 * pool (it is the `to` side), a sell is the first token going in (the `from` side). Looking at the second token flips that.
 * Newest first. Pure.
 */
export function parseTrades(body: unknown, side: TradeSide = 'base'): Trade[] {
  const list = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return [];
  const out: Trade[] = [];
  for (const item of list as RawTrade[]) {
    const a = item?.attributes;
    if (!a || (a.kind !== 'buy' && a.kind !== 'sell')) continue;
    const t = typeof a.block_timestamp === 'string' ? Date.parse(a.block_timestamp) : Number.NaN;
    const from = num(a.from_token_amount);
    const to = num(a.to_token_amount);
    const usd = num(a.volume_in_usd);
    const trader = a.tx_from_address;
    const tx = a.tx_hash;
    if (!Number.isFinite(t) || from === null || to === null || usd === null || from < 0 || to < 0 || usd < 0) continue;
    if (typeof trader !== 'string' || !SAFE_ID.test(trader) || typeof tx !== 'string' || !SAFE_ID.test(tx)) continue;
    const baseIsTo = a.kind === 'buy';
    // Is the token being looked at the one that came out of the pool (the `to` side)?
    const tokenIsTo = side === 'base' ? baseIsTo : !baseIsTo;
    const price = num(tokenIsTo ? a.price_to_in_usd : a.price_from_in_usd);
    out.push({ t, kind: tokenIsTo ? 'buy' : 'sell', usd, tokenAmount: tokenIsTo ? to : from, quoteAmount: tokenIsTo ? from : to, priceUsd: price !== null && price > 0 ? price : null, trader, tx });
  }
  return out.sort((x, y) => y.t - x.t).slice(0, MAX_TRADES);
}

/**
 * The recent trades of a pool. Aretia's own route is asked first, so a visitor's own GeckoTerminal allowance is not spent;
 * GeckoTerminal is asked directly only if that route fails (it does not exist in local development). Throws a message fit
 * to show when neither answers.
 */
export async function fetchTrades(chain: ChainId, pool: string, side: TradeSide = 'base', fetchImpl: typeof fetch = (...args) => fetch(...args), signal?: AbortSignal, now: () => number = Date.now): Promise<Trade[]> {
  // A route that failed in the last minute is skipped, so each check does not wait on a refusal before going to the fallback.
  if (!routeIsDown(ROUTE, now())) {
    try {
      const res = await fetchImpl(`/api/swings-trades?${new URLSearchParams({ chain, pool, token: side })}`, { signal });
      if (res.ok) {
        const rows = readServerTrades(await res.json());
        if (rows) {
          markRouteUp(ROUTE);
          return rows;
        }
      }
      markRouteDown(ROUTE, now());
    } catch {
      if (signal?.aborted) throw new Error('cancelled');
      markRouteDown(ROUTE, now());
    }
  }
  // Reading GeckoTerminal directly spends this visitor's own small allowance, and the chart's candles need it too. So the
  // table does it at most once every 15 seconds per pool; in between it keeps showing what it has.
  if (!allowEvery(`trades-direct:${chain}:${pool}`, DIRECT_GAP_MS, now())) throw new Error('The trades will refresh shortly.');
  let res: Response;
  try {
    res = await spaced(() => fetchImpl(`https://api.geckoterminal.com/api/v2/networks/${GECKO_NETWORK[chain]}/pools/${encodeURIComponent(pool)}/trades`, { headers: { accept: 'application/json' }, signal }));
  } catch {
    throw new Error(signal?.aborted ? 'cancelled' : 'The trades could not be loaded.');
  }
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(res.status === 429 ? 'The price service is busy. The trades will appear shortly.' : 'The trades could not be loaded.');
  try {
    return parseTrades(await res.json(), side);
  } catch {
    throw new Error('The trades could not be loaded.');
  }
}

/** Checks rows that came from Aretia's own server route before they are drawn. Pure. */
export function readServerTrades(body: unknown): Trade[] | null {
  const list = (body as { trades?: unknown } | null)?.trades;
  if (!Array.isArray(list)) return null;
  const out: Trade[] = [];
  for (const r of list as Partial<Trade>[]) {
    if (!r || (r.kind !== 'buy' && r.kind !== 'sell') || typeof r.trader !== 'string' || !SAFE_ID.test(r.trader) || typeof r.tx !== 'string' || !SAFE_ID.test(r.tx)) continue;
    // The dollar value is null for a pool quoted in the chain's own coin (the index does not convert history at today's rate); the table shows a dash.
    if (![r.t, r.tokenAmount, r.quoteAmount].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    if (r.usd !== null && !(typeof r.usd === 'number' && Number.isFinite(r.usd))) continue;
    out.push({ t: r.t!, kind: r.kind, usd: r.usd === null ? Number.NaN : (r.usd as number), tokenAmount: r.tokenAmount!, quoteAmount: r.quoteAmount!, priceUsd: typeof r.priceUsd === 'number' && Number.isFinite(r.priceUsd) ? r.priceUsd : null, trader: r.trader, tx: r.tx });
  }
  return out.slice(0, MAX_TRADES);
}

/** Block explorers, for the transaction and the trader of a row. Only an address or hash that passed SAFE_ID is ever appended. */
const EXPLORER: Readonly<Record<ChainId, { tx: string; address: string }>> = {
  solana: { tx: 'https://solscan.io/tx/', address: 'https://solscan.io/account/' },
  ethereum: { tx: 'https://etherscan.io/tx/', address: 'https://etherscan.io/address/' },
  bnb: { tx: 'https://bscscan.com/tx/', address: 'https://bscscan.com/address/' },
  polygon: { tx: 'https://polygonscan.com/tx/', address: 'https://polygonscan.com/address/' },
  base: { tx: 'https://basescan.org/tx/', address: 'https://basescan.org/address/' },
  robinhood: { tx: 'https://robinhoodchain.blockscout.com/tx/', address: 'https://robinhoodchain.blockscout.com/address/' },
};

export function txLink(chain: ChainId, tx: string): string | null {
  return SAFE_ID.test(tx) ? `${EXPLORER[chain].tx}${tx}` : null;
}

export function traderLink(chain: ChainId, address: string): string | null {
  return SAFE_ID.test(address) ? `${EXPLORER[chain].address}${address}` : null;
}

/** "6s ago", "12m ago", "3h 20m ago", "1d 1h ago". */
export function timeAgo(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ${h % 24}h ago`;
}

/** A token amount: whole numbers once it is large, a few significant digits when small. */
export function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return '–';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n === 0) return '0';
  return Number(n.toPrecision(3)).toString();
}

/** A trade value in dollars. */
export function formatTradeUsd(n: number): string {
  if (!Number.isFinite(n)) return '–';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
