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

import * as web3 from '@solana/web3.js';
import { SolanaPoolDiscoverySource } from './solanaIndexer.js';
import type { SolRpc } from '../solana/raydiumCpmm.js';

const solRpc: SolRpc = async <T>(method: string, params: unknown[]): Promise<T> => {
  for (let attempt = 0; attempt < 7; attempt++) {
    const res = await fetch('https://api.mainnet-beta.solana.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error || body.result === undefined) throw new Error(`rpc ${method}: ${body.error?.message ?? 'no result'}`);
    return body.result;
  }
  throw new Error(`rpc ${method}: rate limited`);
};

describe('live indexer: Solana pool creations (Raydium CPMM and Orca Whirlpools)', () => {
  it('finds real pool-creation transactions, decodes them, and reports tokens with on-chain decimals and real block times', async () => {
    const src = new SolanaPoolDiscoverySource(async () => web3, solRpc, { lookbackSeconds: 6 * 3_600, perAccount: 30, maxTransactions: 24 });
    const first = await src.poll(null);
    console.log('solana indexer run', src.lastRun, 'candidates', first.candidates.length, first.candidates.slice(0, 3).map((c) => [c.ref.address.slice(0, 8), c.decimals, c.pool?.venue, c.liquidityUsd, new Date(c.firstPoolAt!).toISOString()]));
    expect(src.lastRun!.accountsRead).toBe(10);
    expect(src.lastRun!.poolsFound).toBeGreaterThan(0);
    expect(first.candidates.length).toBeGreaterThan(0);
    for (const c of first.candidates) {
      expect(c.ref.chain).toBe('solana');
      expect(c.firstPoolAt!).toBeGreaterThan(Date.now() - 7 * 3_600_000);
      expect(c.firstPoolAt!).toBeLessThanOrEqual(Date.now());
      expect(c.decimals == null || (c.decimals >= 0 && c.decimals <= 12)).toBe(true);
    }
    // A second poll from the cursor reads only what is newer than the first.
    const second = await src.poll(first.nextCursor);
    console.log('second poll', src.lastRun);
    expect(src.lastRun!.signaturesNew).toBeLessThanOrEqual(src.lastRun!.accountsRead * 30);
    expect(second.nextCursor).not.toBeNull();
  }, 240_000);
});
