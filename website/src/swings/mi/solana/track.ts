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
import { followPool, refreshPool, registerPool, type SolDeps, type TokenFacts } from './engine.js';
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
  if ((await d.store.getPools([key])).has(key)) return { status: 'tracked', key, trades: 0, alreadyKnown: true, coveredHours: 0 };
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
  await refreshPool(deps, pool, cache);
  return { status: 'tracked', key, trades: got.stored, alreadyKnown: false, coveredHours: 0 };
}
