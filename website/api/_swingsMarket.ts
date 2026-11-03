/**
 * GET /api/swings-market?kind=&chain=&window=&page=: the Marketplace lists (trending, top, gainers, and the newest pools), read once by the
 * server and shared. The browser used to ask GeckoTerminal itself, which allows about 30 requests a minute per visitor;
 * a busy visitor was refused and the list went blank. Here one fetch serves everyone: it is kept in the server's memory
 * for a minute, the CDN keeps the answer for the same minute, and if the source fails the last good list (up to six
 * hours old) is returned and marked stale instead of an error. The data is public, so no sign-in is involved.
 */
import { overLimit } from './_rpcProxy.js';
import { isChainId, type ChainId } from '../src/swings/core/types.js';
import { GeckoMarket, type Breaker, type MarketKind, type Window as MarketWindow } from '../src/swings/market/gecko.js';
import type { MarketRow } from '../src/swings/market/types.js';
import { isDeadMarket } from '../src/swings/market/dead.js';
import type { TokensInput, TokensOutput } from './_swingsTokens.js';

const KINDS: readonly string[] = ['trending', 'top', 'gainers', 'new'];
const WINDOWS: readonly string[] = ['m5', 'h1', 'h6', 'h24'];
const FRESH_MS = 60_000;
/** A page of the deep lists (a network's busiest pools, page 2 to 10) changes slowly, and each is one request to the source, so it is kept longer. */
const DEEP_FRESH_MS = 600_000;
const STALE_MS = 6 * 3_600_000;

/** The whole time one request may spend on the source, so a slow one answers (with an older list) well inside the function's limit. */
const DEADLINE_MS = 25_000;

const lists = new Map<string, { at: number; rows: MarketRow[] }>();
/** Single pages of the source, shared by every list that needs them: the newest pools are the same page whatever the view or window. */
const pages = new Map<string, { at: number; rows: MarketRow[] }>();
/** Tripped when the source refuses, so the server stops asking it for a while instead of spending the whole function time on refusals. */
const breaker: Breaker = { until: 0 };

export function resetMarketCache(): void {
  lists.clear();
  pages.clear();
  breaker.until = 0;
}

const json = (status: number, data: unknown, headers: Record<string, string>): TokensOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });

export async function handleMarket(input: TokensInput): Promise<TokensOutput> {
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (input.method !== 'GET') return json(405, { error: 'method' }, { ...headers, allow: 'GET' });
  const { kind = 'trending', chain = '', window = 'h24' } = input.query;
  const page = Math.floor(Number(input.query.page ?? '1'));
  if (!KINDS.includes(kind) || !WINDOWS.includes(window) || (chain !== '' && !isChainId(chain)) || !Number.isFinite(page) || page < 1 || page > 10) return json(400, { error: 'bad-request' }, headers);
  // `recent=1` is the whole list of recent tokens in one answer (the page is ignored); the browser pages through it itself.
  const recent = input.query.recent === '1';
  const key = `${kind}|${chain}|${window}|${recent ? 'recent' : page}`;
  const hit = lists.get(key);
  const ok = (rows: MarketRow[], stale: boolean, at = input.now): TokensOutput => json(200, { rows, stale, at }, { ...headers, 'cache-control': stale ? 'no-store' : `public, s-maxage=${deep ? 600 : 60}, stale-while-revalidate=86400` });
  const deep = !recent && kind === 'top' && chain !== '';
  const fresh = deep ? DEEP_FRESH_MS : FRESH_MS;
  if (hit && input.now - hit.at < fresh) return ok(hit.rows, false);
  if (overLimit(`market:${input.ip}`, input.now)) return hit ? ok(hit.rows, true, hit.at) : json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '30' });
  // While the source is refusing, an older list is the answer; nothing is sent to it until the pause is over.
  if (input.now < breaker.until && hit && input.now - hit.at < STALE_MS) return ok(hit.rows, true, hit.at);
  if (pages.size > 300) pages.clear();
  const source = new GeckoMarket(input.fetchImpl, () => input.now, FRESH_MS - 5_000, undefined, input.sleep, pages, breaker);
  const signal = AbortSignal.timeout(DEADLINE_MS);
  try {
    const query = { kind: kind as MarketKind, chain: chain as ChainId | '', window: window as MarketWindow };
    // Tokens whose price has gone to nothing on every network are left out here, so no list carries them.
    const rows = (recent ? await source.loadRecent(query, signal) : await source.load({ ...query, page }, signal)).filter((r) => !isDeadMarket(r));
    // A short list because the source began refusing part-way through must not replace a fuller one from a minute ago.
    if (hit && breaker.until > input.now && rows.length < hit.rows.length / 2 && input.now - hit.at < STALE_MS) return ok(hit.rows, true, hit.at);
    if (lists.size > 400) lists.clear();
    lists.set(key, { at: input.now, rows });
    return ok(rows, false);
  } catch {
    // The source refused or failed: the last good list is better than a blank page, and it is marked as old.
    if (hit && input.now - hit.at < STALE_MS) return ok(hit.rows, true, hit.at);
    return json(502, { error: 'source', retryAfter: breaker.until > input.now ? Math.ceil((breaker.until - input.now) / 1000) : 15 }, headers);
  }
}

