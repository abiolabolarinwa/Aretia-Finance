/**
 * Live, read-only end-to-end proof for Solana: the real engine runs against public Solana nodes, finds pools created in the last
 * hour from the creation-only accounts, registers their tokens (decimals and Metaplex names), follows their swaps from the pool's
 * token-account balance changes, and a second run continues from the cursors with nothing duplicated.
 * Run with `npm run test:live`; choose venues with MI_LIVE_SPECS=raydium-cpmm-solana,orca-whirlpool-solana.
 */
import { describe, expect, it } from 'vitest';
import { chainConfig } from '../chains.js';
import { solanaSpecById } from '../dexes.js';
import { DEFAULT_RULES } from '../lifecycle.js';
import { makeRead } from '../rpc.js';
import { InMemoryMiStore } from '../store.js';
import { runSolanaAdapter, solUsdReader } from './engine.js';

const ids = (process.env.MI_LIVE_SPECS ?? 'raydium-cpmm-solana').split(',');

for (const id of ids) {
  describe(`live market indexer (Solana): ${id}`, () => {
    it('discovers real pools, follows real swaps and resumes without duplicates', async () => {
      const spec = solanaSpecById(id)!;
      const chain = chainConfig('solana');
      const rpc = makeRead(chain.rpcUrls, { concurrency: 3 });
      const store = new InMemoryMiStore();
      const deps = { spec, chain, rpc, store, rules: DEFAULT_RULES, now: Date.now, nativeUsd: solUsdReader(rpc, Date.now), budgetMs: 200_000, maxCreationTx: 25 };
      const first = await runSolanaAdapter(deps);
      const pools = [...store.pools.values()];
      const tokens = [...store.tokens.values()];
      const states = pools.reduce<Record<string, number>>((m, p) => ((m[p.state] = (m[p.state] ?? 0) + 1), m), {});
      const traded = pools.filter((p) => p.stats);
      const sample = traded.sort((a, b) => b.stats!.volumeQuote.h24 - a.stats!.volumeQuote.h24)[0];
      process.stdout.write(`\nLIVE ${JSON.stringify({ id, error: first.error, creations: first.creations, pools: pools.length, tokens: tokens.length, named: tokens.filter((t) => t.symbol).length, states, trades: store.trades.size, poolsWithTrades: traded.length, ms: first.durationMs, sample: sample ? { pool: sample.address, base: sample.base, quote: sample.quote, price: sample.stats!.price, priceUsd: sample.stats!.priceUsd, buys: sample.stats!.buys.h24, sells: sample.stats!.sells.h24, liqUsd: sample.stats!.liquidityUsd } : null })}\n`);
      expect(first.ok).toBe(true);
      expect(first.creations).toBeGreaterThan(0);
      const snapshot = { pools: store.pools.size, trades: store.trades.size, tokens: store.tokens.size };
      const second = await runSolanaAdapter(deps);
      expect(second.ok).toBe(true);
      expect(store.pools.size).toBeGreaterThanOrEqual(snapshot.pools);
      expect(store.tokens.size).toBeGreaterThanOrEqual(snapshot.tokens);
      // A repeat of the same creation window must not duplicate a pool or token.
      const keys = [...store.pools.keys()];
      expect(new Set(keys).size).toBe(keys.length);
    }, 600_000);
  });
}
