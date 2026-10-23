/**
 * Replays two REAL Solana scenarios (recorded from mainnet by record.live.ts: every RPC answer the engine received) through the real
 * engine, offline. A call the recording does not contain throws, so the engine cannot quietly behave differently from what was seen.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chainConfig } from '../chains.js';
import { solanaSpecById } from '../dexes.js';
import { DEFAULT_RULES } from '../lifecycle.js';
import { parseRaw, priceString } from '../math.js';
import { RpcError, type Read } from '../rpc.js';
import { InMemoryMiStore } from '../store.js';
import { runSolanaAdapter } from './engine.js';

interface Recording {
  id: string;
  now: number;
  first: { ok: boolean; pools: number };
  calls: [string, unknown][];
}
const recordings = JSON.parse(readFileSync(join(process.cwd(), 'src/swings/mi/fixtures/solana-recordings.json'), 'utf8')) as Record<string, Recording>;

function replay(rec: Recording): { read: Read; missing: string[] } {
  const answers = new Map(rec.calls);
  const missing: string[] = [];
  return {
    missing,
    read: async (method, params) => {
      const key = JSON.stringify([method, params]);
      if (!answers.has(key)) {
        missing.push(key.slice(0, 160));
        throw new RpcError('not in the recording', 'node-error');
      }
      return answers.get(key);
    },
  };
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

for (const id of ['raydium-cpmm-solana', 'orca-whirlpool-solana', 'pumpswap-solana']) {
  describe(`Solana engine replay: ${id}`, () => {
    const rec = recordings[id]!;
    const spec = solanaSpecById(id)!;
    const setup = () => {
      const store = new InMemoryMiStore();
      const { read, missing } = replay(rec);
      const deps = { spec, chain: { ...chainConfig('solana'), lookback: 1800 }, rpc: read, store, rules: DEFAULT_RULES, now: () => rec.now, budgetMs: 1_000_000, maxCreationTx: 3, followNewest: 3, followRecent: 0, swapSigs: 8, sigPages: 1 };
      return { store, deps, missing };
    };

    it('finds the pools, registers real tokens with decimals, follows their swaps, and stays consistent', async () => {
      const { store, deps, missing } = setup();
      const r = await runSolanaAdapter(deps);
      expect(r.ok).toBe(true);
      expect(r.creations).toBeGreaterThanOrEqual(store.pools.size);
      // The second recorded run is part of the scenario: the swaps a young pool has by then are read on it.
      expect((await runSolanaAdapter(deps)).ok).toBe(true);
      expect(missing).toEqual([]);
      // The recording counted the pools after both runs.
      expect(store.pools.size).toBe(rec.first.pools);
      for (const p of store.pools.values()) {
        expect(p.chain).toBe('solana');
        expect(p.baseVault).toMatch(BASE58);
        expect(p.quoteVault).toMatch(BASE58);
        expect(p.kind).toBe(spec.kind);
        expect(p.createdAt).toBeGreaterThan(1_700_000_000_000);
        const base = store.tokens.get(`solana:${p.base}`)!;
        expect(base.decimals).toBeGreaterThanOrEqual(0);
        expect(base.decimals).toBeLessThanOrEqual(12);
      }
      // Every trade: a unique signature, and a price equal to quote/base recomputed from the stored raw amounts.
      expect(store.trades.size).toBeGreaterThan(0);
      const seen = new Set<string>();
      for (const t of store.trades.values()) {
        expect(seen.has(`${t.pool}|${t.id}`)).toBe(false);
        seen.add(`${t.pool}|${t.id}`);
        const p = store.pools.get(`solana:${t.pool}`)!;
        expect(t.price).toBe(priceString(parseRaw(t.baseAmount)!, p.baseDecimals, parseRaw(t.quoteAmount)!, p.quoteDecimals));
        expect(['buy', 'sell']).toContain(t.side);
        expect(t.maker).toMatch(BASE58);
      }
      const traded = [...store.pools.values()].filter((p) => p.stats);
      expect(traded.length).toBeGreaterThan(0);
      for (const p of traded) expect(p.stats!.buys.h24 + p.stats!.sells.h24).toBe([...store.trades.values()].filter((t) => t.pool === p.address).length);
    });

    it('a second run continues from the cursors and duplicates nothing', async () => {
      const { store, deps, missing } = setup();
      await runSolanaAdapter(deps);
      const before = { pools: store.pools.size, tokens: store.tokens.size, trades: store.trades.size };
      const again = await runSolanaAdapter(deps);
      expect(missing).toEqual([]);
      expect(again.ok).toBe(true);
      // A pool created between the two runs is new; nothing already stored is stored twice.
      expect(store.pools.size).toBeGreaterThanOrEqual(before.pools);
      expect(store.pools.size).toBe(rec.first.pools);
      expect(store.tokens.size).toBeGreaterThanOrEqual(before.tokens);
      expect(store.trades.size).toBeGreaterThanOrEqual(before.trades);
      expect((await store.listHealth())[0]!.consecutiveFailures).toBe(0);
    });

    it('does nothing for a disabled adapter', async () => {
      const { store, deps } = setup();
      await store.setAdapterDisabled(id, true, 'test', 1);
      expect((await runSolanaAdapter(deps)).skipped).toBe('disabled');
      expect(store.pools.size).toBe(0);
    });

    it('records a failed run without moving any cursor', async () => {
      const { store, deps } = setup();
      const r = await runSolanaAdapter({
        ...deps,
        rpc: async () => {
          throw new RpcError('down', 'transport');
        },
      });
      expect(r.ok).toBe(false);
      expect(await store.getCheckpoint(id)).toBeNull();
      expect((await store.listHealth())[0]!.consecutiveFailures).toBe(1);
    });
  });
}
