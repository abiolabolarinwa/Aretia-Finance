import { describe, expect, it } from 'vitest';
import { AMM_V4_PROGRAM } from '../solana/raydiumAmmV4.js';
import { burnedShare, checkLock, clearLockIndexes, evmLock, LockReadError, lockedShare, parseLockerEntry, parseV4LockerEntry, solanaLock, v3Lock, v4Lock, V3_LOCKERS, V4_LOCKERS, type LockRead, type SolRead } from './lock.js';
import { keccak256 } from '../core/keccak.js';
import { decodeParams, encodeParams } from '../engine/abiGeneric.js';
import { encodeCall, selector, uint } from '../engine/abi.js';
import { marketFromAttributes } from './snapshot.js';
import { rowNumbers } from './snapshot.js';

const NOW = 1_800_000_000_000;
const MINT = 'So11111111111111111111111111111111111111112';

describe('burned liquidity', () => {
  it('does not count the 1,000 units every V2 pair parks at the zero address', () => {
    expect(burnedShare(1_000_000n, 0n, 1000n)).toBe(0);
    expect(burnedShare(1_000_000n, 500_000n, 1000n)).toBe(50);
    expect(burnedShare(1_000_000n, 0n, 501_000n)).toBe(50);
    expect(burnedShare(0n, 0n, 0n)).toBe(0);
  });

  it('gives nothing for an address that is not a pair, or when the node fails', async () => {
    expect(await evmLock((async () => '0x') as LockRead, '0x' + '1'.repeat(40), NOW)).toBeNull();
    expect(await evmLock((async () => { throw new Error('down'); }) as LockRead, '0x' + '1'.repeat(40), NOW)).toBeNull();
    expect(await evmLock((async () => '0x') as LockRead, 'not an address', NOW)).toBeNull();
    expect(await checkLock('base', '0x' + '1'.repeat(40), {}, NOW)).toBeNull();
  });

  it('reads a Raydium AMM v4 pool: burned share is what was minted minus what exists', async () => {
    const data = new Uint8Array(752);
    new DataView(data.buffer).setBigUint64(720, 1000n, true);
    const rpc = (async (method: string) => {
      if (method === 'getAccountInfo') return { value: { owner: AMM_V4_PROGRAM, data: [btoa(String.fromCharCode(...data)), 'base64'] } };
      return { value: { amount: '250' } };
    }) as SolRead;
    expect(await solanaLock(rpc, MINT, NOW)).toEqual({ pct: 75, kind: 'burned', at: NOW });
    const other = (async () => ({ value: { owner: '11111111111111111111111111111111', data: ['', 'base64'] } })) as SolRead;
    expect(await solanaLock(other, MINT, NOW)).toBeNull();
  });

  it('a row shows the padlock only from half burned', () => {
    const m = marketFromAttributes({ base_token_price_usd: '1' }, 'p'.repeat(30), NOW)!;
    expect(rowNumbers({ ...m, lock: { pct: 99.9, kind: 'burned', at: NOW } }, null, NOW).lockedPct).toBe(99.9);
    expect(rowNumbers({ ...m, lock: { pct: 10, kind: 'burned', at: NOW } }, null, NOW).lockedPct).toBeNull();
    expect(rowNumbers(m, null, NOW).lockedPct).toBeNull();
  });
});

// ------------------------------------------------------------------ Uniswap V3 positions in a locker

const LOCKER = V3_LOCKERS.robinhood!.locker;
const NPM = V3_LOCKERS.robinhood!.positionManager;
const POOL = '0x' + 'ab'.repeat(20);
const word = (n: bigint | number): string => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const addrWord = (a: string): string => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const NOW_S = Math.floor(NOW / 1000);

interface Position { id: number; unlock: number; owner?: string; lower?: number; upper?: number; liquidity?: bigint }

