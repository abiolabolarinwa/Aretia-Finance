/**
 * Is a pool's liquidity locked? Aretia answers only what it can prove from the chain itself:
 *
 *  - EVM pairs that mint a liquidity token (Uniswap V2 and its many forks, on every EVM network): the share of that token
 *    sitting at the dead or zero address. Those tokens can never be redeemed, so the money behind them can never be taken out.
 *  - Raydium AMM v4 on Solana: the share of the liquidity token that was burned, from the pool's own record of what it ever
 *    minted against what exists now.
 *
 * Not covered, and so never marked: liquidity held by a time-lock contract (the lock can end), concentrated-liquidity
 * positions (V3, V4, CLMM), and other Solana pool kinds. No mark means "not shown to be burned", not "unlocked".
 */
import type { ChainId, TokenLock } from '../core/types.js';
import { decodeParams, encodeFunction } from '../engine/abiGeneric.js';
import { encodeCall, address } from '../engine/abi.js';
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

/** Looks at a pool on any network. Never throws. */
export async function checkLock(chain: ChainId, pool: string, reads: { evm?: LockRead; sol?: SolRead }, now: number): Promise<TokenLock | null> {
  if (chain === 'solana') return reads.sol ? solanaLock(reads.sol, pool, now) : null;
  return reads.evm ? evmLock(reads.evm, pool, now) : null;
}
