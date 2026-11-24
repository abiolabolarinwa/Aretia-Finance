/**
 * A token's price in US dollars read straight from its pool on the chain, for the chart's last candle. The services that price tokens for a
 * chart (DexScreener's pair answer, Aretia's own index) are seconds behind, rounded, or missing trades; the pool itself is exact, and can be
 * asked again every fraction of a second from the visitor's own browser through a public node.
 *
 * What it reads:
 *  - Solana: Raydium CPMM, Raydium AMM v4 and PumpSwap pools (the two token vaults' balances), Orca Whirlpools and Raydium CLMM pools (the pool's
 *    sqrt price) and Meteora DLMM pools (the active bin and the bin step).
 *  - Ethereum-style networks: Uniswap V2 style pools (getReserves) and Uniswap V3 style pools (slot0).
 * Any other kind of pool answers null: the chart then keeps to its other sources, as before.
 *
 * Prices are in dollars only when the pool is paired with a dollar coin, or with the network's own coin (whose dollar price is read from
 * DexScreener's busiest pool for it and kept a few seconds: it moves slowly next to a small token). Any other pairing answers null.
 */
import { decodeBase58, fromBase64, parseAmmV4Pool, parseClmmPool, parseCpmmPool, parseDlmmPair, parseMint, parsePumpPool, parseWhirlpool, tokenAmount, whirlpoolPriceScaled, type PoolAccounts } from '../mi/solana/accounts.js';
import { HUB_TOKENS } from '../dex/hubs.js';
import { WRAPPED_NATIVE } from '../dex/entries.js';
import type { ChainId } from '../core/types.js';

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export interface ChainPriceDeps {
  /** A reader for the chain's public node. */
  rpc: Rpc;
  /** The dollar price of a network's coin (or a token), or null. */
  usdOf: (chain: ChainId, token: string) => Promise<number | null>;
}

/** Programs whose pools can be read. Written out here so the browser does not load the indexer's modules for the names. */
const CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const WSOL = 'So11111111111111111111111111111111111111112';
const SOLANA_DOLLARS = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);

export const PUBLIC_NODES: Readonly<Record<ChainId, string>> = {
  solana: 'https://solana-rpc.publicnode.com',
  ethereum: 'https://ethereum-rpc.publicnode.com',
  bnb: 'https://bsc-rpc.publicnode.com',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
  base: 'https://base-rpc.publicnode.com',
  robinhood: 'https://robinhood-rpc.publicnode.com',
};

/** A JSON-RPC reader for a chain's public node. Throws on an error answer, so a failed read is never taken for a price. */
export function publicRpc(chain: ChainId, fetchImpl: typeof fetch = (...a) => fetch(...a)): Rpc {
  let id = 0;
  return async (method, params) => {
    const res = await fetchImpl(PUBLIC_NODES[chain], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    if (!res.ok) throw new Error(`node answered ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? 'node error');
    return body.result;
  };
}

/** The dollar price of a token from DexScreener's deepest pool for it, kept for a few seconds. */
export function dexscreenerUsd(fetchImpl: typeof fetch = (...a) => fetch(...a), now: () => number = Date.now, ttlMs = 5_000): ChainPriceDeps['usdOf'] {
  const cache = new Map<string, { at: number; usd: number | null }>();
  return async (_chain, token) => {
    const hit = cache.get(token);
    if (hit && now() - hit.at < ttlMs) return hit.usd;
    let usd: number | null = null;
    try {
      const res = await fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(token)}`, { headers: { accept: 'application/json' } });
      if (res.ok) {
        const body = (await res.json()) as { pairs?: { baseToken?: { address?: string }; priceUsd?: string; liquidity?: { usd?: number } }[] };
        let best = -1;
        for (const p of body.pairs ?? []) {
          const price = Number(p.priceUsd);
          const liq = p.liquidity?.usd ?? 0;
          if (p.baseToken?.address?.toLowerCase() === token.toLowerCase() && Number.isFinite(price) && price > 0 && liq > best) {
            best = liq;
            usd = price;
          }
        }
      }
    } catch {
      usd = null;
    }
    // A failed read keeps the last good price for the next few seconds' worth of asks, rather than blanking the chart's feed.
    cache.set(token, { at: now(), usd: usd ?? hit?.usd ?? null });
    return usd ?? hit?.usd ?? null;
  };
}

/** Reads the pool's price of the target token in dollars now, or null when this read cannot give one. */
export type PriceReader = () => Promise<number | null>;

