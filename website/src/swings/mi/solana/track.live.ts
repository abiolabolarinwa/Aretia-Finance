/** Live proof that an existing Solana pool can be added on request: its owner program is matched, its account parsed, its swaps read. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chainConfig } from '../chains.js';
import { DEFAULT_RULES } from '../lifecycle.js';
import { makeRead } from '../rpc.js';
import { InMemoryMiStore } from '../store.js';
import { solUsdReader } from './engine.js';
import { trackSolanaPool } from './track.js';

const ORCA_SOL_USDC = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
/** A pool of each of the other two venues, taken from the recorded real runs. */
function recordedPool(id: string): string {
  const rec = JSON.parse(readFileSync(join(process.cwd(), 'src/swings/mi/fixtures/solana-recordings.json'), 'utf8')) as Record<string, { calls: [string, unknown][] }>;
  for (const [k, v] of rec[id]!.calls) {
    if (!k.startsWith('["getTransaction"')) continue;
    const tx = v as { transaction: { message: { instructions: { programId?: string; accounts?: string[] }[] } }; meta: { innerInstructions?: { instructions: { programId?: string; accounts?: string[] }[] }[] } };
    for (const ix of [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((i) => i.instructions)]) {
      if (ix.programId === (id.startsWith('raydium') ? 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C' : 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA') && ix.accounts && ix.accounts.length > 10) return ix.accounts[id.startsWith('raydium') ? 3 : 0]!;
    }
  }
  throw new Error('no pool in the recording');
}

describe('track an existing Solana pool, live', () => {
  for (const [name, pool] of [['orca', ORCA_SOL_USDC], ['raydium-cpmm', recordedPool('raydium-cpmm-solana')], ['pumpswap', recordedPool('pumpswap-solana')]] as const) {
    it(name, async () => {
      const chain = chainConfig('solana');
      const rpc = makeRead(chain.rpcUrls, { concurrency: 3 });
      const store = new InMemoryMiStore();
      const r = await trackSolanaPool({ chain, rpc, store, rules: DEFAULT_RULES, now: Date.now, nativeUsd: solUsdReader(rpc, Date.now), budgetMs: 60_000, swapSigs: 40 }, pool);
      const p = [...store.pools.values()][0];
      process.stdout.write(`\nLIVE ${name} ${JSON.stringify({ r, state: p?.state, trades: store.trades.size, price: p?.stats?.price, usd: p?.stats?.priceUsd })}\n`);
      expect(r.status).toBe('tracked');
      // The two recorded pools are a week old and may have gone quiet; only the busy Orca pool must show trades.
      if (name === 'orca') expect(store.trades.size).toBeGreaterThan(0);
      expect(store.pools.size).toBe(1);
    }, 180_000);
  }
});
