/**
 * Adding one existing Solana pool to the index on request (see ../track.ts for the idea). The pool's owner program must be one
 * of the three Aretia indexes, and its account is parsed with that program's layout; anything else is refused. Its token accounts
 * give its swaps, read from their signatures, newest first.
 */
import type { CreatedPool } from '../../indexer/solanaIndexer.js';
import { RAYDIUM_CPMM_PROGRAM } from '../../solana/raydiumCpmm.js';
import { ORCA_WHIRLPOOL_PROGRAM } from '../../solana/orcaWhirlpool.js';
import type { RunReport } from '../engine.js';
import { SOLANA_SPECS } from '../dexes.js';
import { poolKeyOf } from '../types.js';
import type { TrackResult } from '../track.js';
import { fromBase64, isSolanaAddress, parseCpmmPool, parsePumpPool, parseWhirlpool, type PoolAccounts } from './accounts.js';
import { followPool, refreshPool, registerPool, tradesFromSignatures, type SigInfo, type SolDeps, type TokenFacts } from './engine.js';
import { PUMPSWAP_PROGRAM } from './pumpswap.js';

const REPORT = (id: string): RunReport => ({ adapterId: id, ok: true, skipped: null, head: null, safeHead: null, fromBlock: null, toBlock: null, lagBlocks: null, creations: 0, poolsNew: 0, tokensNew: 0, swapsSeen: 0, tradesNew: 0, skippedLogs: 0, reorg: null, error: null, durationMs: 0 });

const PROGRAMS: Readonly<Record<string, { id: string; venue: CreatedPool['venue']; parse: (d: Uint8Array) => PoolAccounts | null }>> = {
  [RAYDIUM_CPMM_PROGRAM]: { id: 'raydium-cpmm-solana', venue: 'Raydium CPMM', parse: parseCpmmPool },
  [ORCA_WHIRLPOOL_PROGRAM]: { id: 'orca-whirlpool-solana', venue: 'Orca Whirlpool', parse: parseWhirlpool },
  [PUMPSWAP_PROGRAM]: { id: 'pumpswap-solana', venue: 'PumpSwap' as unknown as CreatedPool['venue'], parse: parsePumpPool },
};

export type SolTrackDeps = Omit<SolDeps, 'spec'>;

export async function trackSolanaPool(d: SolTrackDeps, address: string): Promise<TrackResult> {
  if (!isSolanaAddress(address)) return { status: 'unsupported', reason: 'not a Solana address' };
  const key = poolKeyOf('solana', address);
  if ((await d.store.getPools([key])).has(key)) return { status: 'tracked', key, trades: 0, alreadyKnown: true, coveredHours: 0, complete: true };
  const info = (await d.rpc('getAccountInfo', [address, { encoding: 'base64', commitment: 'finalized' }])) as { value: { owner: string; data: [string, string] } | null };
  if (!info?.value) return { status: 'unreadable', reason: 'no such account' };
  const program = PROGRAMS[info.value.owner];
  if (!program) return { status: 'unsupported', reason: 'not a pool of a DEX Aretia indexes on Solana' };
  const parsed = program.parse(fromBase64(info.value.data[0]));
  if (!parsed || !isSolanaAddress(parsed.mintA) || !isSolanaAddress(parsed.vaultA)) return { status: 'unreadable', reason: 'the pool account has an unexpected layout' };
  const spec = SOLANA_SPECS.find((s) => s.id === program.id)!;
  const deps: SolDeps = { ...d, spec, swapSigs: d.swapSigs ?? 120 };
  const cache = new Map<string, TokenFacts | null>();
  const created: CreatedPool = { venue: program.venue, pool: address, ...parsed, blockTime: 0, signature: 'tracked' };
  await registerPool(deps, created, 0, cache, REPORT(spec.id));
  const pool = (await d.store.getPools([key])).get(key);
  if (!pool) return { status: 'unreadable', reason: 'the pool could not be registered' };
  if (pool.state === 'unsupported') return { status: 'unsupported', reason: pool.stateReason };
  const got = await followPool(deps, pool, REPORT(spec.id));
  // A first read that came back short has the pool's whole history; otherwise later runs read further back from the oldest signature seen.
  const complete = got.exhausted === true;
  await d.store.updatePool(key, { historyDone: complete });
  if (!complete && got.oldest) await d.store.setCheckpoint({ adapterId: historyKey(spec.id, address), block: 0, blockHash: got.oldest, updatedAt: d.now() });
  await refreshPool(deps, pool, cache);
  return { status: 'tracked', key, trades: got.stored, alreadyKnown: false, coveredHours: 0, complete };
}

const historyKey = (specId: string, pool: string): string => `${specId}|${pool}|history`;

/**
 * Reads a few tracked Solana pools further back, a bounded amount per run: the signatures before the oldest one already read, 100 at a
 * time, until the list runs out (the pool's first transaction) or the oldest transaction is older than the retention limit.
 */
export async function deepenSolanaHistory(d: SolDeps & { retentionDays?: number }, opts: { pools?: number; budgetMs?: number } = {}): Promise<{ pools: number; trades: number; completed: number }> {
  const pools = await d.store.poolsNeedingHistory(d.spec.id, opts.pools ?? 3);
  const oldestAllowed = Math.floor(d.now() / 1000) - (d.retentionDays ?? 30) * 86_400;
  const deadline = d.now() + (opts.budgetMs ?? 15_000);
  let trades = 0;
  let completed = 0;
  for (const pool of pools) {
    if (d.now() >= deadline) break;
    const cp = await d.store.getCheckpoint(historyKey(d.spec.id, pool.address));
    if (!cp || !pool.quoteVault) {
      await d.store.updatePool(pool.key, { historyDone: true });
      completed++;
      continue;
    }
    const sigs = (await d.rpc('getSignaturesForAddress', [pool.quoteVault, { limit: 100, before: cp.blockHash, commitment: 'finalized' }])) as SigInfo[];
    const got = await tradesFromSignatures(d, pool, sigs, REPORT(d.spec.id));
    const kept = got.trades.filter((t) => t.time >= oldestAllowed);
    await d.store.putTrades(d.spec.id, kept);
    trades += kept.length;
    const last = sigs[sigs.length - 1];
    const done = sigs.length < 100 || (last?.blockTime ?? Number.MAX_SAFE_INTEGER) < oldestAllowed;
    // Only a fully read page moves the cursor back.
    if (got.unavailable === 0 && last) await d.store.setCheckpoint({ adapterId: historyKey(d.spec.id, pool.address), block: 0, blockHash: last.signature, updatedAt: d.now() });
    if (done && got.unavailable === 0) {
      await d.store.updatePool(pool.key, { historyDone: true });
      completed++;
    }
  }
  return { pools: pools.length, trades, completed };
}
