/**
 * The versioned public read API, as pure routing over a MiStore. `api/_marketIndexer.ts` wraps it with HTTP concerns (env, rate
 * limit, headers, cron, admin). Every answer is `{ data, meta }`; an error is `{ error: { code, message } }`.
 *
 *   GET /api/v1                                         index of endpoints
 *   GET /api/v1/status                                  chains, DEXs, evidence levels, adapter health
 *   GET /api/v1/pools/new                               newest markets (filters: chain, dex, state, maxAgeHours, q; pagination: limit, cursor)
 *   GET /api/v1/pools/trending                          ranked by guarded activity; paid placements are returned separately in `promoted`
 *   GET /api/v1/pools/search?q=                         by symbol, name, token or pool address
 *   GET /api/v1/pools/{chain}/{address}                 one market, numbers recomputed from stored trades
 *   GET /api/v1/pools/{chain}/{address}/trades          recent trades (limit, before)
 *   GET /api/v1/pools/{chain}/{address}/candles         OHLCV from trades (tf, limit, before)
 *   GET /api/v1/tokens/{chain}/{address}                a token and every market it is in
 */
import { FEATURED } from '../../data/featured.js';
import { FEATURED_LABEL, FEATURED_NOTE, featuredNow, tokenHref } from '../../lib/featured.js';
import { chainConfig, isMiChain, MI_CHAINS, type MiChain } from './chains.js';
import { allSpecs, SOLANA_PROGRAMS } from './dexes.js';
import { poolDto, tokenDto } from './dto.js';
import { isPoolState, POOL_STATES, type MiPool, type MiToken, type PoolState } from './types.js';
import { buildCandleRows, computeStats, trendingScore } from './stats.js';
import { parseRaw } from './math.js';
import type { MiStore } from './store.js';

export interface ApiRequest {
  /** Path segments after /api/v1. */
  path: string[];
  query: Record<string, string | undefined>;
  now: number;
}
export interface ApiResponse {
  status: number;
  body: unknown;
  /** Seconds the answer may be shared by a cache; 0 means not at all. */
  cacheSeconds: number;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 25;
const TF_SECONDS: Readonly<Record<string, number>> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3_600, '4h': 14_400, '1d': 86_400 };

const err = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } }, cacheSeconds: 0 });
const ok = (data: unknown, now: number, cacheSeconds: number, extra: Record<string, unknown> = {}): ApiResponse => ({ status: 200, body: { data, meta: { version: 'v1', generatedAt: new Date(now).toISOString(), ...extra } }, cacheSeconds });

