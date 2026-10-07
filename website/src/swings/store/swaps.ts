/**
 * Aretia's own swap history: what a swap record is, how one is read out of a Solana transaction, how records become
 * candles, and a reference in-memory store. The database version (src/swings/store/supabase.ts) must give the same
 * answers; the tests run both against the same swaps.
 *
 * How a Solana swap is read: not from any one venue's instruction layout, which differs for every program and changes,
 * but from what happened to the pool's two token vaults. In a swap one vault gains the token that was sold and the
 * other loses the token that was bought. That is true for every venue, so one decoder serves all of them.
 *  - one vault up and the other down by non-zero amounts: a swap;
 *  - both up or both down: liquidity was added or removed, not a swap, and is ignored;
 *  - several swaps through the same pool in one transaction (a routed trade) are recorded as one record at their
 *    net, so the price is their volume-weighted average;
 *  - failed transactions are ignored.
 * The amounts are the pool's own, so for a token with a transfer fee (ACT) they are what the pool received or paid,
 * not what a wallet sent or got.
 */
import type { ChainId } from '../core/types.js';

/** A pool the indexer follows. `base` is the token being priced; `quote` is what it is priced in. */
export interface TrackedPool {
  chain: ChainId;
  pool: string;
  venue: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  /** Solana: the pool's two token accounts. */
  baseVault?: string;
  quoteVault?: string;
  /** EVM: which pool token is the base, and the swap-event shape the pool emits. */
  baseIsToken0?: boolean;
  eventKind?: 'v2' | 'v3';
}

export interface SwapRecord {
  chain: ChainId;
  pool: string;
  /** Unique within the pool: a transaction signature (Solana) or `txHash:logIndex` (EVM). */
  id: string;
  /** Unix seconds. */
  time: number;
  /** Position within the same second, so candles are deterministic. Slot (Solana) or block and log index (EVM). */
  seq: number;
  side: 'buy' | 'sell';
  /** Raw amounts, as decimal strings (they can exceed 2^53). */
  baseAmount: string;
  quoteAmount: string;
  /** Quote tokens per base token, decimals applied. */
  price: number;
  /** The quote side of the trade in whole quote tokens. */
  quoteVolume: number;
}

const toBig = (v: unknown): bigint | null => {
  try {
    return typeof v === 'string' && /^-?[0-9]+$/.test(v) ? BigInt(v) : null;
  } catch {
    return null;
  }
};

/** Builds a record from the raw base and quote amounts, or null when the numbers cannot describe a swap. */
export function makeSwap(pool: TrackedPool, o: { id: string; time: number; seq: number; baseAmount: bigint; quoteAmount: bigint; side: 'buy' | 'sell' }): SwapRecord | null {
  if (o.baseAmount <= 0n || o.quoteAmount <= 0n || !Number.isInteger(o.time) || o.time <= 0) return null;
  // Divide in two steps so very large raw amounts keep their precision.
  const base = Number(o.baseAmount) / 10 ** pool.baseDecimals;
  const quote = Number(o.quoteAmount) / 10 ** pool.quoteDecimals;
  const price = quote / base;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quote)) return null;
  return { chain: pool.chain, pool: pool.pool, id: o.id, time: o.time, seq: o.seq, side: o.side, baseAmount: o.baseAmount.toString(), quoteAmount: o.quoteAmount.toString(), price, quoteVolume: quote };
}

interface TokenBalance {
  accountIndex?: number;
  uiTokenAmount?: { amount?: string };
}

/** The transaction as `getTransaction` returns it with `jsonParsed` encoding, reduced to what the decoder reads. */
export interface ParsedTx {
  slot?: number;
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    loadedAddresses?: { writable?: string[]; readonly?: string[] };
  } | null;
  transaction?: { message?: { accountKeys?: ({ pubkey?: string } | string)[] } };
}

/** The swap a transaction made through this pool, or null if it made none. */
export function decodeSolanaSwap(tx: ParsedTx | null, signature: string, pool: TrackedPool): SwapRecord | null {
  if (!tx || !tx.meta || (tx.meta.err !== null && tx.meta.err !== undefined)) return null;
  if (typeof tx.blockTime !== 'number' || !pool.baseVault || !pool.quoteVault) return null;
  const keys = [...(tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : (k.pubkey ?? ''))), ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const indexOf = (address: string): number => keys.indexOf(address);
  const delta = (address: string): bigint | null => {
    const i = indexOf(address);
    if (i < 0) return null;
    const pre = tx.meta!.preTokenBalances?.find((b) => b.accountIndex === i);
    const post = tx.meta!.postTokenBalances?.find((b) => b.accountIndex === i);
    const a = toBig(pre?.uiTokenAmount?.amount ?? '0');
    const b = toBig(post?.uiTokenAmount?.amount ?? '0');
    // A vault with no entry at all was not touched; one that exists only after (or only before) is read as zero on the other side.
    return pre === undefined && post === undefined ? null : a === null || b === null ? null : b - a;
  };
  const dBase = delta(pool.baseVault);
  const dQuote = delta(pool.quoteVault);
  if (dBase === null || dQuote === null || dBase === 0n || dQuote === 0n) return null;
  if ((dBase > 0n) === (dQuote > 0n)) return null; // liquidity moved, not a swap
  // The base vault gained base tokens: someone sold the base token. Otherwise they bought it.
  const side = dBase > 0n ? 'sell' : 'buy';
  return makeSwap(pool, { id: signature, time: tx.blockTime, seq: tx.slot ?? 0, baseAmount: dBase < 0n ? -dBase : dBase, quoteAmount: dQuote < 0n ? -dQuote : dQuote, side });
}

