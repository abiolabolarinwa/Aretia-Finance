/**
 * Live numbers for Launch Box rows: a pool's price, change, volume and liquidity from DexScreener (by token address, in batches), and an
 * Aretia Curve's status and progress read from the chain. Nothing is invented: a token with no pool has no price, and the row says so.
 */
import { EVM_CURVE, selector, type CurveView, type EvmLaunchChain, type LaunchChain, type LaunchView, type PoolView } from './core.js';
import type { StoredLaunch } from './store.js';
import { choosePricePool, majorsOf } from '../charts/pool.js';
import { cleanText } from '../tokens/safeText.js';

const DEX_CHAIN: Readonly<Record<LaunchChain, string>> = { solana: 'solana', bnb: 'bsc', ethereum: 'ethereum', polygon: 'polygon' };
const BATCH = 30;

export interface MarketInfo {
  priceUsd: number | null;
  change24h: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  capUsd: number | null;
  capKind: 'mcap' | 'fdv' | null;
  pool: PoolView;
}

interface Pair {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  priceChange?: { h24?: number };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const httpsUrl = (u: unknown): string | null => (typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u) && u.length < 300 ? u : null);

/**
 * Picks, for each requested token (the token as the pool's base), the pool its numbers come from (charts/pool.ts `choosePricePool`): the
 * deepest pool paired with a major quote token (a main stablecoin or the wrapped native coin) when it holds at least $1,000 and 5% of the
 * token's deepest pool, otherwise the deepest pool. A pool's reported liquidity can be inflated by a made-up token on the other side, so
 * a price that is not major-backed never shows liquidity or market cap: the row names the quote token instead (`quoteMajor: false`).
 * Tokens with no pool are absent from the map.
 */
export function bestPools(pairs: readonly Pair[], chain: LaunchChain, addresses: readonly string[]): Map<string, MarketInfo> {
  const want = new Map(addresses.map((a) => [chain === 'solana' ? a : a.toLowerCase(), a]));
  const majors = majorsOf(chain);
  const byToken = new Map<string, { p: Pair & { pairAddress: string; dexId: string }; major: boolean; liq: number }[]>();
  for (const p of pairs) {
    if (p.chainId !== DEX_CHAIN[chain]) continue;
    const base = p.baseToken?.address;
    if (typeof base !== 'string') continue;
    const key = chain === 'solana' ? base : base.toLowerCase();
    if (!want.has(key) || typeof p.pairAddress !== 'string' || typeof p.dexId !== 'string') continue;
    const major = typeof p.quoteToken?.address === 'string' && majors.has(p.quoteToken.address.toLowerCase());
    byToken.set(key, [...(byToken.get(key) ?? []), { p: p as Pair & { pairAddress: string; dexId: string }, major, liq: finite(p.liquidity?.usd) ?? 0 }]);
  }
  const out = new Map<string, MarketInfo>();
  for (const [key, pools] of byToken) {
    const chosen = choosePricePool(pools);
    if (!chosen) continue;
    const { p } = chosen.pool;
    const major = chosen.majorBacked;
    const price = typeof p.priceUsd === 'string' ? Number(p.priceUsd) : NaN;
    const mcap = finite(p.marketCap);
    const fdv = finite(p.fdv);
    const quoteSymbol = typeof p.quoteToken?.symbol === 'string' ? cleanText(p.quoteToken.symbol, 16) || null : null;
    out.set(key, {
      priceUsd: Number.isFinite(price) && price > 0 ? price : null,
      change24h: finite(p.priceChange?.h24),
      volume24hUsd: finite(p.volume?.h24),
      liquidityUsd: major ? finite(p.liquidity?.usd) : null,
      capUsd: major ? (mcap ?? fdv) : null,
      capKind: !major ? null : mcap !== null ? 'mcap' : fdv !== null ? 'fdv' : null,
      pool: { dex: p.dexId.slice(0, 40), address: p.pairAddress.slice(0, 80), url: httpsUrl(p.url) ?? '', quoteSymbol, quoteMajor: major },
    });
  }
  return out;
}