/** A tiny chain: Multicall3 answering for one V3 pool, the locker's lock list and the position manager. */
function fakeChain(o: { poolLiquidity: bigint | null; tick: number; positions: Position[]; lockedPool?: string }): LockRead {
  const lockPool = o.lockedPool ?? POOL;
  const handlers = new Map<string, string | null>();
  const sel = (sig: string): string => selector(sig).replace(/^0x/, '');
  const key = (to: string, sig: string, arg = ''): string => `${to.toLowerCase()}:${sel(sig)}${arg}`;
  handlers.set(key(POOL, 'liquidity()'), o.poolLiquidity === null ? null : '0x' + word(o.poolLiquidity));
  handlers.set(key(POOL, 'slot0()'), o.poolLiquidity === null ? null : '0x' + [word(1n << 96n), word(o.tick), ...Array(5).fill(word(0))].join(''));
  handlers.set(key(LOCKER, 'getLocksLength()'), '0x' + word(o.positions.length));
  o.positions.forEach((p, i) => {
    handlers.set(key(LOCKER, 'getLock(uint256)', word(i)), '0x' + [word(i), addrWord(NPM), addrWord(lockPool), word(p.id), addrWord('0x' + '11'.repeat(20)), word(0), word(0), word(0), word(p.unlock), word(0), word(0)].join(''));
    handlers.set(key(NPM, 'ownerOf(uint256)', word(p.id)), '0x' + addrWord(p.owner ?? LOCKER));
    handlers.set(key(NPM, 'positions(uint256)', word(p.id)), '0x' + [word(0), word(0), word(0), word(0), word(0), word(p.lower ?? -1000), word(p.upper ?? 1000), word(p.liquidity ?? 100n), ...Array(5).fill(word(0))].join(''));
  });
  return (async (method: string, params: unknown[]) => {
    expect(method).toBe('eth_call');
    const tx = params[0] as { to: string; data: string };
    const [calls] = decodeParams(['(address,bool,bytes)[]'], '0x' + tx.data.slice(10)) as [[string, boolean, string][]];
    const results = calls.map(([to, , data]) => {
      const k = `${to.toLowerCase()}:${data.replace(/^0x/, '').slice(0, 8)}${data.replace(/^0x/, '').slice(8)}`;
      const hit = handlers.get(k);
      return [hit !== undefined && hit !== null, hit ?? '0x'] as [boolean, string];
    });
    return '0x' + encodeParams(['(bool,bytes)[]'], [results]).replace(/^0x/, '');
  }) as LockRead;
}

