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
 * Prices are in dollars only when the pool is paired with a dollar coin, or with the network's own coin (whose dollar price is read from the
 * chain too, from the deepest coin/dollar pool of that network, and kept a couple of seconds). Any other pairing answers null. Nothing here
 * asks a price service: the only thing contacted is the chain's public node.
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

/**
 * The deepest pool pairing each network's own coin with a dollar coin. The coin's dollar price is read from it on the chain, so the price of a
 * token paired with the coin needs no price service. Robinhood Chain has no such pool that is known, so tokens paired with its coin are not priced here.
 */
export const NATIVE_REFERENCE: Readonly<Partial<Record<ChainId, { pool: string; coin: string }>>> = {
  solana: { pool: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', coin: WSOL },
  ethereum: { pool: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', coin: WRAPPED_NATIVE.ethereum },
  bnb: { pool: '0x172fcD41E0913e95784454622d1c3724f546f849', coin: WRAPPED_NATIVE.bnb },
  polygon: { pool: '0xA374094527e1673A86dE625aa59517c5dE346d32', coin: WRAPPED_NATIVE.polygon },
  base: { pool: '0xd0b53D9277642d899DF5C87A3966A349A798F224', coin: WRAPPED_NATIVE.base },
};

/** How long the last good price of a coin is kept when reading it fails. */
const NATIVE_KEEP_MS = 60_000;

/** The dollar price of a network's own coin, read from the chain and kept `ttlMs`. A failed read keeps the last good price for a minute, then answers null. */
export function chainNativeUsd(rpcFor: (chain: ChainId) => Rpc, now: () => number = Date.now, ttlMs = 2_000): ChainPriceDeps['usdOf'] {
  const readers = new Map<ChainId, Promise<PriceReader | null>>();
  const last = new Map<ChainId, { at: number; usd: number }>();
  const inflight = new Map<ChainId, Promise<number | null>>();
  return (chain) => {
    const ref = NATIVE_REFERENCE[chain];
    if (!ref) return Promise.resolve(null);
    const hit = last.get(chain);
    if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.usd);
    const running = inflight.get(chain);
    if (running) return running;
    let reader = readers.get(chain);
    if (!reader) {
      // The reference pool is paired with a dollar coin, so reading it never asks for a coin price.
      reader = createChainPricer({ chain, pool: ref.pool, target: ref.coin }, { rpc: rpcFor(chain), usdOf: async () => null });
      readers.set(chain, reader);
    }
    const p = reader
      .then(async (read) => {
        if (!read) throw new Error('no reader');
        const usd = await read();
        if (usd === null || !(usd > 0)) throw new Error('no price');
        last.set(chain, { at: now(), usd });
        return usd;
      })
      .catch(() => {
        // Ask again from scratch next time when the pool could not even be described.
        readers.delete(chain);
        const old = last.get(chain);
        return old && now() - old.at < NATIVE_KEEP_MS ? old.usd : null;
      })
      .finally(() => inflight.delete(chain));
    inflight.set(chain, p);
    return p;
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

/**
 * What to read from the chain to price one pool, and how to turn what was read into dollars. The reads are separate from the pricing so a
 * Markets page can put the reads of every pool on screen into one request per network (see chainBoard.ts), while a chart reads one pool.
 */
export type PricePlan =
  | { kind: 'solana'; accounts: string[]; price: (data: readonly (Uint8Array | null)[]) => Promise<number | null> }
  | { kind: 'evm'; calls: { to: string; data: string }[]; price: (results: readonly (string | null)[]) => Promise<number | null> };

/** The pool's plan, or null when its kind is not one this module reads (or its tokens cannot be priced in dollars). */
export async function planChainPrice(o: { chain: ChainId; pool: string; target: string }, d: ChainPriceDeps): Promise<PricePlan | null> {
  try {
    return o.chain === 'solana' ? await solanaPlan(o, d) : await evmPlan(o, d);
  } catch {
    return null;
  }
}

/** The pool's reader, or null when its kind is not one this module reads (or its tokens cannot be priced in dollars). */
export async function createChainPricer(o: { chain: ChainId; pool: string; target: string }, d: ChainPriceDeps): Promise<PriceReader | null> {
  const plan = await planChainPrice(o, d);
  if (!plan) return null;
  if (plan.kind === 'solana') {
    const accounts = plan.accounts;
    return async () => {
      const got = (await d.rpc('getMultipleAccounts', [accounts, { encoding: 'base64', commitment: 'confirmed' }])) as { value: ({ data: [string, string] } | null)[] } | null;
      return plan.price(accounts.map((_, i) => (got?.value?.[i] ? fromBase64(got.value[i]!.data[0]) : null)));
    };
  }
  return async () => plan.price(await Promise.all(plan.calls.map((c) => d.rpc('eth_call', [c, 'latest']).then((r) => (typeof r === 'string' ? r : null)))));
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

async function solanaPlan(o: { chain: ChainId; pool: string; target: string }, d: ChainPriceDeps): Promise<PricePlan | null> {
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
  const decA = await mintDecimals(d.rpc, accounts.mintA, accounts.mintB, 0);
  const decB = await mintDecimals(d.rpc, accounts.mintA, accounts.mintB, 1);
  if (decA === undefined || decB === undefined) return null;
  const { mintA, mintB, vaultA, vaultB } = accounts;
  if (target(o.target, mintA, mintB) === null) return null;
  return {
    kind: 'solana',
    accounts: fromAccount ? [o.pool] : [vaultA, vaultB],
    price: async (got) => {
      let aInB: number | null = null;
      if (fromAccount) {
        aInB = got[0] ? fromAccount(got[0], decA, decB) : null;
      } else {
        const balA = got[0] ? tokenAmount(got[0]) : null;
        const balB = got[1] ? tokenAmount(got[1]) : null;
        if (balA !== null && balB !== null && balA > 0n && balB > 0n) aInB = (Number(balB) / Number(balA)) * 10 ** (decA - decB);
      }
      return aInB === null ? null : inDollars('solana', aInB, mintA, mintB, o.target, d, SOLANA_DOLLARS, WSOL, same);
    },
  };
}

/** Mint decimals never change, so a mint is read once for every pool that holds it (the dollar coins and SOL sit in most of them). */
const knownDecimals = new Map<string, number>();

/** The decimals of one of a pool's two mints (0 for the first, 1 for the second), reading both together when either is not known yet. */
async function mintDecimals(rpc: Rpc, mintA: string, mintB: string, which: 0 | 1): Promise<number | undefined> {
  const want = which === 0 ? mintA : mintB;
  const known = knownDecimals.get(want);
  if (known !== undefined) return known;
  const missing = [mintA, mintB].filter((m, i, all) => !knownDecimals.has(m) && all.indexOf(m) === i);
  const got = (await rpc('getMultipleAccounts', [missing, { encoding: 'base64', commitment: 'confirmed' }])) as { value: ({ data: [string, string] } | null)[] } | null;
  missing.forEach((m, i) => {
    const v = got?.value?.[i];
    const dec = v ? parseMint(fromBase64(v.data[0]))?.decimals : undefined;
    if (dec !== undefined) knownDecimals.set(m, dec);
  });
  return knownDecimals.get(want);
}

/** Which of the pool's two tokens the target is, or null. */
function target(t: string, a: string, b: string): 'a' | 'b' | null {
  return t === a ? 'a' : t === b ? 'b' : null;
}

async function evmPlan(o: { chain: ChainId; pool: string; target: string }, d: ChainPriceDeps): Promise<PricePlan | null> {
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
  return {
    kind: 'evm',
    calls: [{ to: pool, data: kind === 'v2' ? '0x0902f1ac' : '0x3850c7bd' }],
    price: async (results) => {
      const r = results[0];
      if (!r || r.length < 66) throw new Error('empty answer');
      let aInB: number | null = null;
      if (kind === 'v2') {
        const r0 = word(r, 0);
        const r1 = word(r, 1);
        if (r0 !== null && r1 !== null && r0 > 0n && r1 > 0n) aInB = (Number(r1) / Number(r0)) * 10 ** (dec0 - dec1);
      } else {
        const sq = word(r, 0);
        if (sq !== null && sq > 0n) {
          const root = Number(sq) / 2 ** 96;
          aInB = root * root * 10 ** (dec0 - dec1);
        }
      }
      return aInB === null ? null : inDollars(o.chain, aInB, token0, token1, targetAddress, d, dollars, wrapped, same);
    },
  };
}