/** DexScreener's pools for these tokens. Throws if it cannot be asked, so the caller can say "unavailable" instead of "no market". */
export async function fetchPools(fetchImpl: typeof fetch, chain: LaunchChain, addresses: readonly string[]): Promise<Map<string, MarketInfo>> {
  const out = new Map<string, MarketInfo>();
  for (let i = 0; i < addresses.length; i += BATCH) {
    const slice = addresses.slice(i, i + BATCH);
    const res = await fetchImpl(`https://api.dexscreener.com/tokens/v1/${DEX_CHAIN[chain]}/${slice.map(encodeURIComponent).join(',')}`, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`DexScreener answered ${res.status}.`);
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) throw new Error('DexScreener gave an unexpected answer.');
    for (const [k, v] of bestPools(body as Pair[], chain, slice)) out.set(k, v);
  }
  return out;
}

// ---------------------------------------------------------------- curves

const CURVES_SELECTOR = selector('curves(address)');
const STATUSES = ['none', 'trading', 'soldOut', 'migrated', 'aborted'] as const;

/** Decodes `curves(address)`: thirteen 32-byte words. Null for anything else; "none" means no curve exists for the token. */
export function decodeCurve(hex: unknown): CurveView | 'none' | null {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{832}$/.test(hex)) return null;
  const w = (i: number): bigint => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
  const code = w(0);
  if (code > 4n) return null;
  const status = STATUSES[Number(code)]!;
  if (status === 'none') return 'none';
  const curveTokens = w(7);
  const realTok = w(12);
  if (realTok > curveTokens) return null;
  // Tokens sold so far as a share of the tokens the curve was given, to a hundredth of a percent.
  const pct = curveTokens === 0n ? 0 : Number(((curveTokens - realTok) * 10000n) / curveTokens) / 100;
  return { status, progressPct: status === 'migrated' ? 100 : pct };
}

/** Reads the curve of each token with one batched JSON-RPC request. Returns "unknown" per token when the node could not answer. */
export async function readCurves(fetchImpl: typeof fetch, rpcUrl: string, tokens: readonly string[]): Promise<Map<string, CurveView | 'none' | 'unknown'>> {
  const out = new Map<string, CurveView | 'none' | 'unknown'>();
  for (let i = 0; i < tokens.length; i += 25) {
    const slice = tokens.slice(i, i + 25);
    try {
      const res = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(slice.map((t, n) => ({ jsonrpc: '2.0', id: n, method: 'eth_call', params: [{ to: EVM_CURVE, data: CURVES_SELECTOR + t.slice(2).toLowerCase().padStart(64, '0') }, 'latest'] }))),
        signal: AbortSignal.timeout(8000),
      });
      const body = (await res.json()) as { id?: number; result?: unknown }[];
      if (!res.ok || !Array.isArray(body)) throw new Error('batch refused');
      const byId = new Map(body.map((b) => [b.id, b.result]));
      slice.forEach((t, n) => out.set(t.toLowerCase(), decodeCurve(byId.get(n)) ?? 'unknown'));
    } catch {
      for (const t of slice) out.set(t.toLowerCase(), 'unknown');
    }
  }
  return out;
}

export const evmChainOf = (c: LaunchChain): c is EvmLaunchChain => c !== 'solana';

// ---------------------------------------------------------------- merge

export function toView(t: StoredLaunch, market: MarketInfo | null | undefined, marketOk: boolean, curve: CurveView | 'none' | 'unknown' | undefined): LaunchView {
  const stored: PoolView | null = t.poolDex && t.poolAddress ? { dex: t.poolDex, address: t.poolAddress, url: t.poolUrl ?? '' } : null;
  return {
    chain: t.chain,
    address: t.address,
    name: t.name,
    symbol: t.symbol,
    decimals: t.decimals,
    supply: t.supply,
    creator: t.creator,
    createdAt: t.createdAt,
    tx: t.tx,
    priceUsd: market?.priceUsd ?? null,
    change24h: market?.change24h ?? null,
    volume24hUsd: market?.volume24hUsd ?? null,
    liquidityUsd: market?.liquidityUsd ?? null,
    capUsd: market?.capUsd ?? null,
    capKind: market?.capKind ?? null,
    // A pool seen live; when the market source was down, the one seen last time.
    pool: market ? market.pool : marketOk ? null : stored,
    curve: curve && curve !== 'none' && curve !== 'unknown' ? curve : null,
    market: !marketOk ? 'unavailable' : market ? 'ok' : 'none',
    curveRead: curve !== undefined && curve !== 'unknown',
  };
}