const word = (data: string, i: number): bigint | null => {
  const s = data.slice(2 + i * 64, 2 + (i + 1) * 64);
  return s.length === 64 ? BigInt(`0x${s}`) : null;
};
const addressWord = (data: string, i: number): string | null => {
  const s = data.slice(2 + i * 64 + 24, 2 + (i + 1) * 64);
  return s.length === 40 ? `0x${s}` : null;
};

/** The pool's reader, or null when its kind is not one this module reads (or its tokens cannot be priced in dollars). */
export async function createChainPricer(o: { chain: ChainId; pool: string; target: string }, d: ChainPriceDeps): Promise<PriceReader | null> {
  try {
    return o.chain === 'solana' ? await solanaPricer(o, d) : await evmPricer(o, d);
  } catch {
    return null;
  }
}

/** Price of the target in dollars from "A in B" (B per A, whole tokens) and which token is which. */
async function inDollars(chain: ChainId, aInB: number, a: string, b: string, target: string, d: ChainPriceDeps, dollars: ReadonlySet<string>, wrapped: string, same: (x: string, y: string) => boolean): Promise<number | null> {
  if (!(aInB > 0) || !Number.isFinite(aInB)) return null;
  const targetIsA = same(target, a);
  if (!targetIsA && !same(target, b)) return null;
  const quote = targetIsA ? b : a;
  const perQuote = targetIsA ? aInB : 1 / aInB;
  const usdQuote = [...dollars].some((x) => same(x, quote)) ? 1 : same(quote, wrapped) ? await d.usdOf(chain, wrapped) : null;
  return usdQuote !== null && usdQuote > 0 ? perQuote * usdQuote : null;
}

async function solanaPricer(o: { chain: ChainId; pool: string; target: string }, d: ChainPriceDeps): Promise<PriceReader | null> {
  const info = (await d.rpc('getAccountInfo', [o.pool, { encoding: 'base64', commitment: 'confirmed' }])) as { value: { owner: string; data: [string, string] } | null } | null;
  if (!info?.value) return null;
  const data = fromBase64(info.value.data[0]);
  const same = (x: string, y: string): boolean => x === y;
  let accounts: PoolAccounts | null;
  /** For pools that carry their own price (concentrated liquidity): B per A, in whole tokens, from the pool account. */
  let fromAccount: ((d: Uint8Array, decA: number, decB: number) => number | null) | null = null;
  switch (info.value.owner) {
    case CPMM:
      accounts = parseCpmmPool(data);
      break;
    case AMM_V4:
      accounts = parseAmmV4Pool(data);
      break;
    case PUMPSWAP:
      accounts = parsePumpPool(data);
      break;
    case WHIRLPOOL: {
      const w = parseWhirlpool(data);
      accounts = w ? { mintA: w.mintA, mintB: w.mintB, vaultA: w.vaultA, vaultB: w.vaultB } : null;
      fromAccount = (acc, decA, decB) => {
        const x = parseWhirlpool(acc);
        const scaled = x ? whirlpoolPriceScaled(x.sqrtPrice, decA, decB, 30) : null;
        return scaled === null ? null : Number(scaled) / 1e30;
      };
      break;
    }
    case CLMM:
      accounts = parseClmmPool(data);
      // sqrt_price_x64 (u128) at 253.
      fromAccount = (acc, decA, decB) => {
        if (acc.length !== 1544) return null;
        const v = new DataView(acc.buffer, acc.byteOffset, acc.byteLength);
        const sqrt = v.getBigUint64(253, true) + (v.getBigUint64(261, true) << 64n);
        if (sqrt <= 0n) return null;
        const root = Number(sqrt) / 2 ** 64;
        return root * root * 10 ** (decA - decB);
      };
      break;
    case DLMM:
      accounts = parseDlmmPair(data);
      // active_id (i32) at 76 and bin_step (u16) at 80: the price of X in Y, in raw units, is (1 + bin_step / 10000) ^ active_id.
      fromAccount = (acc, decA, decB) => {
        if (acc.length !== 904) return null;
        const v = new DataView(acc.buffer, acc.byteOffset, acc.byteLength);
        const id = v.getInt32(76, true);
        const step = v.getUint16(80, true);
        if (step <= 0) return null;
        const raw = Math.pow(1 + step / 10_000, id);
        return Number.isFinite(raw) && raw > 0 ? raw * 10 ** (decA - decB) : null;
      };
      break;
    default:
      return null;
  }
  if (!accounts || decodeBase58(accounts.mintA)?.length !== 32) return null;
  const mints = (await d.rpc('getMultipleAccounts', [[accounts.mintA, accounts.mintB], { encoding: 'base64', commitment: 'confirmed' }])) as { value: ({ data: [string, string] } | null)[] } | null;
  const decA = mints?.value?.[0] ? parseMint(fromBase64(mints.value[0].data[0]))?.decimals : undefined;
  const decB = mints?.value?.[1] ? parseMint(fromBase64(mints.value[1].data[0]))?.decimals : undefined;
  if (decA === undefined || decB === undefined) return null;
  const { mintA, mintB, vaultA, vaultB } = accounts;
  if (target(o.target, mintA, mintB) === null) return null;
  return async () => {
    let aInB: number | null = null;
    if (fromAccount) {
      const fresh = (await d.rpc('getAccountInfo', [o.pool, { encoding: 'base64', commitment: 'confirmed' }])) as { value: { data: [string, string] } | null } | null;
      aInB = fresh?.value ? fromAccount(fromBase64(fresh.value.data[0]), decA, decB) : null;
    } else {
      const got = (await d.rpc('getMultipleAccounts', [[vaultA, vaultB], { encoding: 'base64', commitment: 'confirmed' }])) as { value: ({ data: [string, string] } | null)[] } | null;
      const balA = got?.value?.[0] ? tokenAmount(fromBase64(got.value[0].data[0])) : null;
      const balB = got?.value?.[1] ? tokenAmount(fromBase64(got.value[1].data[0])) : null;
      if (balA !== null && balB !== null && balA > 0n && balB > 0n) aInB = (Number(balB) / Number(balA)) * 10 ** (decA - decB);
    }
    return aInB === null ? null : inDollars('solana', aInB, mintA, mintB, o.target, d, SOLANA_DOLLARS, WSOL, same);
  };
}

