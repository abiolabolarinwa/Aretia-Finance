/**
 * Chain reads used by the indexer. Each one separates "the chain says no" (a definitive answer such as no contract code) from "I
 * could not ask" (a transport failure, which is thrown so the run is retried and no wrong fact is stored).
 */
import { decodeAbiString } from '../chains/evmSession.js';
import { cleanText } from '../tokens/safeText.js';
import { selector, wordToBigInt, wordToAddress, words } from '../engine/abi.js';
import { RpcError, type Read } from './rpc.js';
import { PRICE_SCALE, pow10 } from './math.js';

export const hexToNumber = (v: unknown): number | null => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(v)) return null;
  const n = Number.parseInt(v, 16);
  return Number.isSafeInteger(n) ? n : null;
};
export const toHex = (n: number): string => '0x' + n.toString(16);

export interface BlockInfo {
  number: number;
  hash: string;
  /** Unix seconds. */
  time: number;
}

export async function getBlock(read: Read, block: number | 'latest'): Promise<BlockInfo | null> {
  const b = (await read('eth_getBlockByNumber', [block === 'latest' ? 'latest' : toHex(block), false])) as { number?: string; hash?: string; timestamp?: string } | null;
  if (!b || typeof b.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(b.hash)) return null;
  const number = hexToNumber(b.number);
  const time = hexToNumber(b.timestamp);
  return number === null || time === null || time <= 0 ? null : { number, hash: b.hash.toLowerCase(), time };
}

export async function getHead(read: Read): Promise<number> {
  const n = hexToNumber(await read('eth_blockNumber', []));
  if (n === null) throw new RpcError('the node returned a malformed block number', 'node-error');
  return n;
}

/**
 * Logs in [from, to] for the filter. A node that refuses the range (too many results, too wide) is asked again with half of it,
 * down to a single block, so a busy range never blocks progress. Transport failures are not retried here (the reader did that).
 */
export async function getLogsHalving(read: Read, filter: { address?: string | string[]; topics: (string | string[] | null)[] }, from: number, to: number, depth = 0): Promise<unknown[]> {
  try {
    const out = await read('eth_getLogs', [{ ...filter, fromBlock: toHex(from), toBlock: toHex(to) }]);
    if (!Array.isArray(out)) throw new RpcError('the node returned malformed logs', 'node-error');
    return out;
  } catch (e) {
    if (e instanceof RpcError && e.kind === 'node-error' && to > from && depth < 12) {
      const mid = from + Math.floor((to - from) / 2);
      return [...(await getLogsHalving(read, filter, from, mid, depth + 1)), ...(await getLogsHalving(read, filter, mid + 1, to, depth + 1))];
    }
    throw e;
  }
}

export interface TokenFacts {
  symbol: string;
  name: string;
  decimals: number;
}

