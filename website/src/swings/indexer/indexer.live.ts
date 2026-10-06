/**
 * Read-only live proof of Aretia's own discovery feed: the factory events of each real V2 venue are read from a
 * public node, decoded, and turned into token candidates with on-chain metadata and a real block timestamp.
 */
import { describe, expect, it } from 'vitest';
import { publicRead } from '../chains/evmSession.js';
import { EVM_V2_DEXES } from '../dex/entries.js';
import { EvmFactoryDiscoverySource } from './evmIndexer.js';

const LOOKBACK: Record<string, number> = { ethereum: 1_500, bnb: 4_000, polygon: 3_000, base: 6_000 };

for (const entry of EVM_V2_DEXES) {
  describe(`live indexer: ${entry.id}`, () => {
    it('decodes real PairCreated events from confirmed blocks', async () => {
      await new Promise((r) => setTimeout(r, 800));
      const src = new EvmFactoryDiscoverySource(entry, publicRead(entry.chain), { lookback: LOOKBACK[entry.chain]!, maxRange: 1_000 });
      let candidates: Awaited<ReturnType<typeof src.poll>>['candidates'] = [];
      let cursor: string | null = null;
      let pairs = 0;
      // Read the whole lookback window in pages, as the scheduled worker would across several runs.
      for (let i = 0; i < 8; i++) {
        const batch = await src.poll(cursor);
        pairs += src.lastRun!.pairsSeen;
        candidates = candidates.concat(batch.candidates);
        if (batch.nextCursor === null) break;
        cursor = batch.nextCursor;
      }
      console.log(entry.id, 'pairs created in window:', pairs, 'new tokens reported:', candidates.length, 'lag blocks:', src.lastRun!.lagBlocks, candidates[0] ? `first: ${candidates[0].symbol} ${candidates[0].ref.address.slice(0, 10)}… pool block time ${new Date(candidates[0].firstPoolAt!).toISOString()} liquidityUsd ${candidates[0].liquidityUsd}` : '');
      expect(src.lastRun!.lagBlocks).toBeLessThan(2_000n);
      for (const c of candidates) {
        expect(c.ref.chain).toBe(entry.chain);
        expect(c.firstPoolAt!).toBeGreaterThan(Date.now() - 7 * 86_400_000);
        expect(c.firstPoolAt!).toBeLessThanOrEqual(Date.now());
      }
    });
  });
}
