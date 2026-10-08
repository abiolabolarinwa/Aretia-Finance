/**
 * Which pool the chart shows, and what the header says about it, both taken from DexScreener, because the chart itself
 * is DexScreener's. Using one source for both is what keeps the header and the chart saying the same thing: the header
 * names the exact pair that is drawn (for example "SOL / USDC") and quotes the price of that pair's first token.
 *
 * Choosing the pool: a chart prices the pair's FIRST token, so the pool chosen is, whenever there is a reasonable one,
 * one where the token being looked at is that first token (a chart of USDC shows USDC, not SOL priced in USDC). A
 * pool is "reasonable" if it holds at least 5% of the deepest pool's money (and at least $1,000), so a tiny pool is
 * never preferred to a real one. Among those, pools paired with a major token (a main stablecoin or the wrapped native
 * coin) come first, then depth: a pool's reported liquidity can be inflated by a made-up token on the other side.
 * Only if the token is never the first token anywhere does it fall back to the deepest pool, and then the header says
 * plainly which pair is drawn.
 *
 * Only the token's address goes to the service. Nothing about the wallet does.
 */
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type ChainId } from '../core/types.js';
import { DEXSCREENER_CHAIN, GECKO_NETWORK, majorsOf, type PoolInfo } from './pool.js';

interface DexPair {
  chainId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string | number;
  priceChange?: { h24?: number | string };
  volume?: { h24?: number | string };
  liquidity?: { usd?: number | string };
  txns?: { h24?: { buys?: number; sells?: number } };
  info?: { imageUrl?: string };
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const lc = (v: string | undefined): string => (v ?? '').toLowerCase();
const cleanSymbol = (v: unknown): string => (typeof v === 'string' ? [...v].filter((c) => c.charCodeAt(0) > 31).join('').trim().slice(0, 20) : '');

/** Picks the pair to draw for a token. Pure. */
export function pickDexPair(chain: ChainId, address: string, pairs: unknown): PoolInfo | null {
  if (!Array.isArray(pairs)) return null;
  const slug = DEXSCREENER_CHAIN[chain];
  const token = chain === 'solana' ? address : address.toLowerCase();
  const same = (a: string | undefined): boolean => (chain === 'solana' ? (a ?? '') === token : lc(a) === token);
  const majors = majorsOf(chain);
  const usable = (pairs as DexPair[])
    .filter((p) => p && p.chainId === slug && typeof p.pairAddress === 'string' && /^[A-Za-z0-9]{20,}$/.test(p.pairAddress) && p.baseToken && p.quoteToken && (same(p.baseToken.address) || same(p.quoteToken.address)))
    .map((p) => ({ p, isBase: same(p.baseToken!.address), liq: num(p.liquidity?.usd) ?? 0, paired: majors.has(lc(same(p.baseToken!.address) ? p.quoteToken!.address : p.baseToken!.address)), vol: num(p.volume?.h24) ?? 0 }));
  if (usable.length === 0) return null;
  const deepest = Math.max(...usable.map((x) => x.liq));
  const reasonable = usable.filter((x) => x.isBase && x.liq >= Math.max(1000, deepest * 0.05));
  const order = (a: (typeof usable)[number], b: (typeof usable)[number]): number => (a.paired === b.paired ? 0 : a.paired ? -1 : 1) || b.liq - a.liq || b.vol - a.vol;
  const best = (reasonable.length > 0 ? reasonable : usable).sort(order)[0]!;
  const p = best.p;
  const price = num(p.priceUsd);
  const buys = p.txns?.h24?.buys;
  const sells = p.txns?.h24?.sells;
  const baseSymbol = cleanSymbol(p.baseToken!.symbol) || 'Token';
  const quoteSymbol = cleanSymbol(p.quoteToken!.symbol) || 'Token';
  const image = p.info?.imageUrl;
  return {
    network: GECKO_NETWORK[chain],
    pool: p.pairAddress!,
    poolName: `${baseSymbol} / ${quoteSymbol}`,
    priceUsd: price !== null && price > 0 ? price : null,
    change24h: num(p.priceChange?.h24),
    volume24hUsd: num(p.volume?.h24),
    liquidityUsd: best.liq > 0 ? best.liq : null,
    trades24h: typeof buys === 'number' && typeof sells === 'number' ? buys + sells : null,
    baseSymbol,
    quoteSymbol,
    targetIsBase: best.isBase,
    icon: typeof image === 'string' && /^https:\/\//.test(image) ? image : null,
  };
}

export interface PoolFinder {
  find(chain: ChainId, address: string, signal?: AbortSignal, fresh?: boolean): Promise<PoolInfo>;
}

export class DexScreenerPoolFinder implements PoolFinder {
  private readonly cache = new Map<string, { at: number; info: PoolInfo }>();

  constructor(
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly base = 'https://api.dexscreener.com',
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 20_000,
  ) {}

  async find(chain: ChainId, address: string, signal?: AbortSignal, fresh = false): Promise<PoolInfo> {
    const ref = normalizeTokenRef(chain, address);
    if (!ref) throw new SwingsError('invalid', 'That is not a valid token address.');
    const key = `${chain}:${ref.address}`;
    const hit = this.cache.get(key);
    if (hit && !fresh && this.now() - hit.at < this.ttlMs) return hit.info;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/tokens/v1/${DEXSCREENER_CHAIN[chain]}/${encodeURIComponent(ref.address)}`, { headers: { accept: 'application/json' }, signal });
    } catch {
      throw new SwingsError('provider-failed', 'The price service could not be reached. It may be busy; try again in a minute.');
    }
    if (!res.ok) throw new SwingsError('provider-failed', res.status === 429 ? 'The price service is busy. Try again in a minute.' : `The price service answered ${res.status}.`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new SwingsError('provider-failed', 'The price service returned something unreadable.');
    }
    const info = pickDexPair(chain, ref.address, body);
    if (!info) throw new SwingsError('no-route', 'No trading pool was found for this token.');
    this.cache.set(key, { at: this.now(), info });
    return info;
  }
}
