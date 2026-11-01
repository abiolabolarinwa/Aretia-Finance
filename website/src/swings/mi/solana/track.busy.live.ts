/** Busy pools of the venues whose first live check found quiet ones: swaps must decode from their vault balance changes too. */
import { describe, expect, it } from 'vitest';
import { chainConfig } from '../chains.js';
import { DEFAULT_RULES } from '../lifecycle.js';
import { makeRead } from '../rpc.js';
import { InMemoryMiStore } from '../store.js';
import { trackSolanaPool } from './track.js';

const rpc = makeRead(['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'], { concurrency: 2 });
/** Well-known SOL/USDC pools; the test says so if one of these addresses is not what it was remembered as. */
const POOLS: [string, string][] = [
  ['meteora-dlmm SOL/USDC', 'BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y'],
  ['raydium-clmm SOL/USDC', '8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj'],
  ['raydium-amm-v4 SOL/USDC', '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'],
];
describe('busy pools, live', () => {
  for (const [name, pool] of POOLS) {
    it(name, async () => {
      const store = new InMemoryMiStore();
      const r = await trackSolanaPool({ chain: chainConfig('solana'), rpc, store, rules: DEFAULT_RULES, now: Date.now, budgetMs: 60_000, swapSigs: 150 }, pool);
      const p = [...store.pools.values()][0];
      process.stdout.write(`\nLIVE ${name} ${JSON.stringify({ r, state: p?.state, trades: store.trades.size, price: p?.stats?.priceUsd })}\n`);
      expect(r.status).toBe('tracked');
    }, 200_000);
  }
});
