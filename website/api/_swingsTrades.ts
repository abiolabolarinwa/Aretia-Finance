/**
 * GET /api/swings-trades?chain=&pool=&token=: the recent trades of a pool for the Transactions table under the chart,
 * read from GeckoTerminal once by the server and shared. The same reasoning as the chart's candles (api/_swingsOhlcv.ts):
 * GeckoTerminal allows about 30 requests a minute per visitor, and the table refreshes while it is on screen, so asking
 * from every browser would spend each visitor's allowance. Here one fetch serves everyone: the answer is kept in the
 * server's memory for a few seconds, the CDN keeps it for the same time, simultaneous requests share one upstream
 * request, and if the source fails the last good answer (up to five minutes old) is returned and marked stale.
 *
 * The rows are cleaned here (src/swings/charts/trades.ts): a row with a missing or malformed field is dropped, and only
 * addresses and hashes of the expected shape are passed on. Only the pool's address and the network are sent upstream.
 */
import { overLimit } from './_rpcProxy.js';
import { isChainId } from '../src/swings/core/types.js';
import { GECKO_NETWORK } from '../src/swings/charts/pool.js';
import { parseTrades, type Trade } from '../src/swings/charts/trades.js';
import type { TokensInput, TokensOutput } from './_swingsTokens.js';

const POOL = /^[A-Za-z0-9]{20,100}$/;
const FRESH_MS = 15_000;
const STALE_MS = 5 * 60_000;
const MAX_ENTRIES = 400;

const answers = new Map<string, { at: number; trades: Trade[] }>();
const inFlight = new Map<string, Promise<Trade[]>>();
/** How long to wait before the one retry when the source refuses (a burst of requests is usually over in a second). */
let retryDelayMs = 800;

export function resetTradesCache(delayMs = 800): void {
  answers.clear();
  inFlight.clear();
  retryDelayMs = delayMs;
}

const json = (status: number, data: unknown, headers: Record<string, string>): TokensOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });

export async function handleTrades(input: TokensInput): Promise<TokensOutput> {
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (input.method !== 'GET') return json(405, { error: 'method' }, { ...headers, allow: 'GET' });
  const { chain = '', pool = '', token = 'base' } = input.query;
  if (!isChainId(chain) || !POOL.test(pool) || (token !== 'base' && token !== 'quote')) return json(400, { error: 'bad-request' }, headers);
  const key = `${chain}|${chain === 'solana' ? pool : pool.toLowerCase()}|${token}`;
  const ok = (trades: Trade[], stale: boolean): TokensOutput =>
    json(200, { trades, stale }, { ...headers, 'cache-control': stale ? 'no-store' : `public, s-maxage=${FRESH_MS / 1000}, stale-while-revalidate=${FRESH_MS / 500}` });

  const hit = answers.get(key);
  if (hit && input.now - hit.at < FRESH_MS) return ok(hit.trades, false);
  if (overLimit(`trades:${input.ip}`, input.now)) return hit ? ok(hit.trades, true) : json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '30' });

  const url = `https://api.geckoterminal.com/api/v2/networks/${GECKO_NETWORK[chain]}/pools/${encodeURIComponent(pool)}/trades`;
  // Visitors asking for the same pool at once share one upstream request.
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
      return parseTrades(await res.json(), token);
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  try {
    const trades = await pending;
    if (answers.size >= MAX_ENTRIES) answers.clear();
    answers.set(key, { at: input.now, trades });
    return ok(trades, false);
  } catch {
    // The source refused or failed: the last good answer is better than a blank table, and it is marked as old.
    if (hit && input.now - hit.at < STALE_MS) return ok(hit.trades, true);
    return json(502, { error: 'source' }, headers);
  }
}
