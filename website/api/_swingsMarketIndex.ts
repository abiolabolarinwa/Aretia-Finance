/**
 * GET /api/swings-market?src=index&kind=&chain=&window=&sort=&dir=&page=&size=&minLiq=&maxAgeHours=: a Markets list read from Aretia's
 * own Market Indexer with real paging. Answers { rows, total, page, size, pages, note, source: 'index' }. Shared by everyone: the
 * server keeps each answer for 30 seconds and the CDN for the same, serving an older one while it refreshes. When the database is
 * unreachable the answer is 200 with no rows and an error flag, so the page falls back to its other source instead of showing a blank.
 */
import { overLimit } from './_rpcProxy.js';
import { supabaseBase, supabaseHeaders } from '../src/swings/tokens/supabaseAuth.js';
import { isMiChain } from '../src/swings/mi/chains.js';
import { LIST_KINDS, LIST_SORTS, LIST_WINDOWS, MAX_RESULT, PAGE_SIZES, postgrestReader, readList, type ListAnswer, type ListKind, type ListQuery, type ListSort, type ListWindow } from '../src/swings/mi/marketList.js';
import type { TokensInput, TokensOutput } from './_swingsTokens.js';

const FRESH_MS = 30_000;
const STALE_MS = 3_600_000;
const DEADLINE_MS = 12_000;
const answers = new Map<string, { at: number; answer: ListAnswer }>();
export function resetMarketIndexCache(): void {
  answers.clear();
}

const json = (status: number, data: unknown, headers: Record<string, string>): TokensOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });

/** The query of a request, or null when it is not one the reader serves. */
export function parseListQuery(query: Record<string, string | undefined>): ListQuery | null {
  const kind = (query.kind ?? 'trending') as ListKind;
  const window = (query.window ?? 'h24') as ListWindow;
  const sort = (query.sort ?? 'rank') as ListSort;
  const chain = query.chain ?? '';
  const page = Math.floor(Number(query.page ?? '1'));
  const size = Math.floor(Number(query.size ?? '50'));
  const minLiquidityUsd = Number(query.minLiq ?? '0');
  const maxAgeHours = Number(query.maxAgeHours ?? '0');
  if (!LIST_KINDS.includes(kind) || !LIST_WINDOWS.includes(window) || !LIST_SORTS.includes(sort)) return null;
  if (chain !== '' && !isMiChain(chain)) return null;
  if (query.dir !== undefined && query.dir !== 'asc' && query.dir !== 'desc') return null;
  if (!Number.isFinite(page) || page < 1 || !PAGE_SIZES.includes(size) || page * size > MAX_RESULT + size) return null;
  if (!Number.isFinite(minLiquidityUsd) || minLiquidityUsd < 0 || minLiquidityUsd > 1e9) return null;
  if (!Number.isFinite(maxAgeHours) || maxAgeHours < 0 || maxAgeHours > 24 * 365) return null;
  return { kind, chain: chain as ListQuery['chain'], window, sort, dir: query.dir === 'asc' ? 'asc' : 'desc', page, size, minLiquidityUsd: Math.max(100, Math.floor(minLiquidityUsd)), maxAgeHours: Math.floor(maxAgeHours) };
}

export async function handleMarketIndex(input: TokensInput): Promise<TokensOutput> {
  const base: Record<string, string> = { 'cache-control': 'no-store' };
  if (input.method !== 'GET') return json(405, { error: 'method' }, { ...base, allow: 'GET' });
  const q = parseListQuery(input.query);
  if (!q) return json(400, { error: 'bad-request' }, base);
  const env = input.env as { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string; MI_DATA_URL?: string; MI_DATA_SERVICE_ROLE_KEY?: string };
  const own = Boolean(env.MI_DATA_URL?.trim() && env.MI_DATA_SERVICE_ROLE_KEY?.trim());
  const url = supabaseBase(own ? env.MI_DATA_URL : env.SUPABASE_URL);
  const key = (own ? env.MI_DATA_SERVICE_ROLE_KEY : env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  const empty = (error: string): TokensOutput => json(200, { rows: [], total: 0, page: q.page, size: q.size, pages: 1, note: '', source: 'index', error }, base);
  if (!url || !key) return empty('not-configured');
  // The window only changes a list that ranks by it; leaving it out of the other keys shares one answer between 5M, 1H, 6H and 24H.
  const windowed = q.kind === 'gainers' || q.kind === 'trending' || q.sort === 'change';
  const cacheKey = [q.kind, q.chain, windowed ? q.window : '-', q.sort, q.dir, q.page, q.size, q.minLiquidityUsd, q.maxAgeHours].join('|');
  const ok = (a: ListAnswer, stale: boolean): TokensOutput => json(200, { ...a, source: 'index', stale, at: input.now }, { ...base, 'cache-control': stale ? 'no-store' : 'public, s-maxage=30, stale-while-revalidate=600' });
  const hit = answers.get(cacheKey);
  if (hit && input.now - hit.at < FRESH_MS) return ok(hit.answer, false);
  if (overLimit(`marketix:${input.ip}`, input.now)) return hit ? ok(hit.answer, true) : json(429, { error: 'rate-limit' }, { ...base, 'retry-after': '30' });
  try {
    const answer = await readList(postgrestReader(url, supabaseHeaders(key), input.fetchImpl, AbortSignal.timeout(DEADLINE_MS)), q, input.now);
    if (answers.size > 500) answers.clear();
    answers.set(cacheKey, { at: input.now, answer });
    return ok(answer, false);
  } catch {
    if (hit && input.now - hit.at < STALE_MS) return ok(hit.answer, true);
    return empty('index');
  }
}
