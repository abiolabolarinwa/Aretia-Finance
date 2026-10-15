/**
 * GET /api/swings-ohlcv?chain=&pool=&tf=&agg=&before=&limit=&token=: candles for the wallet's TradingView chart, read from
 * GeckoTerminal once by the server and shared. The browser used to ask GeckoTerminal itself, which allows about 30
 * requests a minute per visitor; every token opened costs the chart a few requests, so a visitor clicking through a list
 * soon used the allowance up and the chart came up empty. Here one fetch serves everyone: the answer is kept in the
 * server's memory, the CDN keeps it for the same time, and if the source fails the last good answer (up to fifteen
 * minutes old) is returned instead of an error. The data is public, so no sign-in is involved.
 *
 * The `before` time is rounded up to a whole candle, so visitors asking in the same few seconds share one answer instead
 * of each carrying a slightly different timestamp. Only a pool's address and the network are ever sent upstream.
 */
import { overLimit } from './_rpcProxy.js';
import { isChainId } from '../src/swings/core/types.js';
import { GECKO_NETWORK } from '../src/swings/charts/pool.js';
import type { TokensInput, TokensOutput } from './_swingsTokens.js';

const POOL = /^[A-Za-z0-9]{20,100}$/;
/** The candle sizes the chart offers: GeckoTerminal's timeframe and the aggregates of it. */
const SIZES: Readonly<Record<string, { aggregates: readonly number[]; seconds: number }>> = {
  minute: { aggregates: [1, 5, 15], seconds: 60 },
  hour: { aggregates: [1, 4], seconds: 3600 },
  day: { aggregates: [1], seconds: 86_400 },
};
const MAX_LIMIT = 1000;
const STALE_MS = 15 * 60_000;
/** Past candles do not change, so they are kept for longer than the one still forming. */
const HISTORY_FRESH_MS = 10 * 60_000;
const LIVE_FRESH_MS: Readonly<Record<string, number>> = { minute: 20_000, hour: 60_000, day: 5 * 60_000 };
const MAX_ENTRIES = 600;

type Row = [number, number, number, number, number, number];
const answers = new Map<string, { at: number; rows: Row[] }>();
const inFlight = new Map<string, Promise<Row[]>>();

/** How long to wait before the one retry when the source refuses (a burst of requests is usually over in a second). */
let retryDelayMs = 800;

export function resetOhlcvCache(delayMs = 800): void {
  answers.clear();
  inFlight.clear();
  retryDelayMs = delayMs;
}

const json = (status: number, data: unknown, headers: Record<string, string>): TokensOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });

/** Keeps only well-formed candles: [seconds, open, high, low, close, volume], all numbers. */
function cleanRows(list: unknown): Row[] {
  if (!Array.isArray(list)) return [];
  const rows: Row[] = [];
  for (const r of list) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const n = r.slice(0, 6).map(Number);
    if (n.every(Number.isFinite)) rows.push(n as Row);
  }
  return rows;
}

export async function handleOhlcv(input: TokensInput): Promise<TokensOutput> {
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (input.method !== 'GET') return json(405, { error: 'method' }, { ...headers, allow: 'GET' });
  const { chain = '', pool = '', tf = '', token = 'base', currency = 'usd' } = input.query;
  const size = SIZES[tf];
  const aggregate = Math.floor(Number(input.query.agg ?? '1'));
  const limit = Math.floor(Number(input.query.limit ?? '300'));
  const before = Math.floor(Number(input.query.before ?? '0'));
  if (!isChainId(chain) || !POOL.test(pool) || !size || !size.aggregates.includes(aggregate) || (token !== 'base' && token !== 'quote') || (currency !== 'usd' && currency !== 'token') || !Number.isFinite(limit) || limit < 1 || limit > MAX_LIMIT || !Number.isFinite(before) || before < 1) {
    return json(400, { error: 'bad-request' }, headers);
  }
  const step = size.seconds * aggregate;
  const nowSec = Math.floor(input.now / 1000);
  // Round up to a whole candle; never more than one candle into the future, which is all the live candle needs.
  const alignedBefore = Math.min(Math.ceil(before / step) * step, Math.ceil(nowSec / step) * step + step);
  const history = alignedBefore <= nowSec;
  const fresh = history ? HISTORY_FRESH_MS : (LIVE_FRESH_MS[tf] ?? 60_000);
  const key = `${chain}|${chain === 'solana' ? pool : pool.toLowerCase()}|${tf}|${aggregate}|${alignedBefore}|${limit}|${token}|${currency}`;
  const ok = (rows: Row[], stale: boolean): TokensOutput =>
    json(200, { data: { attributes: { ohlcv_list: rows } }, stale }, { ...headers, 'cache-control': stale ? 'no-store' : `public, s-maxage=${Math.floor(fresh / 1000)}, stale-while-revalidate=${Math.floor(fresh / 500)}` });

  const hit = answers.get(key);
  if (hit && input.now - hit.at < fresh) return ok(hit.rows, false);
  if (overLimit(`ohlcv:${input.ip}`, input.now)) return hit ? ok(hit.rows, true) : json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '30' });

  const url = `https://api.geckoterminal.com/api/v2/networks/${GECKO_NETWORK[chain]}/pools/${encodeURIComponent(pool)}/ohlcv/${tf}?${new URLSearchParams({ aggregate: String(aggregate), before_timestamp: String(alignedBefore), limit: String(limit), currency, token })}`;
  // Visitors asking for the same thing at once share one upstream request.
  let pending = inFlight.get(key);
  if (!pending) {
    pending = (async () => {
      let res = await input.fetchImpl(url, { headers: { accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        res = await input.fetchImpl(url, { headers: { accept: 'application/json' } });
      }
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`source ${res.status}`);
      const body = (await res.json()) as { data?: { attributes?: { ohlcv_list?: unknown } } };
      return cleanRows(body.data?.attributes?.ohlcv_list);
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  try {
    const rows = await pending;
    if (answers.size >= MAX_ENTRIES) answers.clear();
    answers.set(key, { at: input.now, rows });
    return ok(rows, false);
  } catch (e) {
    // The source refused or failed: the last good answer is better than an empty chart, and it is marked as old.
    if (hit && input.now - hit.at < STALE_MS) return ok(hit.rows, true);
    // Say what the source answered (a status number, or null when it could not be reached), so a failure can be diagnosed
    // from the response instead of guessed at.
    const status = /source (\d+)/.exec(e instanceof Error ? e.message : '')?.[1];
    return json(502, { error: 'source', upstream: status ? Number(status) : null }, headers);
  }
}