describe('Uniswap V3 pools in a locker', () => {
  const day = 86_400;

  it('reads a lock struct and refuses an empty slot', () => {
    const hex = '0x' + [word(7), addrWord(NPM), addrWord(POOL), word(1234), addrWord('0x' + '22'.repeat(20)), word(0), word(0), word(0), word(NOW_S + day), word(0), word(0)].join('');
    expect(parseLockerEntry(hex)).toEqual({ pool: POOL, nftId: 1234n, unlockDate: BigInt(NOW_S + day), positionManager: NPM });
    expect(parseLockerEntry('0x' + Array(11).fill(word(0)).join(''))).toBeNull();
    expect(parseLockerEntry('0x')).toBeNull();
  });

  it('shares a pool\'s liquidity between locked and the rest', () => {
    expect(lockedShare(150n, 200n)).toBe(75);
    expect(lockedShare(500n, 200n)).toBe(100);
    expect(lockedShare(0n, 200n)).toBe(0);
    expect(lockedShare(5n, 0n)).toBe(0);
  });

  it('marks a pool whose active liquidity is all in the locker, with the unlock date and who holds it', async () => {
    clearLockIndexes();
    const read = fakeChain({ poolLiquidity: 100n, tick: 0, positions: [{ id: 1, unlock: NOW_S + 90 * day }] });
    expect(await v3Lock(read, 'robinhood', POOL, NOW)).toEqual({ pct: 100, kind: 'time-locked', until: (NOW_S + 90 * day) * 1000, by: 'UNCX', at: NOW });
  });

  it('counts only the locked part of a pool that has other liquidity too', async () => {
    clearLockIndexes();
    const read = fakeChain({ poolLiquidity: 400n, tick: 0, positions: [{ id: 1, unlock: NOW_S + 90 * day, liquidity: 100n }, { id: 2, unlock: NOW_S + 30 * day, liquidity: 200n }] });
    const lock = await v3Lock(read, 'robinhood', POOL, NOW);
    expect(lock?.pct).toBe(75);
    // The soonest unlock is the one that matters: the locked share shrinks then.
    expect(lock?.until).toBe((NOW_S + 30 * day) * 1000);
  });

  it('says there is no date when the unlock date is decades away', async () => {
    clearLockIndexes();
    const read = fakeChain({ poolLiquidity: 100n, tick: 0, positions: [{ id: 1, unlock: NOW_S + 100 * 365 * day }] });
    expect((await v3Lock(read, 'robinhood', POOL, NOW))?.until).toBeNull();
  });

  it('does not count a lock that has ended, a position that left the locker, or one out of range', async () => {
    clearLockIndexes();
    expect(await v3Lock(fakeChain({ poolLiquidity: 100n, tick: 0, positions: [{ id: 1, unlock: NOW_S - day }] }), 'robinhood', POOL, NOW)).toBeNull();
    clearLockIndexes();
    expect(await v3Lock(fakeChain({ poolLiquidity: 100n, tick: 0, positions: [{ id: 1, unlock: NOW_S + day, owner: '0x' + '33'.repeat(20) }] }), 'robinhood', POOL, NOW)).toBeNull();
    clearLockIndexes();
    expect(await v3Lock(fakeChain({ poolLiquidity: 100n, tick: 5000, positions: [{ id: 1, unlock: NOW_S + day }] }), 'robinhood', POOL, NOW)).toBeNull();
  });

  it('gives nothing for a pool that is not V3, is empty, has no lock, or is on a chain with no locker', async () => {
    clearLockIndexes();
    expect(await v3Lock(fakeChain({ poolLiquidity: null, tick: 0, positions: [{ id: 1, unlock: NOW_S + day }] }), 'robinhood', POOL, NOW)).toBeNull();
    clearLockIndexes();
    expect(await v3Lock(fakeChain({ poolLiquidity: 0n, tick: 0, positions: [{ id: 1, unlock: NOW_S + day }] }), 'robinhood', POOL, NOW)).toBeNull();
    clearLockIndexes();
    expect(await v3Lock(fakeChain({ poolLiquidity: 100n, tick: 0, positions: [{ id: 1, unlock: NOW_S + day }], lockedPool: '0x' + 'cd'.repeat(20) }), 'robinhood', POOL, NOW)).toBeNull();
    expect(await v3Lock(fakeChain({ poolLiquidity: 100n, tick: 0, positions: [] }), 'bnb', POOL, NOW)).toBeNull();
  });

  it('says so when the node does not answer, instead of reporting "no lock"', async () => {
    clearLockIndexes();
    const down = (async () => { throw new Error('down'); }) as LockRead;
    await expect(v3Lock(down, 'robinhood', POOL, NOW)).rejects.toBeInstanceOf(LockReadError);
    await expect(checkLock('robinhood', POOL, { evm: down }, NOW)).rejects.toBeInstanceOf(LockReadError);
    // A chain with no locker never needs the node for this, so it is simply "no lock".
    expect(await checkLock('bnb', POOL, { evm: down }, NOW)).toBeNull();
  });

  it('checkLock tries a V3 locker after the V2 check finds nothing', async () => {
    clearLockIndexes();
    const read = fakeChain({ poolLiquidity: 100n, tick: 0, positions: [{ id: 1, unlock: NOW_S + day }] });
    // The fake answers only the V3 calls, so the V2 questions come back empty and the V3 path is the one that answers.
    expect((await checkLock('robinhood', POOL, { evm: read }, NOW))?.kind).toBe('time-locked');
  });
});

// ------------------------------------------------------------------ Uniswap V4 positions in a locker