// ------------------------------------------------------------------ candles

export interface Candle {
  /** Unix seconds at the start of the period. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Quote tokens traded in the period. */
  volume: number;
  trades: number;
}

/** Candle lengths, in seconds. */
export const CANDLE_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3_600, '4h': 14_400, '1d': 86_400 } as const;
export type CandleFrame = keyof typeof CANDLE_SECONDS;

/**
 * Candles from swap records: one per period that had a swap, oldest first. A period with no swaps has no candle, the
 * same as GeckoTerminal. Open is the first swap's price and close the last, ordered by time then `seq` then id, so the
 * result does not depend on the order the records arrive in.
 */
export function buildCandles(swaps: SwapRecord[], seconds: number): Candle[] {
  if (!Number.isInteger(seconds) || seconds <= 0) return [];
  const ordered = [...swaps].sort((a, b) => a.time - b.time || a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: Candle[] = [];
  for (const s of ordered) {
    const t = Math.floor(s.time / seconds) * seconds;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, s.price);
      last.low = Math.min(last.low, s.price);
      last.close = s.price;
      last.volume += s.quoteVolume;
      last.trades += 1;
    } else out.push({ time: t, open: s.price, high: s.price, low: s.price, close: s.price, volume: s.quoteVolume, trades: 1 });
  }
  return out;
}

// ------------------------------------------------------------------ store

export interface SwapStore {
  /** Idempotent: a record with the same (chain, pool, id) is not stored twice. Returns how many were new. */
  put(records: SwapRecord[]): Promise<number>;
  /** Records for a pool in [from, to] (unix seconds), oldest first. */
  list(chain: ChainId, pool: string, from: number, to: number, limit?: number): Promise<SwapRecord[]>;
  candles(chain: ChainId, pool: string, seconds: number, from: number, to: number): Promise<Candle[]>;
  /** What is stored for a pool: how many swaps, and the first and last time. Null when there are none. */
  coverage(chain: ChainId, pool: string): Promise<{ swaps: number; first: number; last: number } | null>;
  getCursor(chain: ChainId, pool: string): Promise<string | null>;
  setCursor(chain: ChainId, pool: string, cursor: string): Promise<void>;
}

export class InMemorySwapStore implements SwapStore {
  private readonly rows = new Map<string, SwapRecord>();
  private readonly cursors = new Map<string, string>();
  private key = (chain: ChainId, pool: string, id: string): string => `${chain}|${pool}|${id}`;

  async put(records: SwapRecord[]): Promise<number> {
    let added = 0;
    for (const r of records) {
      const k = this.key(r.chain, r.pool, r.id);
      if (!this.rows.has(k)) {
        this.rows.set(k, r);
        added++;
      }
    }
    return added;
  }

  async list(chain: ChainId, pool: string, from: number, to: number, limit = 100_000): Promise<SwapRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.chain === chain && r.pool === pool && r.time >= from && r.time <= to)
      .sort((a, b) => a.time - b.time || a.seq - b.seq || (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }

  async candles(chain: ChainId, pool: string, seconds: number, from: number, to: number): Promise<Candle[]> {
    return buildCandles(await this.list(chain, pool, from, to), seconds);
  }

  async coverage(chain: ChainId, pool: string): Promise<{ swaps: number; first: number; last: number } | null> {
    const all = [...this.rows.values()].filter((r) => r.chain === chain && r.pool === pool);
    if (all.length === 0) return null;
    return { swaps: all.length, first: Math.min(...all.map((r) => r.time)), last: Math.max(...all.map((r) => r.time)) };
  }

  async getCursor(chain: ChainId, pool: string): Promise<string | null> {
    return this.cursors.get(`${chain}|${pool}`) ?? null;
  }

  async setCursor(chain: ChainId, pool: string, cursor: string): Promise<void> {
    this.cursors.set(`${chain}|${pool}`, cursor);
  }
}
