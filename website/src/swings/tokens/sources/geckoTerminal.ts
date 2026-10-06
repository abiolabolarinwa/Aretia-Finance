/**
 * Discovery source: GeckoTerminal's "new pools" feed, one instance per chain. It gives a defensible
 * timestamp (the pool's creation time) and first liquidity/volume figures. It is a third-party index:
 * everything it says about a token is treated as untrusted and re-checked on-chain by the enricher.
 * It reports the pool's base token only; a new token that appears only as the quote side is not seen.
 */
import { normalizeTokenRef } from '../../core/token.js';
import type { ChainId } from '../../core/types.js';
import type { TokenCandidate } from '../registry.js';
import type { DiscoveryBatch, DiscoverySource } from '../discovery.js';

const NETWORK: Readonly<Record<ChainId, string>> = { solana: 'solana', ethereum: 'eth', bnb: 'bsc', polygon: 'polygon_pos', base: 'base' };
const BASE_URL = 'https://api.geckoterminal.com/api/v2';

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const idTail = (v: unknown, prefix: string): string | null => {
  const id = obj(obj(v)?.data)?.id;
  return typeof id === 'string' && id.startsWith(prefix + '_') ? id.slice(prefix.length + 1) : null;
};

/** Pure parser, exported for tests. Skips anything malformed. */
export function parseNewPools(chain: ChainId, json: unknown): { candidates: TokenCandidate[]; newest: string | null } {
  const root = obj(json);
  const net = NETWORK[chain];
  const included = new Map<string, Record<string, unknown>>();
  if (Array.isArray(root?.included)) {
    for (const item of root.included) {
      const o = obj(item);
      const a = obj(o?.attributes);
      if (o?.type === 'token' && a && typeof a.address === 'string') included.set(a.address.toLowerCase(), a);
    }
  }
  const candidates: TokenCandidate[] = [];
  let newest: string | null = null;
  for (const pool of Array.isArray(root?.data) ? root.data : []) {
    const p = obj(pool);
    const a = obj(p?.attributes);
    const rel = obj(p?.relationships);
    if (!p || !a) continue;
    const tokenAddress = idTail(rel?.base_token, net);
    const created = typeof a.pool_created_at === 'string' ? Date.parse(a.pool_created_at) : Number.NaN;
    const ref = normalizeTokenRef(chain, tokenAddress);
    if (!ref || !Number.isFinite(created) || typeof a.address !== 'string') continue;
    const meta = included.get(ref.address.toLowerCase());
    candidates.push({
      ref,
      symbol: typeof meta?.symbol === 'string' ? meta.symbol : null,
      name: typeof meta?.name === 'string' ? meta.name : null,
      decimals: typeof meta?.decimals === 'number' ? meta.decimals : null,
      logo: typeof meta?.image_url === 'string' ? meta.image_url : null,
      firstPoolAt: created,
      pool: { venue: String(obj(obj(rel?.dex)?.data)?.id ?? 'unknown'), address: a.address },
      liquidityUsd: num(a.reserve_in_usd),
      volume24hUsd: num(obj(a.volume_usd)?.h24),
      source: 'geckoterminal:new_pools',
    });
    const iso = new Date(created).toISOString();
    if (newest === null || iso > newest) newest = iso;
  }
  return { candidates, newest };
}

export class GeckoTerminalNewPoolsSource implements DiscoverySource {
  readonly id: string;
  constructor(
    readonly chain: ChainId,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.id = `geckoterminal:new_pools:${chain}`;
  }

  async poll(cursor: string | null, signal?: AbortSignal): Promise<DiscoveryBatch> {
    const res = await this.fetchImpl(`${BASE_URL}/networks/${NETWORK[this.chain]}/new_pools?include=base_token&page=1`, { headers: { accept: 'application/json' }, signal });
    if (!res.ok) throw new Error(`GeckoTerminal answered ${res.status} for ${this.chain}.`);
    const { candidates, newest } = parseNewPools(this.chain, await res.json());
    const since = cursor === null ? Number.NEGATIVE_INFINITY : Date.parse(cursor);
    const fresh = candidates.filter((c) => (c.firstPoolAt ?? 0) > since);
    return { candidates: fresh, nextCursor: newest !== null && (cursor === null || newest > cursor) ? newest : null };
  }
}