const V4 = V4_LOCKERS.robinhood!;
const KEY_WORDS = [addrWord('0x' + '00'.repeat(20)), addrWord('0x' + '77'.repeat(20)), word(3000), word(60), addrWord('0x' + '00'.repeat(20))];
const hexOfBytes = (b: Uint8Array): string => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const POOL_ID = hexOfBytes(keccak256(Uint8Array.from((KEY_WORDS.join('').match(/.{2}/g) ?? []).map((x) => parseInt(x, 16)))));

interface V4Position { id: number; nft: number; unlock: number; owner?: string; lower?: number; upper?: number; liquidity?: bigint; key?: string[] }

/** A tiny chain for V4: Multicall3 answering for the StateView, the V4 position manager and the locker's `locks(id)`. */
function fakeV4Chain(o: { poolLiquidity: bigint | null; tick: number; positions: V4Position[] }): LockRead {
  const handlers = new Map<string, string | null>();
  const sel = (sig: string): string => selector(sig).replace(/^0x/, '');
  const k = (to: string, sig: string, arg: string): string => `${to.toLowerCase()}:${sel(sig)}${arg}`;
  const id = POOL_ID.replace(/^0x/, '');
  handlers.set(k(V4.stateView, 'getLiquidity(bytes32)', id), o.poolLiquidity === null ? null : '0x' + word(o.poolLiquidity));
  handlers.set(k(V4.stateView, 'getSlot0(bytes32)', id), o.poolLiquidity === null ? null : '0x' + [word(1n << 96n), word(o.tick), word(0), word(0)].join(''));
  o.positions.forEach((p) => {
    const key = p.key ?? KEY_WORDS;
    handlers.set(k(V4.locker, 'locks(uint256)', word(p.id)), '0x' + [word(p.id), addrWord('0x' + '11'.repeat(20)), word(p.nft), ...key, word(p.liquidity ?? 100n), word(p.unlock), addrWord('0x' + '11'.repeat(20)), word(1), word(400)].join(''));
    handlers.set(k(V4.positionManager, 'ownerOf(uint256)', word(p.nft)), '0x' + addrWord(p.owner ?? V4.locker));
    const packed = (BigInt.asUintN(24, BigInt(p.upper ?? 1000)) << 32n) | (BigInt.asUintN(24, BigInt(p.lower ?? -1000)) << 8n);
    handlers.set(k(V4.positionManager, 'getPoolAndPositionInfo(uint256)', word(p.nft)), '0x' + [...key, word(packed)].join(''));
    handlers.set(k(V4.positionManager, 'getPositionLiquidity(uint256)', word(p.nft)), '0x' + word(p.liquidity ?? 100n));
  });
  return (async (_method: string, params: unknown[]) => {
    const tx = params[0] as { data: string };
    const [calls] = decodeParams(['(address,bool,bytes)[]'], '0x' + tx.data.slice(10)) as [[string, boolean, string][]];
    const results = calls.map(([to, , data]) => {
      const hit = handlers.get(`${to.toLowerCase()}:${data.replace(/^0x/, '')}`);
      return [hit !== undefined && hit !== null, hit ?? '0x'] as [boolean, string];
    });
    return '0x' + encodeParams(['(bool,bytes)[]'], [results]).replace(/^0x/, '');
  }) as LockRead;
}

