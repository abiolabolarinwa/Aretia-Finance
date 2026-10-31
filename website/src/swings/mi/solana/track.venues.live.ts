/**
 * Live proof of the pool layouts of Raydium AMM v4, Raydium CLMM, Meteora DLMM, DAMM v2 and the Dynamic Bonding Curve: for each program,
 * a real pool is found from its own recent transactions (an account it owns, of the layout's size), added on request, and the parsed
 * token accounts are checked on chain: each vault must be a token account of exactly the mint the parser named.
 */
import { describe, expect, it } from 'vitest';
import { chainConfig } from '../chains.js';
import { DEFAULT_RULES } from '../lifecycle.js';
import { makeRead } from '../rpc.js';
import { InMemoryMiStore } from '../store.js';
import { encodeBase58, fromBase64 } from './accounts.js';
import { trackSolanaPool } from './track.js';

const VENUES: [string, string, number][] = [
  ['raydium-amm-v4', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 752],
  ['raydium-clmm', 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', 1544],
  ['meteora-dlmm', 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', 904],
  ['meteora-damm-v2', 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', 1112],
  ['meteora-dbc', 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', 424],
];
const rpc = makeRead(['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'], { concurrency: 2 });

async function findPool(program: string, size: number): Promise<string | null> {
  const sigs = (await rpc('getSignaturesForAddress', [program, { limit: 12, commitment: 'finalized' }])) as { signature: string; err: unknown }[];
  for (const s of sigs) {
    if (s.err) continue;
    const tx = (await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' }])) as { transaction: { message: { accountKeys: ({ pubkey: string } | string)[] } } } | null;
    const keys = (tx?.transaction.message.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k.pubkey));
    const got = (await rpc('getMultipleAccounts', [keys.slice(0, 100), { encoding: 'base64', commitment: 'finalized' }])) as { value: ({ owner: string; data: [string, string] } | null)[] };
    for (let i = 0; i < got.value.length; i++) {
      const a = got.value[i];
      if (a && a.owner === program && fromBase64(a.data[0]).length === size) return keys[i]!;
    }
  }
  return null;
}

describe('pool layouts of the other Solana venues, live', () => {
  for (const [name, program, size] of VENUES) {
    it(name, async () => {
      const pool = await findPool(program, size);
      expect(pool, `a recent pool of ${name}`).not.toBeNull();
      const chain = chainConfig('solana');
      const store = new InMemoryMiStore();
      const r = await trackSolanaPool({ chain, rpc, store, rules: DEFAULT_RULES, now: Date.now, budgetMs: 60_000, swapSigs: 20 }, pool!);
      const p = [...store.pools.values()][0];
      process.stdout.write(`\nLIVE ${name} ${JSON.stringify({ pool, r, state: p?.state, trades: store.trades.size })}\n`);
      expect(r.status).toBe('tracked');
      // Each vault is a token account of the very mint the parser named.
      const vaults = (await rpc('getMultipleAccounts', [[p!.baseVault, p!.quoteVault], { encoding: 'base64', commitment: 'finalized' }])) as { value: ({ data: [string, string] } | null)[] };
      expect(encodeBase58(fromBase64(vaults.value[0]!.data[0]).subarray(0, 32))).toBe(p!.base);
      expect(encodeBase58(fromBase64(vaults.value[1]!.data[0]).subarray(0, 32))).toBe(p!.quote);
    }, 240_000);
  }
});
