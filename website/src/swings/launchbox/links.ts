/**
 * Keeps the pool and curve links of stored tokens up to date, so a token's row can point at them even when the market source is down.
 * Run after the indexer by the scheduled job. Reads DexScreener and the chain; writes only to the Launch Box table.
 */
import { EVM_CURVE, type LaunchChain } from './core.js';
import { fetchPools, readCurves } from './markets.js';
import type { LaunchStore } from './store.js';
import { PUBLIC_EVM_RPC, type IndexerEnv } from './indexer.js';

export async function refreshLinks(d: { store: LaunchStore; fetchImpl: typeof fetch; env: IndexerEnv; now: () => number }): Promise<{ pools: number; curves: number; error?: string }> {
  const out = { pools: 0, curves: 0 } as { pools: number; curves: number; error?: string };
  const tokens = await d.store.list(200);
  const byChain = new Map<LaunchChain, typeof tokens>();
  for (const t of tokens) byChain.set(t.chain, [...(byChain.get(t.chain) ?? []), t]);
  for (const [chain, list] of byChain) {
    try {
      const pools = await fetchPools(d.fetchImpl, chain, list.map((t) => t.address));
      for (const t of list) {
        const m = pools.get(chain === 'solana' ? t.address : t.address.toLowerCase());
        if (m && m.pool.url && (t.poolAddress !== m.pool.address || t.poolDex !== m.pool.dex)) {
          await d.store.patch(chain, t.address, { poolDex: m.pool.dex, poolAddress: m.pool.address, poolUrl: m.pool.url, poolSeenAt: d.now() });
          out.pools++;
        }
      }
      if (chain !== 'solana') {
        const own = d.env[chain === 'bnb' ? 'EVM_RPC_BNB' : chain === 'ethereum' ? 'EVM_RPC_ETHEREUM' : 'EVM_RPC_POLYGON']?.trim();
        const curves = await readCurves(d.fetchImpl, own || PUBLIC_EVM_RPC[chain], list.map((t) => t.address));
        for (const t of list) {
          const c = curves.get(t.address.toLowerCase());
          if (c && c !== 'none' && c !== 'unknown' && !t.curveAddress) {
            await d.store.patch(chain, t.address, { curveAddress: EVM_CURVE });
            out.curves++;
          }
        }
      }
    } catch (e) {
      out.error = String(e instanceof Error ? e.message : e).slice(0, 160);
    }
  }
  return out;
}
