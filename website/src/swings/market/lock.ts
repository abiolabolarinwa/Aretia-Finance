/**
 * Is a pool's liquidity locked? Aretia answers only what it can prove from the chain itself:
 *
 *  - EVM pairs that mint a liquidity token (Uniswap V2 and its many forks, on every EVM network): the share of that token
 *    sitting at the dead or zero address. Those tokens can never be redeemed, so the money behind them can never be taken out.
 *  - Raydium AMM v4 on Solana: the share of the liquidity token that was burned, from the pool's own record of what it ever
 *    minted against what exists now.
 *
 *  - Uniswap V3 pools on a chain with a known position locker (Robinhood Chain: UNCX's Liquidity Locker V3.1): the share of the
 *    pool's active liquidity that sits in position NFTs the locker holds, with the date they can come out. This is a TIME lock,
 *    not a burn: it ends, and it is reported as its own kind with its date.
 *
 *  - Uniswap V4 pools on a chain with a known V4 locker (Robinhood Chain: UNCX's V4 locker): the same idea for V4 positions, with the
 *    pool found by its 32-byte pool id. Also a time lock.
 *
 * Not covered, and so never marked: position NFTs sent to a dead address, other lockers, other concentrated-liquidity pools
 * (CLMM), and other Solana pool kinds. No mark means "not shown to be locked", not "unlocked".
 */
import type { ChainId, TokenLock } from '../core/types.js';
import { decodeParams, encodeFunction } from '../engine/abiGeneric.js';
import { encodeCall, address, selector, uint, words } from '../engine/abi.js';
import { keccak256 } from '../core/keccak.js';
import { AMM_V4_PROGRAM } from '../solana/raydiumAmmV4.js';

export type LockRead = (method: string, params: unknown[]) => Promise<unknown>;

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const ZERO = '0x0000000000000000000000000000000000000000';
/** A V2 pair permanently parks its first 1,000 units at the zero address; that is not a lock by anyone. */
const MINIMUM_LIQUIDITY = 1000n;
/** Below this share burned, nothing is marked. */
export const LOCK_MIN_PCT = 50;

const pct = (burned: bigint, total: bigint): number => (total <= 0n ? 0 : Number((burned * 10_000n) / total) / 100);

/** Pure. The share of a pair's liquidity token that is burned, given its supply and the dead and zero balances. */
export function burnedShare(totalSupply: bigint, atDead: bigint, atZero: bigint, v2Minimum = true): number {
  const zero = v2Minimum && atZero >= MINIMUM_LIQUIDITY ? atZero - MINIMUM_LIQUIDITY : v2Minimum ? 0n : atZero;
  return pct(atDead + zero, totalSupply);
}

/** An EVM V2-style pair. Null when the address is not one, or the node cannot be read. */
export async function evmLock(read: LockRead, pool: string, now: number): Promise<TokenLock | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(pool)) return null;
  const calls = [encodeCall('totalSupply()', []), encodeCall('balanceOf(address)', [address(DEAD)]), encodeCall('balanceOf(address)', [address(ZERO)]), encodeCall('token0()', []), encodeCall('getReserves()', [])];
  try {
    const data = encodeFunction('aggregate3((address,bool,bytes)[])', [calls.map((c) => [pool, true, c])]);
    const out = await read('eth_call', [{ to: MULTICALL3, data }, 'latest']);
    if (typeof out !== 'string') return null;
    const [res] = decodeParams(['(bool,bytes)[]'], out) as [[boolean, string][]];
    const ok = res.map(([good, ret]) => (good && ret.length >= 66 ? ret : null));
    // A V2 pair answers token0() and getReserves(); anything else is some other kind of token or pool.
    if (!ok[0] || !ok[1] || !ok[2] || !ok[3] || !ok[4]) return null;
    const total = BigInt(ok[0]);
    if (total <= 0n) return null;
    return { pct: burnedShare(total, BigInt(ok[1]), BigInt(ok[2])), kind: 'burned', at: now };
  } catch {
    return null;
  }
}

export type SolRead = <T>(method: string, params: unknown[]) => Promise<T>;

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const base58 = (bytes: Uint8Array): string => {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = A[Number(n % 58n)]! + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
};