/** null: definitely not a readable ERC-20 (no code, or no valid decimals). Throws on transport failure. */
export async function readToken(read: Read, address: string): Promise<TokenFacts | null> {
  const code = await read('eth_getCode', [address, 'latest']);
  if (typeof code !== 'string' || code === '0x') return null;
  let decimals: number;
  try {
    const d = await read('eth_call', [{ to: address, data: '0x313ce567' }, 'latest']);
    decimals = typeof d === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(d) ? Number.parseInt(d, 16) : Number.NaN;
  } catch (e) {
    if (e instanceof RpcError && e.kind === 'transport') throw e;
    return null;
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const text = async (data: string): Promise<string | null> => {
    try {
      return decodeAbiString(await read('eth_call', [{ to: address, data }, 'latest']));
    } catch (e) {
      if (e instanceof RpcError && e.kind === 'transport') throw e;
      return null;
    }
  };
  const [symbol, name] = [await text('0x95d89b41'), await text('0x06fdde03')];
  // Token text is untrusted: control, zero-width, bidirectional and stacking characters are removed before it is stored or shown.
  return { symbol: cleanText(symbol ?? '', 20) || address.slice(0, 6), name: cleanText(name ?? '', 60), decimals };
}

/** V2 `getReserves()`: [reserve0, reserve1], or null when the pool does not answer like a V2 pair. */
export async function readV2Reserves(read: Read, pool: string): Promise<[bigint, bigint] | null> {
  try {
    const w = words((await read('eth_call', [{ to: pool, data: '0x' + selector('getReserves()') }, 'latest'])) as string);
    return w.length >= 2 ? [wordToBigInt(w[0]!), wordToBigInt(w[1]!)] : null;
  } catch (e) {
    if (e instanceof RpcError && e.kind === 'transport') throw e;
    return null;
  }
}

/** `balanceOf(holder)` of a token; null when it does not answer. */
export async function readBalance(read: Read, token: string, holder: string): Promise<bigint | null> {
  try {
    const out = (await read('eth_call', [{ to: token, data: '0x70a08231' + holder.slice(2).toLowerCase().padStart(64, '0') }, 'latest'])) as string;
    const w = words(out);
    return w.length >= 1 ? wordToBigInt(w[0]!) : null;
  } catch (e) {
    if (e instanceof RpcError && e.kind === 'transport') throw e;
    return null;
  }
}

/** Price of token0 in token1 (whole tokens) from a V3 pool's sqrtPriceX96, as a scaled integer (x 10^PRICE_SCALE). */
export function v3PriceScaled(sqrtPriceX96: bigint, decimals0: number, decimals1: number): bigint | null {
  if (sqrtPriceX96 <= 0n) return null;
  const num = sqrtPriceX96 * sqrtPriceX96 * pow10(decimals0) * pow10(PRICE_SCALE);
  const den = (1n << 192n) * pow10(decimals1);
  return (num * 2n + den) / (den * 2n);
}

export async function readSqrtPrice(read: Read, pool: string): Promise<bigint | null> {
  try {
    const w = words((await read('eth_call', [{ to: pool, data: '0x3850c7bd' }, 'latest'])) as string);
    return w.length >= 1 ? wordToBigInt(w[0]!) : null;
  } catch (e) {
    if (e instanceof RpcError && e.kind === 'transport') throw e;
    return null;
  }
}

export async function readAddress(read: Read, to: string, data: string): Promise<string | null> {
  try {
    const w = words((await read('eth_call', [{ to, data }, 'latest'])) as string);
    const a = w.length >= 1 ? wordToAddress(w[0]!) : null;
    return a && !/^0x0{40}$/.test(a) ? a : null;
  } catch (e) {
    if (e instanceof RpcError && e.kind === 'transport') throw e;
    return null;
  }
}

const SLOT0 = '0x' + selector('getSlot0(bytes32)');
const LIQUIDITY = '0x' + selector('getLiquidity(bytes32)');

export interface V4State {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
}

/** A Uniswap V4 pool's price and active liquidity, read through the StateView contract. Null when the pool does not answer. */
export async function readV4State(read: Read, stateView: string, poolId: string): Promise<V4State | null> {
  const id = poolId.replace(/^0x/, '').padStart(64, '0');
  try {
    const slot = words((await read('eth_call', [{ to: stateView, data: SLOT0 + id }, 'latest'])) as string);
    const liq = words((await read('eth_call', [{ to: stateView, data: LIQUIDITY + id }, 'latest'])) as string);
    if (slot.length < 2 || liq.length < 1) return null;
    return { sqrtPriceX96: wordToBigInt(slot[0]!), tick: Number(BigInt.asIntN(24, wordToBigInt(slot[1]!))), liquidity: wordToBigInt(liq[0]!) };
  } catch (e) {
    if (e instanceof RpcError && e.kind === 'transport') throw e;
    return null;
  }
}

/**
 * Token amounts a V4 pool can serve within 1% of its current price, assuming its active liquidity L stayed constant across that
 * range: token0 = L (1/sqrtP - 1/sqrtP_up), token1 = L (sqrtP - sqrtP_down). A singleton PoolManager holds every pool's tokens
 * together, so there is no per-pool balance to read; this is a depth estimate, not total value locked, and says so wherever it is shown.
 */
export function v4Depth(state: V4State): { amount0: bigint; amount1: bigint } | null {
  if (state.sqrtPriceX96 <= 0n || state.liquidity <= 0n) return { amount0: 0n, amount1: 0n };
  const sp = Number(state.sqrtPriceX96) / 2 ** 96;
  const l = Number(state.liquidity);
  const k = Math.sqrt(1.01);
  const a0 = l * (1 / sp - 1 / (sp * k));
  const a1 = l * (sp - sp / k);
  if (!Number.isFinite(a0) || !Number.isFinite(a1) || a0 < 0 || a1 < 0) return null;
  return { amount0: BigInt(Math.floor(a0)), amount1: BigInt(Math.floor(a1)) };
}
