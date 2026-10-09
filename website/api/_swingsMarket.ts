/**
 * GET /api/swings-market?kind=&chain=&window=&page=: the Marketplace lists (trending, top, gainers), read once by the
 * server and shared. The browser used to ask GeckoTerminal itself, which allows about 30 requests a minute per visitor;
 * a busy visitor was refused and the list went blank. Here one fetch serves everyone: it is kept in the server's memory
 * for a minute, the CDN keeps the answer for the same minute, and if the source fails the last good list (up to fifteen
 * minutes old) is returned and marked stale instead of an error. The data is public, so no sign-in is involved.
 */
import { overLimit } from './_rpcProxy.js';
import { isChainId, type ChainId } from '../src/swings/core/types.js';
import { GeckoMarket, type MarketKind, type Window as MarketWindow } from '../src/swings/market/gecko.js';
import type { MarketRow } from '../src/swings/market/types.js';
import type { TokensInput, TokensOutput } from './_swingsTokens.js';

const KINDS: readonly string[] = ['trending', 'top', 'gainers'];
const WINDOWS: readonly string[] = ['m5', 'h1', 'h6', 'h24'];
const FRESH_MS = 60_000;
const STALE_MS = 15 * 60_000;

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
  const key = `${kind}|${chain}|${window}|${page}`;
  const hit = lists.get(key);
  const ok = (rows: MarketRow[], stale: boolean): TokensOutput => json(200, { rows, stale }, { ...headers, 'cache-control': stale ? 'no-store' : 'public, s-maxage=60, stale-while-revalidate=300' });
  if (hit && input.now - hit.at < FRESH_MS) return ok(hit.rows, false);
  if (overLimit(`market:${input.ip}`, input.now)) return hit ? ok(hit.rows, true) : json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '30' });
  const source = new GeckoMarket(input.fetchImpl, () => input.now, 0);
  try {
    const rows = await source.load({ kind: kind as MarketKind, chain: chain as ChainId | '', window: window as MarketWindow, page });
    if (lists.size > 400) lists.clear();
    lists.set(key, { at: input.now, rows });
    return ok(rows, false);
  } catch {
    // The source refused or failed: the last good list is better than a blank page, and it is marked as old.
    if (hit && input.now - hit.at < STALE_MS) return ok(hit.rows, true);
    return json(502, { error: 'source' }, headers);
  }
}

