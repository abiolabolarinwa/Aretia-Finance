/**
 * Reads one pool's liquidity lock in the page, for a screen that shows a single pool (the token page and the docked panel): the same check the
 * Markets list runs for its rows (swings/market/lock.ts), kept for half an hour so opening the same token again does not read the chain again.
 * A chain that does not answer is not remembered as "no lock".
 */
import { CHAINS, type ChainId } from '../swings/core/types.js';
import { checkLock, LOCK_MIN_PCT } from '../swings/market/lock.js';
import { publicRead } from '../swings/chains/evmSession.js';
import { rpcCall } from './walletSend';
import type { LockFound } from './walletLocks.js';

const TTL_MS = 30 * 60_000;
const cache = new Map<string, { at: number; found: LockFound | null }>();
const inFlight = new Map<string, Promise<LockFound | null>>();
const keyOf = (chain: ChainId, pool: string): string => `${chain}:${chain === 'solana' ? pool : pool.toLowerCase()}`;

/** What the check found for a pool: a lock (or the share burned, even under the bar), or null for a pool of a kind it cannot read. Rejects when the chain did not answer. */
export function readPoolLock(chain: ChainId, pool: string, now: () => number = Date.now): Promise<LockFound | null> {
  const k = keyOf(chain, pool);
  const hit = cache.get(k);
  if (hit && now() - hit.at < TTL_MS) return Promise.resolve(hit.found);
  const pending = inFlight.get(k);
  if (pending) return pending;
  const p = (async (): Promise<LockFound | null> => {
    const lock = await checkLock(chain, pool, { ...(CHAINS[chain].kind === 'evm' ? { evm: publicRead(chain) } : { sol: rpcCall }) }, now());
    const found: LockFound | null = !lock ? null : lock.pct < LOCK_MIN_PCT ? { pct: lock.pct, kind: 'burned', until: null } : lock.kind === 'time-locked' ? { pct: lock.pct, kind: 'time-locked', until: lock.until, by: lock.by } : { pct: lock.pct, kind: 'burned', until: null };
    cache.set(k, { at: now(), found });
    return found;
  })().finally(() => inFlight.delete(k));
  inFlight.set(k, p);
  return p;
}