/** A Raydium AMM v4 pool. The liquidity-token mint is at byte 464 and the amount ever minted at byte 720. Null for anything else. */
export async function solanaLock(rpc: SolRead, pool: string, now: number): Promise<TokenLock | null> {
  try {
    const acct = await rpc<{ value: { owner: string; data: [string, string] } | null }>('getAccountInfo', [pool, { encoding: 'base64', commitment: 'confirmed' }]);
    if (!acct.value || acct.value.owner !== AMM_V4_PROGRAM) return null;
    const data = fromBase64(acct.value.data[0]);
    if (data.length !== 752) return null;
    const minted = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(720, true);
    if (minted <= 0n) return null;
    const supply = await rpc<{ value: { amount: string } }>('getTokenSupply', [base58(data.subarray(464, 496)), { commitment: 'confirmed' }]);
    const now_ = BigInt(supply.value.amount);
    if (now_ > minted) return null;
    return { pct: pct(minted - now_, minted), kind: 'burned', at: now };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ Uniswap V3 positions held by a locker

export interface V3LockerConfig {
  locker: string;
  positionManager: string;
  /** Who runs the locker, for the tooltip. */
  label: string;
}

/**
 * Lockers Aretia reads, per chain. Robinhood Chain: UNCX Liquidity Locker V3.1, from UNCX's published contracts table (it has
 * code on Robinhood mainnet); positionManager is Uniswap's NonfungiblePositionManager there.
 */
export const V3_LOCKERS: Readonly<Partial<Record<ChainId, V3LockerConfig>>> = {
  robinhood: { locker: '0xf28704c691290547924e2129d407da36bda8ce0f', positionManager: '0x73991a25c818bf1f1128deaab1492d45638de0d3', label: 'UNCX' },
};

/** A time lock on a V3 pool's liquidity. `until` is when the earliest locked position can come out; null when none has a real date. */
export interface TimeLock {
  pct: number;
  kind: 'time-locked';
  until: number | null;
  by: string;
  at: number;
}

/** An unlock date this far ahead is, in practice, no date at all. */
const FAR_FUTURE_S = 50 * 365 * 24 * 3600;

export interface LockerEntry {
  pool: string;
  nftId: bigint;
  /** Unix seconds. */
  unlockDate: bigint;
  positionManager: string;
}

/** Pure. One `Lock` struct from the locker's `getLock`: 11 words; the pool is word 2, the NFT word 3, the unlock date word 8. Null for an empty slot. */
export function parseLockerEntry(hex: string): LockerEntry | null {
  const w = words(hex);
  if (w.length < 11) return null;
  const pool = '0x' + w[2]!.slice(24).toLowerCase();
  if (/^0x0{40}$/.test(pool)) return null;
  return { pool, nftId: BigInt('0x' + w[3]!), unlockDate: BigInt('0x' + w[8]!), positionManager: '0x' + w[1]!.slice(24).toLowerCase() };
}

/** Pure. The part of a position's liquidity that counts, and the sums a result is built from. */
export function lockedShare(lockedInRange: bigint, poolLiquidity: bigint): number {
  if (poolLiquidity <= 0n || lockedInRange <= 0n) return 0;
  const raw = Number((lockedInRange * 10_000n) / poolLiquidity) / 100;
  return Math.min(100, raw);
}

const signed24 = (w: string): number => Number(BigInt.asIntN(24, BigInt('0x' + w)));

/** The chain could not be read just now (a slow or busy node). Different from "no lock found": the caller should try again later. */
export class LockReadError extends Error {
  constructor(message = 'The chain could not be read') {
    super(message);
    this.name = 'LockReadError';
  }
}

/** One Multicall3 round trip. A call that fails or returns nothing comes back as null; a node that does not answer throws LockReadError. */
async function multicall(read: LockRead, calls: [string, string][]): Promise<(string | null)[]> {
  const data = encodeFunction('aggregate3((address,bool,bytes)[])', [calls.map(([to, d]) => [to, true, d])]);
  let out: unknown;
  try {
    out = await read('eth_call', [{ to: MULTICALL3, data }, 'latest']);
  } catch {
    throw new LockReadError();
  }
  if (typeof out !== 'string') throw new LockReadError();
  const [res] = decodeParams(['(bool,bytes)[]'], out) as [[boolean, string][]];
  return res.map(([good, ret]) => (good && ret.length >= 66 ? ret : null));
}

const LOCKS_TTL_MS = 5 * 60_000;
const lockIndexes = new Map<string, { at: number; entries: LockerEntry[] }>();
/** Locks above this many are not read in one go; the newest are skipped rather than the page stalling. */
const MAX_LOCKS = 1500;
/** Locks are read in smaller batches, several at once: one huge request to a busy public node is the one that times out. */
const CHUNK = 40;
const PARALLEL = 4;

/** Every lock in the locker, read once and kept for a few minutes: one lookup serves every pool on screen. */
async function lockerEntries(read: LockRead, cfg: V3LockerConfig, now: number): Promise<LockerEntry[]> {
  const hit = lockIndexes.get(cfg.locker);
  if (hit && now - hit.at < LOCKS_TTL_MS) return hit.entries;
  const [len] = await multicall(read, [[cfg.locker, encodeCall('getLocksLength()', [])]]);
  if (!len) throw new LockReadError('The locker could not be read');
  const count = Math.min(Number(BigInt(len)), MAX_LOCKS);
  const entries: LockerEntry[] = [];
  const starts = Array.from({ length: Math.ceil(count / CHUNK) }, (_, i) => i * CHUNK);
  for (let b = 0; b < starts.length; b += PARALLEL) {
    const batch = await Promise.all(
      starts.slice(b, b + PARALLEL).map(async (from) => {
        const ids = Array.from({ length: Math.min(CHUNK, count - from) }, (_, i) => from + i);
        return multicall(read, ids.map((id): [string, string] => [cfg.locker, encodeCall('getLock(uint256)', [uint(BigInt(id))])]));
      }),
    );
    for (const got of batch) {
      for (const g of got) {
        const e = g ? parseLockerEntry(g) : null;
        if (e && e.positionManager === cfg.positionManager) entries.push(e);
      }
    }
  }
  lockIndexes.set(cfg.locker, { at: now, entries });
  return entries;
}

/** Forgets the remembered lock lists (for tests). */
export const clearLockIndexes = (): void => {
  lockIndexes.clear();
  v4Indexes.clear();
};

/**
 * A Uniswap V3 pool whose active liquidity is partly or wholly in position NFTs held by the chain's locker. Counts a position
 * only while the locker still holds it, its lock has not ended, and it is in range right now (the only part of the pool's
 * liquidity that trades). Null for a pool that is not V3, has no locker, or has nothing locked. Throws LockReadError, and only
 * that, when the node did not answer, so a busy node is retried rather than remembered as "not locked".
 */
export async function v3Lock(read: LockRead, chain: ChainId, pool: string, now: number): Promise<TimeLock | null> {
  const cfg = V3_LOCKERS[chain];
  if (!cfg || !/^0x[0-9a-fA-F]{40}$/.test(pool)) return null;
  try {
    const [liq, slot0] = await multicall(read, [[pool, encodeCall('liquidity()', [])], [pool, encodeCall('slot0()', [])]]);
    // A V3 pool answers both; anything else is some other kind of pool or token.
    if (!liq || !slot0) return null;
    const poolLiquidity = BigInt(liq);
    const tick = signed24(words(slot0)[1]!);
    if (poolLiquidity <= 0n) return null;
    const mine = (await lockerEntries(read, cfg, now)).filter((e) => e.pool === pool.toLowerCase());
    if (mine.length === 0) return null;
    const calls = mine.flatMap((e): [string, string][] => [[cfg.positionManager, encodeCall('ownerOf(uint256)', [uint(e.nftId)])], [cfg.positionManager, encodeCall('positions(uint256)', [uint(e.nftId)])]]);
    const got = await multicall(read, calls);
    const nowS = BigInt(Math.floor(now / 1000));
    let locked = 0n;
    let earliest: bigint | null = null;
    mine.forEach((e, i) => {
      const owner = got[i * 2];
      const pos = got[i * 2 + 1];
      if (!owner || !pos) return;
      // The NFT must still be in the locker, and its lock must not have ended.
      if ('0x' + words(owner)[0]!.slice(24).toLowerCase() !== cfg.locker) return;
      if (e.unlockDate <= nowS) return;
      const w = words(pos);
      const lower = signed24(w[5]!);
      const upper = signed24(w[6]!);
      const liquidity = BigInt('0x' + w[7]!);
      if (liquidity <= 0n || tick < lower || tick >= upper) return;
      locked += liquidity;
      if (e.unlockDate - nowS < BigInt(FAR_FUTURE_S) && (earliest === null || e.unlockDate < earliest)) earliest = e.unlockDate;
    });
    if (locked <= 0n) return null;
    return { pct: lockedShare(locked, poolLiquidity), kind: 'time-locked', until: earliest === null ? null : Number(earliest) * 1000, by: cfg.label, at: now };
  } catch (e) {
    if (e instanceof LockReadError) throw e;
    return null;
  }
}

// ------------------------------------------------------------------ Uniswap V4 positions held by a locker

export interface V4LockerConfig {
  locker: string;
  /** Uniswap's V4 PositionManager: the NFTs are its positions. */
  positionManager: string;
  /** Uniswap's V4 StateView: reads a pool's liquidity and price by pool id. */
  stateView: string;
  label: string;
}

/**
 * Robinhood Chain: UNCX's V4 locker, from UNCX's published contracts table. Its `locks(id)` getter returns 13 words (lock id, owner,
 * NFT id, the five fields of the pool key, liquidity, unlock date, collect address, two flags). That layout was checked against the
 * chain: the position manager reports the locker as owner of each NFT, its pool key equals the lock's fields, and its liquidity
 * equals the lock's recorded liquidity.
 */
export const V4_LOCKERS: Readonly<Partial<Record<ChainId, V4LockerConfig>>> = {
  robinhood: {
    locker: '0x128a800cbc615cc110bff16e475865c67631603a',
    positionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
    stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
    label: 'UNCX',
  },
};

export interface V4LockerEntry {
  nftId: bigint;
  /** The pool's 32-byte id, worked out from the pool key stored in the lock. Lower-case, 0x-prefixed. */
  poolId: string;
  /** Unix seconds. */
  unlockDate: bigint;
}

const bytesOf = (h: string): Uint8Array => Uint8Array.from((h.replace(/^0x/, '').match(/.{2}/g) ?? []).map((x) => parseInt(x, 16)));
const hexOf = (b: Uint8Array): string => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Pure. One `locks(id)` answer. The pool id is the keccak-256 of the pool key (words 3 to 7). Null for an empty slot (a withdrawn or unused id). */
export function parseV4LockerEntry(hex: string): V4LockerEntry | null {
  const w = words(hex);
  if (w.length < 13) return null;
  const nftId = BigInt('0x' + w[2]!);
  if (nftId === 0n) return null;
  return { nftId, poolId: hexOf(keccak256(bytesOf(w.slice(3, 8).join('')))), unlockDate: BigInt('0x' + w[9]!) };
}

const v4Indexes = new Map<string, { at: number; entries: V4LockerEntry[] }>();

/** Every live lock in the V4 locker, read once and kept a few minutes. Ids run from 1; it stops at the first block of ids with nothing in it. */
async function v4LockerEntries(read: LockRead, cfg: V4LockerConfig, now: number): Promise<V4LockerEntry[]> {
  const hit = v4Indexes.get(cfg.locker);
  if (hit && now - hit.at < LOCKS_TTL_MS) return hit.entries;
  const entries: V4LockerEntry[] = [];
  // The count is not published, so read a few batches at once and stop when the last of them has nothing in it.
  for (let from = 0; from < MAX_LOCKS; from += CHUNK * PARALLEL) {
    const starts = Array.from({ length: PARALLEL }, (_, i) => from + i * CHUNK).filter((s) => s < MAX_LOCKS);
    const batch = await Promise.all(
      starts.map(async (start) => {
        const ids = Array.from({ length: CHUNK }, (_, i) => start + i);
        const got = await multicall(read, ids.map((id): [string, string] => [cfg.locker, encodeCall('locks(uint256)', [uint(BigInt(id))])]));
        return got.map((g) => (g ? parseV4LockerEntry(g) : null)).filter((e): e is V4LockerEntry => e !== null);
      }),
    );
    for (const found of batch) entries.push(...found);
    if (batch[batch.length - 1]!.length === 0) break;
  }
  v4Indexes.set(cfg.locker, { at: now, entries });
  return entries;
}

/** Forgets the remembered V4 lock lists (for tests). */
export const clearV4LockIndexes = (): void => v4Indexes.clear();

const byId = (sig: string, id: string): string => '0x' + selector(sig) + id.replace(/^0x/, '');

/**
 * A Uniswap V4 pool (by its 32-byte pool id) whose active liquidity is partly or wholly in position NFTs held by the chain's V4
 * locker. Same rules as v3Lock: the locker must still hold the NFT, its lock must not have ended, and only liquidity in range now
 * counts. Throws LockReadError, and only that, when the node did not answer.
 */
export async function v4Lock(read: LockRead, chain: ChainId, poolId: string, now: number): Promise<TimeLock | null> {
  const cfg = V4_LOCKERS[chain];
  if (!cfg || !/^0x[0-9a-fA-F]{64}$/.test(poolId)) return null;
  const id = poolId.toLowerCase();
  try {
    const [liq, slot0] = await multicall(read, [[cfg.stateView, byId('getLiquidity(bytes32)', id)], [cfg.stateView, byId('getSlot0(bytes32)', id)]]);
    if (!liq || !slot0) return null;
    const poolLiquidity = BigInt(liq);
    const tick = signed24(words(slot0)[1]!);
    if (poolLiquidity <= 0n) return null;
    const mine = (await v4LockerEntries(read, cfg, now)).filter((e) => e.poolId === id);
    if (mine.length === 0) return null;
    const calls = mine.flatMap((e): [string, string][] => {
      const arg = [uint(e.nftId)];
      return [[cfg.positionManager, encodeCall('ownerOf(uint256)', arg)], [cfg.positionManager, encodeCall('getPoolAndPositionInfo(uint256)', arg)], [cfg.positionManager, encodeCall('getPositionLiquidity(uint256)', arg)]];
    });
    const got = await multicall(read, calls);
    const nowS = BigInt(Math.floor(now / 1000));
    let locked = 0n;
    let earliest: bigint | null = null;
    mine.forEach((e, i) => {
      const owner = got[i * 3];
      const info = got[i * 3 + 1];
      const liquidityHex = got[i * 3 + 2];
      if (!owner || !info || !liquidityHex) return;
      if ('0x' + words(owner)[0]!.slice(24).toLowerCase() !== cfg.locker) return;
      if (e.unlockDate <= nowS) return;
      const w = words(info);
      if (w.length < 6) return;
      // The packed position info: bits 8 to 31 are the lower tick and bits 32 to 55 the upper tick.
      const packed = BigInt('0x' + w[5]!);
      const lower = Number(BigInt.asIntN(24, packed >> 8n));
      const upper = Number(BigInt.asIntN(24, packed >> 32n));
      const liquidity = BigInt(liquidityHex);
      if (liquidity <= 0n || tick < lower || tick >= upper) return;
      locked += liquidity;
      if (e.unlockDate - nowS < BigInt(FAR_FUTURE_S) && (earliest === null || e.unlockDate < earliest)) earliest = e.unlockDate;
    });
    if (locked <= 0n) return null;
    return { pct: lockedShare(locked, poolLiquidity), kind: 'time-locked', until: earliest === null ? null : Number(earliest) * 1000, by: cfg.label, at: now };
  } catch (e) {
    if (e instanceof LockReadError) throw e;
    return null;
  }
}

/** Looks at a pool on any network. Throws LockReadError only when a V3 or V4 locker could not be read (try again later); otherwise returns what it found, or null. */
export async function checkLock(chain: ChainId, pool: string, reads: { evm?: LockRead; sol?: SolRead }, now: number): Promise<TokenLock | TimeLock | null> {
  if (chain === 'solana') return reads.sol ? solanaLock(reads.sol, pool, now) : null;
  if (!reads.evm) return null;
  // A V2-style pair first (a burned liquidity token is permanent), then a V3 pool, then a V4 pool (named by its 32-byte id), in a locker.
  return (await evmLock(reads.evm, pool, now)) ?? (await v3Lock(reads.evm, chain, pool, now)) ?? (await v4Lock(reads.evm, chain, pool, now));
}
