/**
 * The wallet's token search: one box that finds both brand-new tokens (Aretia's own registry of what it has just
 * detected) and established ones (GeckoTerminal's search across the networks Swings supports), by name, symbol or
 * contract address. Results are merged, de-duplicated, ranked by how much money is in the pool, and cleaned: abusive
 * names are dropped, and an address is only ever shown as typed by the source, never guessed.
 *
 * A search result is a pointer, not an endorsement: it says a token exists and where, nothing about whether it is safe.
 */
import { GECKO_NETWORK } from '../charts/pool.js';
import { CHAIN_IDS, type ChainId } from '../core/types.js';
import { isOffensive, isUnsafeName } from './safeText.js';

export interface SearchHit {
  chain: ChainId;
  address: string;
  symbol: string;
  name: string;
  icon: string | null;
  decimals: number | null;
  liquidityUsd: number | null;
  priceUsd: number | null;
  /** Found in Aretia's registry of newly detected tokens. */
  fresh: boolean;
  /** Aretia's risk label for it, when the registry has assessed it. */
  risk: string | null;
}

const NETWORK_TO_CHAIN = new Map<string, ChainId>(CHAIN_IDS.map((c) => [GECKO_NETWORK[c], c]));

const safeIcon = (v: unknown): string | null => (typeof v === 'string' && /^https:\/\//.test(v) && v.length < 500 ? v : null);
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown, max: number): string => (typeof v === 'string' ? [...v].filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127).join('').trim().slice(0, max) : '');
const key = (chain: ChainId, address: string): string => `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`;

interface GeckoToken {
  id?: string;
  type?: string;
  attributes?: { address?: string; name?: string; symbol?: string; decimals?: number; image_url?: string | null };
}
interface GeckoPool {
  attributes?: { reserve_in_usd?: string; base_token_price_usd?: string };
  relationships?: { base_token?: { data?: { id?: string } }; network?: { data?: { id?: string } } };
}

/** Reads GeckoTerminal's pool search into tokens (the base token of each pool). Anything unexpected is skipped. */
export function parseGeckoSearch(body: unknown): SearchHit[] {
  const b = body as { data?: GeckoPool[]; included?: GeckoToken[] } | null;
  if (!b || !Array.isArray(b.data)) return [];
  const tokens = new Map<string, GeckoToken>();
  for (const t of b.included ?? []) if (t && t.type === 'token' && typeof t.id === 'string') tokens.set(t.id, t);
  const out: SearchHit[] = [];
  for (const pool of b.data) {
    const tokenId = pool.relationships?.base_token?.data?.id;
    // The search answer does not always name the network on each pool; the token's own id always starts with it ("solana_<mint>").
    const chain = NETWORK_TO_CHAIN.get(String(pool.relationships?.network?.data?.id ?? '')) ?? (typeof tokenId === 'string' ? [...NETWORK_TO_CHAIN].find(([id]) => tokenId.startsWith(`${id}_`))?.[1] : undefined);
    const t = typeof tokenId === 'string' ? tokens.get(tokenId) : undefined;
    const address = t?.attributes?.address;
    if (!chain || !t || typeof address !== 'string' || address.length < 20) continue;
    if (chain !== 'solana' && !/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
    const symbol = text(t.attributes?.symbol, 20);
    const name = text(t.attributes?.name, 60);
    if (!symbol || isUnsafeName(symbol, name)) continue;
    const decimals = t.attributes?.decimals;
    out.push({ chain, address, symbol, name, icon: safeIcon(t.attributes?.image_url), decimals: typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : null, liquidityUsd: num(pool.attributes?.reserve_in_usd), priceUsd: num(pool.attributes?.base_token_price_usd), fresh: false, risk: null });
  }
  return out;
}

interface RegistryResult {
  record?: { ref?: { chain?: string; address?: string }; symbol?: string; name?: string; logo?: string | null; decimals?: number | null; liquidityUsd?: number | null; risk?: { status?: string } | null };
}

export function parseRegistrySearch(body: unknown): SearchHit[] {
  const results = (body as { results?: RegistryResult[] } | null)?.results;
  if (!Array.isArray(results)) return [];
  const out: SearchHit[] = [];
  for (const r of results) {
    const rec = r.record;
    const chain = rec?.ref?.chain as ChainId | undefined;
    const address = rec?.ref?.address;
    if (!rec || !chain || !CHAIN_IDS.includes(chain) || typeof address !== 'string') continue;
    const symbol = text(rec.symbol, 20);
    const name = text(rec.name, 60);
    if (!symbol || symbol === '[hidden]' || isUnsafeName(symbol, name)) continue;
    out.push({ chain, address, symbol, name, icon: safeIcon(rec.logo), decimals: typeof rec.decimals === 'number' ? rec.decimals : null, liquidityUsd: num(rec.liquidityUsd), priceUsd: null, fresh: true, risk: typeof rec.risk?.status === 'string' ? rec.risk.status : null });
  }
  return out;
}

/** Merges both sources: the registry's version wins for a token found in both; ranked by liquidity; at most `limit`. */
export function mergeHits(registry: SearchHit[], gecko: SearchHit[], limit = 10): SearchHit[] {
  const seen = new Map<string, SearchHit>();
  for (const h of gecko) {
    const k = key(h.chain, h.address);
    const prev = seen.get(k);
    if (!prev || (h.liquidityUsd ?? 0) > (prev.liquidityUsd ?? 0)) seen.set(k, h);
  }
  for (const h of registry) {
    const k = key(h.chain, h.address);
    const g = seen.get(k);
    seen.set(k, g ? { ...g, fresh: true, risk: h.risk, icon: g.icon ?? h.icon, decimals: g.decimals ?? h.decimals } : h);
  }
  return [...seen.values()].sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1)).slice(0, limit);
}

export async function searchTokens(query: string, fetchImpl: typeof fetch = (...a) => fetch(...a), signal?: AbortSignal): Promise<SearchHit[]> {
  const q = query.trim().slice(0, 80);
  if (q.length < 2 || isOffensive(q)) return [];
  const [registry, gecko] = await Promise.allSettled([
    fetchImpl(`/api/swings-tokens?q=${encodeURIComponent(q)}`, { signal }).then((r) => (r.ok ? r.json() : null)).then(parseRegistrySearch),
    fetchImpl(`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(q)}&include=base_token&page=1`, { headers: { accept: 'application/json' }, signal }).then((r) => (r.ok ? r.json() : null)).then(parseGeckoSearch),
  ]);
  return mergeHits(registry.status === 'fulfilled' ? registry.value : [], gecko.status === 'fulfilled' ? gecko.value : []);
}
