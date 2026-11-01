/**
 * Decoding of EVM logs into indexer facts. Strict: a log that is not exactly the expected shape is rejected (null), never
 * guessed at, and a log flagged `removed` (a reorg notice from a node) is never accepted.
 */
import { wordToAddress } from '../engine/abi.js';
import { TOPICS } from './dexes.js';
import { priceString } from './math.js';
import type { MiPool, MiTrade } from './types.js';

export interface RawLog {
  address?: unknown;
  topics?: unknown;
  data?: unknown;
  blockNumber?: unknown;
  blockHash?: unknown;
  transactionHash?: unknown;
  logIndex?: unknown;
  removed?: unknown;
}

const HEX = /^0x[0-9a-fA-F]*$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const isHexQty = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{1,16}$/.test(v);

export interface LogMeta {
  address: string;
  block: number;
  blockHash: string;
  tx: string;
  logIndex: number;
  topics: string[];
  data: string;
}

/** Common checks; returns the log's metadata or null. */
export function logMeta(raw: unknown): LogMeta | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const l = raw as RawLog;
  if (l.removed === true) return null;
  if (typeof l.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(l.address)) return null;
  if (!Array.isArray(l.topics) || l.topics.some((t) => typeof t !== 'string' || !HASH.test(t))) return null;
  if (typeof l.data !== 'string' || !HEX.test(l.data) || l.data.length % 2 !== 0) return null;
  if (!isHexQty(l.blockNumber) || !isHexQty(l.logIndex)) return null;
  if (typeof l.blockHash !== 'string' || !HASH.test(l.blockHash) || typeof l.transactionHash !== 'string' || !HASH.test(l.transactionHash)) return null;
  const block = Number.parseInt(l.blockNumber, 16);
  const logIndex = Number.parseInt(l.logIndex, 16);
  if (!Number.isSafeInteger(block) || !Number.isSafeInteger(logIndex)) return null;
  return { address: l.address.toLowerCase(), block, blockHash: l.blockHash.toLowerCase(), tx: l.transactionHash.toLowerCase(), logIndex, topics: (l.topics as string[]).map((t) => t.toLowerCase()), data: l.data.slice(2) };
}

const dataWords = (data: string, min: number): string[] | null => {
  if (data.length % 64 !== 0 || data.length / 64 < min) return null;
  const out: string[] = [];
  for (let i = 0; i < data.length; i += 64) out.push(data.slice(i, i + 64));
  return out;
};
const topicAddress = (t: string): string => wordToAddress(t.slice(2));
const uint = (w: string): bigint => BigInt('0x' + w);
const int256 = (w: string): bigint => {
  const v = uint(w);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
};
/** An address word is valid only if its 12 high bytes are zero. */
const cleanAddressWord = (w: string): boolean => /^0{24}/.test(w);

export interface Creation {
  token0: string;
  token1: string;
  pool: string;
  feeTier: number | null;
  /** Uniswap V4 only. */
  tickSpacing?: number;
  hooks?: string;
  /** Set when the pool is being added on request rather than found at its creation event: its history is then not complete from the start. */
  tracked?: boolean;
  block: number;
  blockHash: string;
  tx: string;
  logIndex: number;
}

/** PairCreated (V2 factories) or PoolCreated (V3 factories) emitted by `factory`. */
const ID64 = /^0x[0-9a-f]{64}$/;
const signed24 = (w: string): number => {
  const v = Number(BigInt.asIntN(24, uint(w)));
  return v;
};

export function decodeCreation(raw: unknown, kind: 'v2' | 'v3' | 'v4', factory: string, shape?: 'aero' | 'slipstream'): Creation | null {
  const m = logMeta(raw);
  if (!m || m.address !== factory.toLowerCase()) return null;
  if (shape === 'aero') {
    // PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)
    if (m.topics.length !== 4 || m.topics[0] !== TOPICS.aeroPoolCreated) return null;
    const w = dataWords(m.data, 2);
    if (!w || !cleanAddressWord(w[0]!) || !cleanAddressWord(m.topics[1]!.slice(2)) || !cleanAddressWord(m.topics[2]!.slice(2))) return null;
    return { token0: topicAddress(m.topics[1]!), token1: topicAddress(m.topics[2]!), pool: wordToAddress(w[0]!), feeTier: null, block: m.block, blockHash: m.blockHash, tx: m.tx, logIndex: m.logIndex };
  }
  if (shape === 'slipstream') {
    // PoolCreated(address indexed token0, address indexed token1, int24 indexed tickSpacing, address pool)
    if (m.topics.length !== 4 || m.topics[0] !== TOPICS.slipstreamPoolCreated) return null;
    const w = dataWords(m.data, 1);
    if (!w || !cleanAddressWord(w[0]!) || !cleanAddressWord(m.topics[1]!.slice(2)) || !cleanAddressWord(m.topics[2]!.slice(2))) return null;
    return { token0: topicAddress(m.topics[1]!), token1: topicAddress(m.topics[2]!), pool: wordToAddress(w[0]!), feeTier: null, tickSpacing: signed24(m.topics[3]!.slice(2)), block: m.block, blockHash: m.blockHash, tx: m.tx, logIndex: m.logIndex };
  }
  if (kind === 'v4') {
    // Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)
    if (m.topics.length !== 4 || m.topics[0] !== TOPICS.v4Initialize || !ID64.test(m.topics[1]!)) return null;
    const w = dataWords(m.data, 5);
    if (!w || w.length !== 5 || !cleanAddressWord(w[2]!) || !cleanAddressWord(m.topics[2]!.slice(2)) || !cleanAddressWord(m.topics[3]!.slice(2))) return null;
    const fee = Number(uint(w[0]!));
    if (!Number.isSafeInteger(fee) || fee > 16_777_215) return null;
    return { token0: topicAddress(m.topics[2]!), token1: topicAddress(m.topics[3]!), pool: m.topics[1]!, feeTier: fee, tickSpacing: signed24(w[1]!), hooks: wordToAddress(w[2]!), block: m.block, blockHash: m.blockHash, tx: m.tx, logIndex: m.logIndex };
  }
  if (kind === 'v2') {
    if (m.topics.length !== 3 || m.topics[0] !== TOPICS.v2PairCreated) return null;
    const w = dataWords(m.data, 2);
    if (!w || !cleanAddressWord(w[0]!) || !cleanAddressWord(m.topics[1]!.slice(2)) || !cleanAddressWord(m.topics[2]!.slice(2))) return null;
    return { token0: topicAddress(m.topics[1]!), token1: topicAddress(m.topics[2]!), pool: wordToAddress(w[0]!), feeTier: null, block: m.block, blockHash: m.blockHash, tx: m.tx, logIndex: m.logIndex };
  }
  if (m.topics.length !== 4 || m.topics[0] !== TOPICS.v3PoolCreated) return null;
  const w = dataWords(m.data, 2);
  if (!w || !cleanAddressWord(w[1]!)) return null;
  const fee = Number(uint(m.topics[3]!.slice(2)));
  if (!Number.isSafeInteger(fee) || fee > 16_777_215) return null;
  return { token0: topicAddress(m.topics[1]!), token1: topicAddress(m.topics[2]!), pool: wordToAddress(w[1]!), feeTier: fee, block: m.block, blockHash: m.blockHash, tx: m.tx, logIndex: m.logIndex };
}