/** Which of the pool's two tokens the target is, or null. */
function target(t: string, a: string, b: string): 'a' | 'b' | null {
  return t === a ? 'a' : t === b ? 'b' : null;
}

async function evmPricer(o: { chain: ChainId; pool: string; target: string }, d: ChainPriceDeps): Promise<PriceReader | null> {
  const call = async (to: string, selector: string): Promise<string> => {
    const r = (await d.rpc('eth_call', [{ to, data: selector }, 'latest'])) as unknown;
    if (typeof r !== 'string' || r.length < 66) throw new Error('empty answer');
    return r;
  };
  const pool = o.pool.toLowerCase();
  const token0 = addressWord(await call(pool, '0x0dfe1681'), 0);
  const token1 = addressWord(await call(pool, '0xd21220a7'), 0);
  if (!token0 || !token1) return null;
  const targetAddress = o.target.toLowerCase();
  if (targetAddress !== token0 && targetAddress !== token1) return null;
  const dec0 = Number(word(await call(token0, '0x313ce567'), 0));
  const dec1 = Number(word(await call(token1, '0x313ce567'), 0));
  if (!Number.isInteger(dec0) || !Number.isInteger(dec1) || dec0 > 36 || dec1 > 36) return null;
  // Which kind of pool: a V2 style pool answers getReserves, a V3 style pool answers slot0. Anything else (V4, Algebra...) is not read.
  let kind: 'v2' | 'v3' | null = null;
  try {
    await call(pool, '0x0902f1ac');
    kind = 'v2';
  } catch {
    try {
      await call(pool, '0x3850c7bd');
      kind = 'v3';
    } catch {
      kind = null;
    }
  }
  if (!kind) return null;
  const dollars = new Set((HUB_TOKENS[o.chain] ?? []).filter((h) => ['USDC', 'USDT', 'DAI', 'USDG'].includes(h.symbol)).map((h) => h.address.toLowerCase()));
  const wrapped = ((WRAPPED_NATIVE as Record<string, string | undefined>)[o.chain] ?? '').toLowerCase();
  const same = (x: string, y: string): boolean => x.toLowerCase() === y.toLowerCase();
  return async () => {
    let aInB: number | null = null;
    if (kind === 'v2') {
      const r = await call(pool, '0x0902f1ac');
      const r0 = word(r, 0);
      const r1 = word(r, 1);
      if (r0 !== null && r1 !== null && r0 > 0n && r1 > 0n) aInB = (Number(r1) / Number(r0)) * 10 ** (dec0 - dec1);
    } else {
      const s = word(await call(pool, '0x3850c7bd'), 0);
      if (s !== null && s > 0n) {
        const root = Number(s) / 2 ** 96;
        aInB = root * root * 10 ** (dec0 - dec1);
      }
    }
    return aInB === null ? null : inDollars(o.chain, aInB, token0, token1, targetAddress, d, dollars, wrapped, same);
  };
}