describe('Uniswap V4 pools in a locker', () => {
  const day = 86_400;
  const lockWords = (nft: number, unlock: number, key = KEY_WORDS): string => '0x' + [word(1), addrWord('0x' + '11'.repeat(20)), word(nft), ...key, word(100n), word(unlock), addrWord('0x' + '11'.repeat(20)), word(1), word(400)].join('');

  it('reads a lock and works out its pool id from the stored pool key', () => {
    const e = parseV4LockerEntry(lockWords(407767, NOW_S + day));
    expect(e).toEqual({ nftId: 407767n, poolId: POOL_ID, unlockDate: BigInt(NOW_S + day) });
    expect(parseV4LockerEntry(lockWords(0, 0))).toBeNull();
    expect(parseV4LockerEntry('0x')).toBeNull();
  });

  it('marks a pool whose active liquidity is all in the locker, with the date and who holds it', async () => {
    clearLockIndexes();
    const read = fakeV4Chain({ poolLiquidity: 100n, tick: 0, positions: [{ id: 1, nft: 5001, unlock: NOW_S + 60 * day }] });
    expect(await v4Lock(read, 'robinhood', POOL_ID, NOW)).toEqual({ pct: 100, kind: 'time-locked', until: (NOW_S + 60 * day) * 1000, by: 'UNCX', at: NOW });
  });

  it('counts the locked part only, and the soonest unlock', async () => {
    clearLockIndexes();
    const read = fakeV4Chain({ poolLiquidity: 400n, tick: 0, positions: [{ id: 1, nft: 5001, unlock: NOW_S + 90 * day, liquidity: 100n }, { id: 2, nft: 5002, unlock: NOW_S + 30 * day, liquidity: 200n }] });
    const lock = await v4Lock(read, 'robinhood', POOL_ID, NOW);
    expect(lock?.pct).toBe(75);
    expect(lock?.until).toBe((NOW_S + 30 * day) * 1000);
  });

  it('does not count an ended lock, an NFT that left the locker, or a position out of range', async () => {
    clearLockIndexes();
    expect(await v4Lock(fakeV4Chain({ poolLiquidity: 100n, tick: 0, positions: [{ id: 1, nft: 5001, unlock: NOW_S - day }] }), 'robinhood', POOL_ID, NOW)).toBeNull();
    clearLockIndexes();
    expect(await v4Lock(fakeV4Chain({ poolLiquidity: 100n, tick: 0, positions: [{ id: 1, nft: 5001, unlock: NOW_S + day, owner: '0x' + '33'.repeat(20) }] }), 'robinhood', POOL_ID, NOW)).toBeNull();
    clearLockIndexes();
    expect(await v4Lock(fakeV4Chain({ poolLiquidity: 100n, tick: 5000, positions: [{ id: 1, nft: 5001, unlock: NOW_S + day }] }), 'robinhood', POOL_ID, NOW)).toBeNull();
  });

  it('ignores locks that belong to other pools, and pools that are empty or unknown', async () => {
    clearLockIndexes();
    const other = [addrWord('0x' + '00'.repeat(20)), addrWord('0x' + '88'.repeat(20)), word(3000), word(60), addrWord('0x' + '00'.repeat(20))];
    expect(await v4Lock(fakeV4Chain({ poolLiquidity: 100n, tick: 0, positions: [{ id: 1, nft: 5001, unlock: NOW_S + day, key: other }] }), 'robinhood', POOL_ID, NOW)).toBeNull();
    clearLockIndexes();
    expect(await v4Lock(fakeV4Chain({ poolLiquidity: 0n, tick: 0, positions: [{ id: 1, nft: 5001, unlock: NOW_S + day }] }), 'robinhood', POOL_ID, NOW)).toBeNull();
    expect(await v4Lock(fakeV4Chain({ poolLiquidity: null, tick: 0, positions: [] }), 'robinhood', POOL_ID, NOW)).toBeNull();
    // Not a 32-byte id, or a chain without a V4 locker: no question is asked.
    expect(await v4Lock(fakeV4Chain({ poolLiquidity: 100n, tick: 0, positions: [] }), 'robinhood', '0x' + 'ab'.repeat(20), NOW)).toBeNull();
    expect(await v4Lock(fakeV4Chain({ poolLiquidity: 100n, tick: 0, positions: [] }), 'bnb', POOL_ID, NOW)).toBeNull();
  });

  it('says so when the node does not answer, and checkLock reaches V4 for a 32-byte pool id', async () => {
    clearLockIndexes();
    await expect(v4Lock((async () => { throw new Error('down'); }) as LockRead, 'robinhood', POOL_ID, NOW)).rejects.toBeInstanceOf(LockReadError);
    clearLockIndexes();
    const read = fakeV4Chain({ poolLiquidity: 100n, tick: 0, positions: [{ id: 1, nft: 5001, unlock: NOW_S + day }] });
    expect((await checkLock('robinhood', POOL_ID, { evm: read }, NOW))?.kind).toBe('time-locked');
  });
});
