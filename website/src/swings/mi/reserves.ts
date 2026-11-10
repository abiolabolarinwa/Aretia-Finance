/**
 * Reads the reserves of many pools in one node request, through the Multicall3 contract (same address on the chains below).
 *   V2 pool: `getReserves()` of the pool itself (the pool's own on-chain reserves).
 *   V3 pool: the pool's balance of each of its two tokens (a V3 pool has no reserves call; this is what the engine uses too).
 * A call that fails (no such pool, not a token) yields null for that pool and never stops the others. A failure to reach the node throws.
 */
import { encodeAggregate3 } from '../shield/approvals.js';
import { selector } from '../engine/abi.js';
import { WRAPPED_NATIVE } from '../dex/entries.js';
import { NATIVE_ADDRESS, type MiChainConfig } from './chains.js';
import { priceFromSqrt, priceString } from './math.js';
import type { Read } from './rpc.js';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
/** Chains where Multicall3 is deployed at the standard address. Others fall back to the engine's per-pool reads. */
export const MULTICALL_CHAINS: readonly string[] = ['ethereum', 'bnb', 'polygon', 'base'];

export interface ReserveQuery {
  kind: 'v2' | 'v3';
  pool: string;
  base: string;
  quote: string;
  baseIsToken0: boolean;
}
/** `sqrtPriceX96` is the pool's own current price, read for V3 pools only (a V3 pool's balances do not give its price). */
export type Reserves = { base: bigint; quote: bigint; sqrtPriceX96?: bigint } | null;

const GET_RESERVES = '0x' + selector('getReserves()');
const SLOT0 = '0x' + selector('slot0()');
const balanceOf = (holder: string): string => '0x70a08231' + holder.replace(/^0x/, '').toLowerCase().padStart(64, '0');

/** The reply of `aggregate3`: for each call whether it worked and the bytes it returned (hex, no prefix). */
export function decodeAggregate3Data(hex: string): { success: boolean; data: string }[] {
  const h = hex.replace(/^0x/, '');
  const at = (i: number): number => Number(BigInt('0x' + (h.slice(i * 2, i * 2 + 64) || '0')));
  const start = at(0);
  const n = at(start);
  const base = start + 32;
  const out: { success: boolean; data: string }[] = [];
  for (let i = 0; i < n; i++) {
    const item = base + at(base + i * 32);
    const success = at(item) === 1;
    const bytesAt = item + at(item + 32);
    const len = at(bytesAt);
    out.push({ success, data: h.slice((bytesAt + 32) * 2, (bytesAt + 32 + len) * 2) });
  }
  return out;
}

const wordAt = (data: string, i: number): bigint | null => (data.length >= (i + 1) * 64 ? BigInt('0x' + data.slice(i * 64, (i + 1) * 64)) : null);

const TOTAL_SUPPLY = '0x18160ddd'; // totalSupply()

/** The total supply of many ERC-20 tokens in one node request; null for a token that does not answer or answers nonsense. */
export async function readTotalSupplies(read: Read, tokens: readonly string[]): Promise<(bigint | null)[]> {
  if (tokens.length === 0) return [];
  const raw = (await read('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(tokens.map((t) => ({ target: t, data: TOTAL_SUPPLY }))) }, 'latest'])) as string;
  const res = decodeAggregate3Data(String(raw));
  if (res.length !== tokens.length) throw new Error('the multicall answered with the wrong number of results');
  return res.map((r) => (r.success ? wordAt(r.data, 0) : null));
}

export async function readReservesBatch(read: Read, queries: readonly ReserveQuery[]): Promise<Reserves[]> {
  if (queries.length === 0) return [];
  const calls: { target: string; data: string }[] = [];
  for (const q of queries) {
    if (q.kind === 'v2') calls.push({ target: q.pool, data: GET_RESERVES });
    else calls.push({ target: q.base, data: balanceOf(q.pool) }, { target: q.quote, data: balanceOf(q.pool) }, { target: q.pool, data: SLOT0 });
  }
  const raw = (await read('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(calls) }, 'latest'])) as string;
  const res = decodeAggregate3Data(String(raw));
  if (res.length !== calls.length) throw new Error('the multicall answered with the wrong number of results');
  let i = 0;
  return queries.map((q): Reserves => {
    if (q.kind === 'v2') {
      const r = res[i++]!;
      const r0 = r.success ? wordAt(r.data, 0) : null;
      const r1 = r.success ? wordAt(r.data, 1) : null;
      if (r0 === null || r1 === null) return null;
      return q.baseIsToken0 ? { base: r0, quote: r1 } : { base: r1, quote: r0 };
    }
    const b = res[i++]!;
    const qt = res[i++]!;
    const sl = res[i++]!;
    const bb = b.success ? wordAt(b.data, 0) : null;
    const qb = qt.success ? wordAt(qt.data, 0) : null;
    const sp = sl.success ? wordAt(sl.data, 0) : null;
    if (bb === null || qb === null) return null;
    // A failed slot0 read leaves the price out; the balances (liquidity) are still good.
    return sp !== null && sp > 0n ? { base: bb, quote: qb, sqrtPriceX96: sp } : { base: bb, quote: qb };
  });
}

/**
 * Dollar value of one whole quote token: 1 for a dollar stablecoin, the chain's reference price for the wrapped or native coin, and
 * unknown (null) for any other quote token. It is never guessed: a pool quoted in a token with no known dollar price has no dollar liquidity.
 */
export async function quoteUsdFor(chain: MiChainConfig, quote: string, nativeUsd: (() => Promise<number | null>) | undefined): Promise<number | null> {
  const q = chain.quoteTokens.find((x) => x.address === quote);
  if (!q) return null;
  if (q.role === 'usd') return 1;
  const wrapped = (WRAPPED_NATIVE as Record<string, string>)[chain.id]?.toLowerCase();
  if (q.address === NATIVE_ADDRESS || q.address === wrapped) return nativeUsd ? await nativeUsd() : null;
  return null;
}

/**
 * The pool's current price from its reserves: quote per base (a fixed-point string) and in dollars when the quote's dollar value is known.
 * V2: the reserve ratio. V3: the pool's own `sqrtPriceX96`. Null when the reserves cannot give one. This is a price read from the
 * pool's state, not a traded price: it is never stored as one.
 */
export function reservePriceOf(kind: 'v2' | 'v3', res: { base: bigint; quote: bigint; sqrtPriceX96?: bigint }, baseIsToken0: boolean, baseDecimals: number, quoteDecimals: number, quoteUsd: number | null): { price: string; usd: number | null } | null {
  const price = kind === 'v2' ? priceString(res.base, baseDecimals, res.quote, quoteDecimals) : res.sqrtPriceX96 !== undefined ? priceFromSqrt(res.sqrtPriceX96, baseIsToken0, baseDecimals, quoteDecimals) : null;
  if (price === null) return null;
  const n = Number(price);
  return { price, usd: quoteUsd !== null && Number.isFinite(n) && n > 0 ? n * quoteUsd : null };
}

export const liquidityUsdOf = (quoteReserve: bigint, quoteDecimals: number, quoteUsd: number | null): number | null => (quoteUsd === null ? null : (Number(quoteReserve) / 10 ** quoteDecimals) * 2 * quoteUsd);
