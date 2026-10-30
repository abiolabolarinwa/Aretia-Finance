/**
 * GET /api/swings-market?kind=&chain=&window=&page=: the Marketplace lists (trending, top, gainers, and the newest pools), read once by the
 * server and shared. The browser used to ask GeckoTerminal itself, which allows about 30 requests a minute per visitor;
 * a busy visitor was refused and the list went blank. Here one fetch serves everyone: it is kept in the server's memory
 * for a minute, the CDN keeps the answer for the same minute, and if the source fails the last good list (up to six
 * hours old) is returned and marked stale instead of an error. The data is public, so no sign-in is involved.
 */
import { overLimit } from './_rpcProxy.js';
import { isChainId, type ChainId } from '../src/swings/core/types.js';
import { GeckoMarket, type MarketKind, type Window as MarketWindow } from '../src/swings/market/gecko.js';
import type { MarketRow } from '../src/swings/market/types.js';
import { isDeadMarket } from '../src/swings/market/dead.js';
import type { TokensInput, TokensOutput } from './_swingsTokens.js';

const KINDS: readonly string[] = ['trending', 'top', 'gainers', 'new'];
const WINDOWS: readonly string[] = ['m5', 'h1', 'h6', 'h24'];
const FRESH_MS = 60_000;
/** A page of the deep lists (a network's busiest pools, page 2 to 10) changes slowly, and each is one request to the source, so it is kept longer. */
const DEEP_FRESH_MS = 600_000;
const STALE_MS = 6 * 3_600_000;

const lists = new Map<string, { at: number; rows: MarketRow[] }>();

export function resetMarketCache(): void {
  lists.clear();
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
  const ok = (rows: MarketRow[], stale: boolean): TokensOutput => json(200, { rows, stale }, { ...headers, 'cache-control': stale ? 'no-store' : `public, s-maxage=${deep ? 600 : 60}, stale-while-revalidate=86400` });
  const deep = !recent && kind === 'top' && chain !== '';
  const fresh = deep ? DEEP_FRESH_MS : FRESH_MS;
  if (hit && input.now - hit.at < fresh) return ok(hit.rows, false);
  if (overLimit(`market:${input.ip}`, input.now)) return hit ? ok(hit.rows, true) : json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '30' });
  const source = new GeckoMarket(input.fetchImpl, () => input.now, 0, undefined, input.sleep);
  try {
    const query = { kind: kind as MarketKind, chain: chain as ChainId | '', window: window as MarketWindow };
    // Tokens whose price has gone to nothing on every network are left out here, so no list carries them.
    const rows = (recent ? await source.loadRecent(query) : await source.load({ ...query, page })).filter((r) => !isDeadMarket(r));
    if (lists.size > 400) lists.clear();
    lists.set(key, { at: input.now, rows });
    return ok(rows, false);
  } catch {
    // The source refused or failed: the last good list is better than a blank page, and it is marked as old.
    if (hit && input.now - hit.at < STALE_MS) return ok(hit.rows, true);
    return json(502, { error: 'source' }, headers);
  }
}

