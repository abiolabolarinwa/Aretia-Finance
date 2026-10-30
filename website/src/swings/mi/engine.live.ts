/**
 * Live, read-only end-to-end proof of the first network (BNB Chain, PancakeSwap V2): the real engine runs against a public node,
 * discovers pools created in a recent window, registers their tokens, follows their swaps, and then a second run continues from
 * the checkpoint with nothing duplicated. Run with `npm run test:live`; further adapters with MI_LIVE_SPECS=id1,id2.
 */
import { describe, expect, it } from 'vitest';
import { chainConfig } from './chains.js';
import { specById } from './dexes.js';
import { runAdapter } from './engine.js';
import { DEFAULT_RULES } from './lifecycle.js';
import { nativeUsdReader } from './reference.js';
import { makeRead } from './rpc.js';
import { InMemoryMiStore } from './store.js';

const ids = (process.env.MI_LIVE_SPECS ?? 'pancakeswap-v2-bnb').split(',');
const LOOKBACK: Record<string, number> = { bnb: 2_400, ethereum: 600, polygon: 2_000, base: 3_000,};

for (const id of ids) {
  describe(`live market indexer: ${id}`, () => {
    it('discovers real pools, follows real swaps, and resumes without duplicates', async () => {
      const spec = specById(id)!;
      const cfg = { ...chainConfig(spec.chain), lookback: LOOKBACK[spec.chain]!, maxRange: 500 };
      const read = makeRead(cfg.rpcUrls);
      const store = new InMemoryMiStore();
      const deps = { spec, chain: cfg, read, store, rules: DEFAULT_RULES, now: Date.now, nativeUsd: nativeUsdReader(cfg, read, Date.now), budgetMs: 150_000 };
      const first = await runAdapter(deps);
      const pools = [...store.pools.values()];
      const tokens = [...store.tokens.values()];
      const states = pools.reduce<Record<string, number>>((m, p) => ((m[p.state] = (m[p.state] ?? 0) + 1), m), {});
      const withTrades = pools.filter((p) => p.stats);
      const sample = withTrades.sort((a, b) => (b.stats!.volumeQuote.h24) - (a.stats!.volumeQuote.h24))[0];
      const summary = { id, error: first.error, creations: first.creations, pools: pools.length, tokens: tokens.length, states, trades: store.trades.size, poolsWithTrades: withTrades.length, lag: first.lagBlocks, ms: first.durationMs, sample: sample ? { pool: sample.address, base: sample.base, quote: sample.quote, price: sample.stats!.price, priceUsd: sample.stats!.priceUsd, vol24: sample.stats!.volumeQuote.h24, buys: sample.stats!.buys.h24, sells: sample.stats!.sells.h24, liqUsd: sample.stats!.liquidityUsd } : null };
      // Visible in the test report even if the assertion below passes.
      process.stdout.write(`\nLIVE ${JSON.stringify(summary)}\n`);
      expect(first.ok).toBe(true);
      expect(first.creations).toBeGreaterThan(0);
      for (const p of pools) {
        expect(p.address).toMatch(/^0x[0-9a-f]{40}$/);
        expect(p.baseDecimals).toBeGreaterThanOrEqual(0);
      }
      const tradesAfterFirst = store.trades.size;
      const poolsAfterFirst = store.pools.size;
      // Second pass: the checkpoint continues from where the first stopped, and re-reading creates nothing twice.
      const cp = (await store.getCheckpoint(spec.id))!;
      const again = await runAdapter(deps);
      expect(again.ok).toBe(true);
      expect(again.fromBlock).toBeGreaterThan(cp.block);
      expect(store.pools.size).toBeGreaterThanOrEqual(poolsAfterFirst);
      expect(store.trades.size).toBeGreaterThanOrEqual(tradesAfterFirst);
      // Backfill of the first window again must change nothing.
      const before = { pools: store.pools.size, trades: store.trades.size };
      const reread = await runAdapter(deps, { range: { from: cp.block - 300, to: cp.block } });
      expect(reread.ok).toBe(true);
      expect(store.pools.size).toBe(before.pools);
      expect(store.trades.size).toBe(before.trades);
    }, 420_000);
  });
}
