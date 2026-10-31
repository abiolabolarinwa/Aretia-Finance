/**
 * The public shape of the read API (v1). Pure: stored records in, JSON-safe objects out. Nothing here invents a number: where
 * the indexer does not know a value the field is null, and every market carries the evidence level of the adapter that found it.
 */
import { isOffensive, reservedNameClaim, hasLookalikeLetters } from '../tokens/safeText.js';
import { chainConfig, isMiChain } from './chains.js';
import { adapterById } from './dexes.js';
import type { MiPool, MiToken, PoolKind, PoolStats } from './types.js';

export interface TokenDto {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Set when Aretia Launch Box created the token (verified on-chain at association time). */
  launchbox: { key: string } | null;
  /** Reasons to be careful with the NAME, never a judgement of the project: 'impersonation' (claims a reserved symbol such as USDC), 'lookalike-letters', 'hidden-offensive'. */
  nameFlags: string[];
}

export interface PoolDto {
  id: string;
  chain: string;
  address: string;
  dex: string;
  dexName: string;
  kind: PoolKind;
  feeTier: number | null;
  state: string;
  stateReason: string;
  /** Null when the market was added on request and its creation time was not read (it is older than the index). */
  createdAt: string | null;
  ageSeconds: number | null;
  base: TokenDto;
  quote: TokenDto;
  price: { quote: string | null; usd: number | null };
  /** Percent change over each window (e.g. 12.5 means +12.5%), null when it cannot be stated. For a pool younger than a window it is measured from its first trade. */
  changePct: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  volume: { quote: PoolStats['volumeQuote'] | null; usd: PoolStats['volumeUsd'] | null };
  txns: { buys: PoolStats['buys'] | null; sells: PoolStats['sells'] | null };
  /** For V3 pools this is the quote-token balance held by the pool times two, which can overstate usable depth. */
  liquidity: { quote: number | null; usd: number | null };
  firstTradeAt: string | null;
  lastTradeAt: string | null;
  statsAsOf: string | null;
  evidence: string;
  /** True when the quote token is a dollar stablecoin, so dollar prices and candles are exact rather than derived. */
  quoteIsDollar: boolean;
  links: { swap: string };
}

export function tokenDto(t: MiToken | undefined, fallbackAddress: string, decimals: number, known = false): TokenDto {
  if (!t) return { address: fallbackAddress, symbol: '', name: '', decimals, launchbox: null, nameFlags: [] };
  const flags: string[] = [];
  // The chain's own recognised quote tokens (the real USDC, the real wrapped native coin) are the genuine article, not impersonators.
  if (!known && reservedNameClaim(t.symbol, t.name)) flags.push('impersonation');
  if (!known && hasLookalikeLetters(t.symbol, t.name)) flags.push('lookalike-letters');
  const hide = isOffensive(t.symbol, t.name);
  if (hide) flags.push('hidden-offensive');
  return { address: t.address, symbol: hide ? '' : t.symbol, name: hide ? '' : t.name, decimals: t.decimals, launchbox: t.launchboxKey ? { key: t.launchboxKey } : null, nameFlags: flags };
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const pct = (bps: number | null | undefined): number | null => (bps === null || bps === undefined ? null : bps / 100);

export function poolDto(p: MiPool, tokens: Map<string, MiToken>, now: number): PoolDto {
  const s = p.stats;
  const quoteTokens = isMiChain(p.chain) ? chainConfig(p.chain).quoteTokens : [];
  const quotes = quoteTokens.map((q) => q.address);
  return {
    id: p.key,
    chain: p.chain,
    address: p.address,
    dex: p.dex,
    dexName: adapterById(p.adapterId)?.name ?? p.dex,
    kind: p.kind,
    feeTier: p.feeTier,
    state: p.state,
    stateReason: p.stateReason,
    createdAt: p.createdAt > 0 ? new Date(p.createdAt).toISOString() : null,
    ageSeconds: p.createdAt > 0 ? Math.max(0, Math.floor((now - p.createdAt) / 1000)) : null,
    base: tokenDto(tokens.get(`${p.chain}:${p.base}`), p.base, p.baseDecimals, quotes.includes(p.base)),
    quote: tokenDto(tokens.get(`${p.chain}:${p.quote}`), p.quote, p.quoteDecimals, quotes.includes(p.quote)),
    price: { quote: s?.price ?? null, usd: s?.priceUsd ?? null },
    changePct: { m5: pct(s?.change.m5), h1: pct(s?.change.h1), h6: pct(s?.change.h6), h24: pct(s?.change.h24) },
    volume: { quote: s?.volumeQuote ?? null, usd: s?.volumeUsd ?? null },
    txns: { buys: s?.buys ?? null, sells: s?.sells ?? null },
    liquidity: { quote: s?.liquidityQuote ?? null, usd: s?.liquidityUsd ?? null },
    firstTradeAt: iso(p.firstTradeAt),
    lastTradeAt: iso(p.lastTradeAt),
    statsAsOf: s ? new Date(s.asOf).toISOString() : null,
    evidence: adapterById(p.adapterId)?.evidence ?? 'planned',
    quoteIsDollar: quoteTokens.some((q) => q.address === p.quote && q.role === 'usd'),
    // A route into the wallet's swap screen with the token chosen. Nothing is executed: the person reviews and signs there.
    links: { swap: `/wallet#/swap/${p.chain}/${p.base}` },
  };
}