function intParam(v: string | undefined, def: number, min: number, max: number): number | null {
  if (v === undefined || v === '') return def;
  if (!/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}

export async function handleRead(store: MiStore, req: ApiRequest): Promise<ApiResponse> {
  const [a, b, c, d] = req.path;
  if (a === undefined) return indexResponse(req.now);
  if (a === 'status' && b === undefined) return status(store, req);
  if (a === 'pools') {
    if (b === 'new' && c === undefined) return listNew(store, req);
    if (b === 'trending' && c === undefined) return trending(store, req);
    if (b === 'search' && c === undefined) return search(store, req);
    if (b !== undefined && c !== undefined) {
      const ref = parseRef(b, c);
      if ('error' in ref) return ref.error;
      if (d === undefined) return poolDetail(store, req, ref);
      if (d === 'trades') return poolTrades(store, req, ref);
      if (d === 'candles') return poolCandles(store, req, ref);
    }
  }
  if (a === 'tokens' && b !== undefined && c !== undefined && d === undefined) {
    const ref = parseRef(b, c);
    return 'error' in ref ? ref.error : tokenDetail(store, req, ref);
  }
  return err(404, 'not-found', 'No such endpoint. GET /api/v1 lists them.');
}

interface Ref {
  chain: MiChain;
  address: string;
}
function parseRef(chain: string, address: string): Ref | { error: ApiResponse } {
  if (!isMiChain(chain)) return { error: err(400, 'bad-chain', `chain must be one of: ${MI_CHAINS.join(', ')}.`) };
  if (chain === 'solana') return { error: err(501, 'not-implemented', 'Solana markets are not indexed yet (see /api/v1/status).') };
  if (!EVM_ADDRESS.test(address)) return { error: err(400, 'bad-address', 'address must be a 0x-prefixed 40-hex-digit address.') };
  return { chain, address: address.toLowerCase() };
}

function indexResponse(now: number): ApiResponse {
  return ok(
    {
      endpoints: [
        'GET /api/v1/status',
        'GET /api/v1/pools/new',
        'GET /api/v1/pools/trending',
        'GET /api/v1/pools/search?q=',
        'GET /api/v1/pools/{chain}/{address}',
        'GET /api/v1/pools/{chain}/{address}/trades',
        'GET /api/v1/pools/{chain}/{address}/candles',
        'GET /api/v1/tokens/{chain}/{address}',
      ],
      docs: '/docs/market-indexer-api',
    },
    now,
    300,
  );
}

async function status(store: MiStore, req: ApiRequest): Promise<ApiResponse> {
  const health = await store.listHealth();
  const byAdapter = new Map(health.map((h) => [h.adapterId, h]));
  const disabled = await store.disabledAdapters();
  const specs = allSpecs();
  const dexes = specs.map((s) => {
    const h = byAdapter.get(s.id);
    const running = h !== undefined;
    const fresh = h?.lastSuccessAt !== null && h?.lastSuccessAt !== undefined && req.now - h.lastSuccessAt < 15 * 60_000;
    return {
      id: s.id,
      name: s.name,
      chain: s.chain,
      kind: s.kind,
      factory: s.factory,
      evidence: s.evidence,
      state: disabled.has(s.id) ? 'disabled' : !running ? 'not-running' : fresh && (h.consecutiveFailures ?? 0) === 0 ? 'ok' : (h.consecutiveFailures ?? 0) > 0 ? 'failing' : 'stale',
      lagBlocks: h?.lagBlocks ?? null,
      checkpoint: h?.checkpoint ?? null,
      lastSuccessAt: h?.lastSuccessAt ? new Date(h.lastSuccessAt).toISOString() : null,
    };
  });
  const chains = MI_CHAINS.map((id) => {
    const cfg = chainConfig(id);
    const mine = dexes.filter((x) => x.chain === id);
    const proven = mine.filter((x) => x.evidence === 'live-verified' || x.evidence === 'fixture-tested');
    return {
      id,
      name: cfg.name,
      confirmations: cfg.confirmations,
      adapters: mine.length,
      // "supported" means an adapter exists whose decoders were proven on real logs; it does not mean the adapter is switched on.
      supported: id === 'solana' ? false : proven.length > 0,
      running: mine.filter((x) => x.state === 'ok').length,
    };
  });
  return ok({ chains, dexes, solanaPrograms: SOLANA_PROGRAMS.map((p) => ({ id: p.id, name: p.name, program: p.program, evidence: p.status, note: p.note })), states: POOL_STATES }, req.now, 15);
}

async function tokensFor(store: MiStore, pools: readonly MiPool[]): Promise<Map<string, MiToken>> {
  const keys = new Set<string>();
  for (const p of pools) {
    keys.add(`${p.chain}:${p.base}`);
    keys.add(`${p.chain}:${p.quote}`);
  }
  return store.getTokens([...keys]);
}

function parseStates(raw: string | undefined, def: PoolState[]): PoolState[] | ApiResponse {
  if (raw === undefined || raw === '') return def;
  const parts = raw.split(',').map((x) => x.trim());
  if (parts.length > POOL_STATES.length || !parts.every(isPoolState)) return err(400, 'bad-state', `state must be a comma list of: ${POOL_STATES.join(', ')}.`);
  return parts as PoolState[];
}

function chainFilter(raw: string | undefined): MiChain | undefined | ApiResponse {
  if (raw === undefined || raw === '') return undefined;
  return isMiChain(raw) ? raw : err(400, 'bad-chain', `chain must be one of: ${MI_CHAINS.join(', ')}.`);
}
const isResponse = (v: unknown): v is ApiResponse => typeof v === 'object' && v !== null && 'status' in v && 'cacheSeconds' in v;

function cleanQuery(q: string | undefined): string | null | undefined {
  if (q === undefined || q === '') return undefined;
  const t = q.trim().slice(0, 64);
  return /^[\p{L}\p{N} ._:$-]{1,64}$/u.test(t) ? t : null;
}

async function listNew(store: MiStore, req: ApiRequest): Promise<ApiResponse> {
  const limit = intParam(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  if (limit === null) return err(400, 'bad-limit', `limit must be 1 to ${MAX_LIMIT}.`);
  const chain = chainFilter(req.query.chain);
  if (isResponse(chain)) return chain;
  const states = parseStates(req.query.state, ['active']);
  if (isResponse(states)) return states;
  const hours = intParam(req.query.maxAgeHours, 0, 0, 24 * 365);
  if (hours === null) return err(400, 'bad-age', 'maxAgeHours must be a whole number of hours.');
  const q = cleanQuery(req.query.q);
  if (q === null) return err(400, 'bad-query', 'q may hold letters, digits, space and . _ : $ - only (64 characters at most).');
  const dex = req.query.dex && /^[a-z]{3,20}$/.test(req.query.dex) ? req.query.dex : undefined;
  if (req.query.dex && !dex) return err(400, 'bad-dex', 'dex must be a lower-case family name such as pancakeswap.');
  const page = await store.listPools({ sort: 'newest', limit, cursor: req.query.cursor ?? null, chain, states, dex, text: q, createdAfter: hours ? req.now - hours * 3_600_000 : undefined });
  const tokens = await tokensFor(store, page.pools);
  return ok(page.pools.map((p) => poolDto(p, tokens, req.now)), req.now, 10, { nextCursor: page.nextCursor, limit });
}

async function search(store: MiStore, req: ApiRequest): Promise<ApiResponse> {
  const q = cleanQuery(req.query.q);
  if (q === undefined || q === null) return err(400, 'bad-query', 'q is required: letters, digits, space and . _ : $ - only (64 characters at most).');
  const limit = intParam(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  if (limit === null) return err(400, 'bad-limit', `limit must be 1 to ${MAX_LIMIT}.`);
  const chain = chainFilter(req.query.chain);
  if (isResponse(chain)) return chain;
  const states = parseStates(req.query.state, ['active', 'awaiting_liquidity', 'inactive']);
  if (isResponse(states)) return states;
  const page = await store.listPools({ sort: 'volume24h', limit, cursor: req.query.cursor ?? null, chain, states, text: q });
  const tokens = await tokensFor(store, page.pools);
  return ok(page.pools.map((p) => poolDto(p, tokens, req.now)), req.now, 10, { nextCursor: page.nextCursor, limit, query: q });
}

async function trending(store: MiStore, req: ApiRequest): Promise<ApiResponse> {
  const limit = intParam(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  if (limit === null) return err(400, 'bad-limit', `limit must be 1 to ${MAX_LIMIT}.`);
  const chain = chainFilter(req.query.chain);
  if (isResponse(chain)) return chain;
  const page = await store.listPools({ sort: 'volume24h', limit: 100, chain, states: ['active'] });
  const scored = page.pools
    .filter((p) => !p.paused && p.stats)
    .map((p) => ({ p, score: trendingScore({ stats: p.stats!, createdAt: p.createdAt, now: req.now }) }))
    .filter((x): x is { p: MiPool; score: number } => x.score !== null)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
  const tokens = await tokensFor(store, scored.map((x) => x.p));
  const rows = scored.map((x, i) => ({ rank: i + 1, ...poolDto(x.p, tokens, req.now) })).filter((r) => !r.base.nameFlags.includes('hidden-offensive'));
  // Paid placements are never ranked and never mixed into the list: they come back on their own, with their label.
  const promoted = featuredNow(FEATURED, req.now).map((i) => ({ label: FEATURED_LABEL, id: i.id, chain: i.chain, token: i.token, title: i.title, blurb: i.blurb, href: tokenHref(i) }));
  return ok({ ranked: rows, promoted, promotedNote: FEATURED_NOTE }, req.now, 15, {
    limit,
    method: 'Pools are ranked on one-hour dollar volume and trade count, discounted for one-sided flow, one trade dominating volume, few distinct accounts and volume far above liquidity. Pools under 10 minutes old, with fewer than 5 trades in the hour, fewer than 3 accounts in 24 hours, under $1,000 liquidity, or without a known dollar value are not ranked.',
  });
}

async function loadPool(store: MiStore, ref: Ref): Promise<MiPool | null> {
  return (await store.getPools([`${ref.chain}:${ref.address}`])).get(`${ref.chain}:${ref.address}`) ?? null;
}

async function poolDetail(store: MiStore, req: ApiRequest, ref: Ref): Promise<ApiResponse> {
  const pool = await loadPool(store, ref);
  if (!pool || pool.paused) return err(404, 'not-found', 'No such market.');
  // Numbers are recomputed from the stored trades so the page is never older than the last indexed block.
  const since = Math.floor(req.now / 1000) - 86_400;
  const [recent, prior] = await Promise.all([store.tradesSince(pool.chain, pool.address, since, 5_000), store.lastTradeBefore(pool.chain, pool.address, since)]);
  const fresh: MiPool = pool.stats ? { ...pool, stats: computeStats(pool, recent, prior, req.now, { quoteUsd: pool.stats.quoteUsd }, parseRaw(pool.reserveQuote)) ?? pool.stats } : pool;
  const siblings = (await store.listPools({ sort: 'liquidity', limit: 20, tokenKey: `${pool.chain}:${pool.base}`, states: ['active', 'awaiting_liquidity', 'inactive'] })).pools.filter((p) => p.key !== pool.key);
  const tokens = await tokensFor(store, [fresh, ...siblings]);
  const health = (await store.listHealth()).find((h) => h.adapterId === pool.adapterId);
  return ok({ pool: poolDto(fresh, tokens, req.now), otherMarketsOfToken: siblings.map((p) => poolDto(p, tokens, req.now)) }, req.now, 5, {
    indexedThroughBlock: health?.checkpoint ?? null,
    lagBlocks: health?.lagBlocks ?? null,
  });
}

async function poolTrades(store: MiStore, req: ApiRequest, ref: Ref): Promise<ApiResponse> {
  const pool = await loadPool(store, ref);
  if (!pool || pool.paused) return err(404, 'not-found', 'No such market.');
  const limit = intParam(req.query.limit, 50, 1, 200);
  if (limit === null) return err(400, 'bad-limit', 'limit must be 1 to 200.');
  const before = req.query.before === undefined ? undefined : intParam(req.query.before, 0, 1, 4_102_444_800);
  if (before === null) return err(400, 'bad-before', 'before must be a unix time in seconds.');
  const rows = await store.recentTrades(pool.chain, pool.address, limit, before === 0 ? undefined : before);
  const data = rows.map((t) => ({ id: t.id, time: new Date(t.time * 1000).toISOString(), unix: t.time, side: t.side, price: t.price, baseAmount: t.baseAmount, quoteAmount: t.quoteAmount, block: t.block, account: t.maker }));
  return ok(data, req.now, 5, { limit, baseDecimals: pool.baseDecimals, quoteDecimals: pool.quoteDecimals, nextBefore: rows.length === limit ? rows[rows.length - 1]!.time : null });
}

async function poolCandles(store: MiStore, req: ApiRequest, ref: Ref): Promise<ApiResponse> {
  const pool = await loadPool(store, ref);
  if (!pool || pool.paused) return err(404, 'not-found', 'No such market.');
  const tf = req.query.tf ?? '5m';
  const seconds = TF_SECONDS[tf];
  if (!seconds) return err(400, 'bad-timeframe', `tf must be one of: ${Object.keys(TF_SECONDS).join(', ')}.`);
  const limit = intParam(req.query.limit, 300, 1, 1000);
  if (limit === null) return err(400, 'bad-limit', 'limit must be 1 to 1000.');
  const before = req.query.before === undefined ? Math.floor(req.now / 1000) + seconds : intParam(req.query.before, 0, 1, 4_102_444_800);
  if (before === null) return err(400, 'bad-before', 'before must be a unix time in seconds.');
  const from = before - limit * seconds;
  const trades = (await store.tradesSince(pool.chain, pool.address, from, 10_000)).filter((t) => t.time < before);
  const rows = buildCandleRows(trades, seconds, pool.quoteDecimals);
  // Candles are priced in the quote token. They are in dollars only when that token is a dollar stablecoin; a pool quoted in the native
  // coin is NOT converted at today's rate (that would invent history).
  const q = chainConfig(pool.chain).quoteTokens.find((x) => x.address === pool.quote);
  const unit = q?.role === 'usd' ? 'usd' : 'quote';
  return ok(rows, req.now, 10, { timeframe: tf, unit, quoteSymbol: q?.symbol ?? null, format: '[unixSeconds, open, high, low, close, volumeInQuote]', complete: trades.length < 10_000 });
}

async function tokenDetail(store: MiStore, req: ApiRequest, ref: Ref): Promise<ApiResponse> {
  const key = `${ref.chain}:${ref.address}`;
  const token = (await store.getTokens([key])).get(key);
  if (!token) return err(404, 'not-found', 'This token has no indexed market.');
  const pools = (await store.listPools({ sort: 'liquidity', limit: 50, tokenKey: key })).pools.filter((p) => !p.paused);
  const tokens = await tokensFor(store, pools);
  const quotes = chainConfig(ref.chain).quoteTokens.map((q) => q.address);
  return ok({ token: tokenDto(token, ref.address, token.decimals, quotes.includes(ref.address)), firstSeenAt: new Date(token.firstSeenAt).toISOString(), firstTradeAt: token.firstTradeAt ? new Date(token.firstTradeAt).toISOString() : null, markets: pools.map((p) => poolDto(p, tokens, req.now)) }, req.now, 10);
}
