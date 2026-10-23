/**
 * Records a real two-run Solana scenario (every RPC answer the engine receives) so engine.test.ts can replay it offline.
 * Prints the recording to stdout between RECORD_BEGIN and RECORD_END; it writes no file. Transactions are cut down to the fields the
 * decoders read. Usage:  MI_RECORD=raydium-cpmm-solana npx vitest run --config vitest.live.config.ts src/swings/mi/solana/record.live.ts
 */
import { describe, it } from 'vitest';
import { chainConfig } from '../chains.js';
import { solanaSpecById } from '../dexes.js';
import { DEFAULT_RULES } from '../lifecycle.js';
import { makeRead, type Read } from '../rpc.js';
import { InMemoryMiStore } from '../store.js';
import { runSolanaAdapter } from './engine.js';

const id = process.env.MI_RECORD;

describe.skipIf(!id)('record a Solana scenario', () => {
  it('records', async () => {
    const spec = solanaSpecById(id!)!;
    const chain = chainConfig('solana');
    const real = makeRead(chain.rpcUrls, { concurrency: 3 });
    const calls: [string, unknown][] = [];
    const rpc: Read = async (method, params) => {
      let result = await real(method, params);
      if (method === 'getTransaction' && result) {
        const t = result as { slot: number; blockTime: number; meta: Record<string, unknown>; transaction: { message: Record<string, unknown> } };
        result = { slot: t.slot, blockTime: t.blockTime, meta: { err: t.meta.err, preTokenBalances: t.meta.preTokenBalances, postTokenBalances: t.meta.postTokenBalances, innerInstructions: t.meta.innerInstructions, loadedAddresses: t.meta.loadedAddresses }, transaction: { message: { accountKeys: t.transaction.message.accountKeys, instructions: t.transaction.message.instructions } } };
      }
      calls.push([JSON.stringify([method, params]), result]);
      return result;
    };
    const store = new InMemoryMiStore();
    const deps = { spec, chain, rpc, store, rules: DEFAULT_RULES, now: Date.now, budgetMs: 120_000, maxCreationTx: 3, followNewest: 3, followRecent: 0, swapSigs: 8, sigPages: 1 };
    const first = await runSolanaAdapter({ ...deps, chain: { ...chain, lookback: 1800 } });
    const second = await runSolanaAdapter({ ...deps, chain: { ...chain, lookback: 1800 } });
    const rec = { id, now: Date.now(), first: { ok: first.ok, pools: store.pools.size }, second: { ok: second.ok }, calls };
    process.stdout.write(`\nRECORD_BEGIN${JSON.stringify(rec)}RECORD_END\n`);
  }, 300_000);
});