export interface RawSwap {
  pool: string;
  /** Pool-side net change of token0 and token1: positive means the pool received that token. */
  net0: bigint;
  net1: bigint;
  maker: string;
  block: number;
  blockHash: string;
  tx: string;
  logIndex: number;
}

/** A swap event of a V2 pair (`Swap`) or a V3 pool (Uniswap or Pancake shape), for the pool that emitted it. */
export function decodeSwap(raw: unknown, kind: 'v2' | 'v3' | 'v4', swapTopic: string): RawSwap | null {
  const m = logMeta(raw);
  if (!m || m.topics.length !== 3 || m.topics[0] !== swapTopic) return null;
  if (kind === 'v4') {
    // Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee).
    // The amounts are the SWAPPER's balance changes (positive: the swapper received it; checked against the token transfers of real
    // swaps), so the pool's side is their negative.
    if (!ID64.test(m.topics[1]!)) return null;
    const w = dataWords(m.data, 6);
    if (!w || w.length !== 6) return null;
    return { pool: m.topics[1]!, net0: -int256(w[0]!), net1: -int256(w[1]!), maker: topicAddress(m.topics[2]!), block: m.block, blockHash: m.blockHash, tx: m.tx, logIndex: m.logIndex };
  }
  if (kind === 'v2') {
    const w = dataWords(m.data, 4);
    if (!w || w.length !== 4) return null;
    return { pool: m.address, net0: uint(w[0]!) - uint(w[2]!), net1: uint(w[1]!) - uint(w[3]!), maker: topicAddress(m.topics[2]!), block: m.block, blockHash: m.blockHash, tx: m.tx, logIndex: m.logIndex };
  }
  const w = dataWords(m.data, 5);
  // 5 words (Uniswap) or 7 words (Pancake, with the two protocol-fee amounts).
  if (!w || (w.length !== 5 && w.length !== 7)) return null;
  return { pool: m.address, net0: int256(w[0]!), net1: int256(w[1]!), maker: topicAddress(m.topics[2]!), block: m.block, blockHash: m.blockHash, tx: m.tx, logIndex: m.logIndex };
}

/**
 * A swap seen from a pool's point of view as a trade of its base token against its quote token, or null when it is not a
 * swap of one for the other (both sides moved the same way, or one side did not move) or the price cannot be stated.
 */
export function tradeOf(pool: Pick<MiPool, 'chain' | 'address' | 'baseIsToken0' | 'baseDecimals' | 'quoteDecimals'>, s: RawSwap, time: number): MiTrade | null {
  const baseNet = pool.baseIsToken0 ? s.net0 : s.net1;
  const quoteNet = pool.baseIsToken0 ? s.net1 : s.net0;
  if (baseNet === 0n || quoteNet === 0n || baseNet > 0n === quoteNet > 0n) return null;
  // The pool received the quote token and paid out the base token: someone bought the base token.
  const side = quoteNet > 0n ? 'buy' : 'sell';
  const base = baseNet < 0n ? -baseNet : baseNet;
  const quote = quoteNet < 0n ? -quoteNet : quoteNet;
  const price = priceString(base, pool.baseDecimals, quote, pool.quoteDecimals);
  if (price === null || !Number.isInteger(time) || time <= 0) return null;
  return { chain: pool.chain, pool: pool.address, id: `${s.tx}:${s.logIndex}`, block: s.block, blockHash: s.blockHash, time, side, baseAmount: base.toString(), quoteAmount: quote.toString(), price, maker: s.maker };
}
