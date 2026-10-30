/**
 * Launch Box numbers for a Solana token whose pool the price feed does not list yet. A pool opened on the Launch page is a Meteora
 * DAMM v2 pool; a one-sided or tiny one can take a long while to appear on DexScreener, and the feed shows no price at all until
 * both sides hold something. Here the pool is found from the token's own transactions and its price, reserves and supply are read
 * from the chain, so the row shows what is true now. Volume and 24-hour change are not on the chain in one read: they stay empty.
 *
 * Only pools whose other side is wrapped SOL are read, and the dollar figures come from SOL's price, so nothing is shown that cannot
 * be backed. A token with no such pool is left out, and the row keeps saying "No market yet".
 */
import type * as Web3 from '@solana/web3.js';
import { METEORA_DAMM_V2_PROGRAM, parseDammPool } from '../solana/meteoraDamm.js';
import type { MarketInfo } from './markets.js';

const WSOL = 'So11111111111111111111111111111111111111112';
/** The newest transactions of a token searched for its pool opening. */
const SEARCH_SIGNATURES = 6;

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
interface RawAccount {
  data: [string, string];
  owner: string;
}

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const u64 = (d: Uint8Array, o: number): bigint => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);

/** Pool addresses already found, per mint, so a refresh does not search the history again. */
const poolOf = new Map<string, string>();
export function resetDammMarkets(): void {
  poolOf.clear();
}

export function makeRpc(fetchImpl: typeof fetch, url: string): Rpc {
  return async (method, params) => {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`The node answered ${res.status}.`);
    const body = (await res.json()) as { result?: unknown; error?: unknown };
    if (body.error !== undefined) throw new Error('The node refused the request.');
    return body.result;
  };
}

const accountsOf = async (rpc: Rpc, addresses: string[]): Promise<(RawAccount | null)[]> => {
  if (addresses.length === 0) return [];
  return ((await rpc('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }])) as { value: (RawAccount | null)[] }).value;
};

/** The DAMM v2 pool (token against wrapped SOL) that the token's recent transactions touched, if any. */
async function findPool(rpc: Rpc, web3: typeof Web3, mint: string): Promise<string | null> {
  const known = poolOf.get(mint);
  if (known) return known;
  const sigs = ((await rpc('getSignaturesForAddress', [mint, { limit: SEARCH_SIGNATURES, commitment: 'confirmed' }])) as { signature: string; err: unknown }[]).filter((s) => !s.err);
  for (const s of sigs) {
    const tx = (await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }])) as { transaction?: { message?: { instructions?: { programId?: string; accounts?: unknown }[] } } } | null;
    const candidates = new Set<string>();
    for (const ix of tx?.transaction?.message?.instructions ?? []) {
      if (ix.programId === METEORA_DAMM_V2_PROGRAM && Array.isArray(ix.accounts)) for (const a of ix.accounts) if (typeof a === 'string') candidates.add(a);
    }
    if (candidates.size === 0) continue;
    const list = [...candidates];
    const accs = await accountsOf(rpc, list);
    for (const [i, acc] of accs.entries()) {
      if (!acc || acc.owner !== METEORA_DAMM_V2_PROGRAM) continue;
      const pool = parseDammPool(web3, fromBase64(acc.data[0]));
      if (!pool) continue;
      const mints = [pool.tokenAMint, pool.tokenBMint];
      if (mints.includes(mint) && mints.includes(WSOL)) {
        poolOf.set(mint, list[i]!);
        return list[i]!;
      }
    }
  }
  return null;
}

/** Reads one pool: price in SOL and dollars, the value of what the pool holds, and the token's full-supply value. */
async function readPool(rpc: Rpc, web3: typeof Web3, mint: string, pool: string, solUsd: number | null): Promise<MarketInfo | null> {
  const [poolAcc] = await accountsOf(rpc, [pool]);
  if (!poolAcc || poolAcc.owner !== METEORA_DAMM_V2_PROGRAM) return null;
  const s = parseDammPool(web3, fromBase64(poolAcc.data[0]));
  if (!s) return null;
  const tokenIsA = s.tokenAMint === mint;
  if (!((tokenIsA && s.tokenBMint === WSOL) || (!tokenIsA && s.tokenBMint === mint && s.tokenAMint === WSOL))) return null;
  const [vaultA, vaultB, mintA, mintB] = await accountsOf(rpc, [s.tokenAVault, s.tokenBVault, s.tokenAMint, s.tokenBMint]);
  if (!vaultA || !vaultB || !mintA || !mintB) return null;
  const amountA = u64(fromBase64(vaultA.data[0]), 64);
  const amountB = u64(fromBase64(vaultB.data[0]), 64);
  const mintAData = fromBase64(mintA.data[0]);
  const mintBData = fromBase64(mintB.data[0]);
  const decA = mintAData[44]!;
  const decB = mintBData[44]!;
  // sqrtPrice is Q64.64; its square is raw token B per raw token A.
  const ratio = (Number(s.sqrtPrice) / 2 ** 64) ** 2;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const decToken = tokenIsA ? decA : decB;
  const priceSol = tokenIsA ? ratio * 10 ** (decA - decB) : (1 / ratio) * 10 ** (decB - decA);
  const tokenAmount = Number(tokenIsA ? amountA : amountB) / 10 ** decToken;
  const solAmount = Number(tokenIsA ? amountB : amountA) / 10 ** 9;
  const supply = Number(u64(tokenIsA ? mintAData : mintBData, 36)) / 10 ** decToken;
  const priceUsd = solUsd === null ? null : priceSol * solUsd;
  const held = priceUsd === null || solUsd === null ? null : tokenAmount * priceUsd + solAmount * solUsd;
  return {
    priceUsd: priceUsd !== null && priceUsd > 0 ? priceUsd : null,
    change24h: null,
    volume24hUsd: null,
    liquidityUsd: held,
    capUsd: priceUsd === null ? null : supply * priceUsd,
    capKind: priceUsd === null ? null : 'fdv',
    pool: { dex: 'meteora-damm-v2', address: pool, url: `https://solscan.io/account/${pool}`, quoteSymbol: 'SOL', quoteMajor: true },
  };
}

/** Market numbers read from the chain for the mints that have a DAMM v2 pool against SOL. A mint that cannot be read is left out. */
export async function dammMarkets(deps: { rpc: Rpc; web3: typeof Web3; solUsd: () => Promise<number | null> }, mints: readonly string[]): Promise<Map<string, MarketInfo>> {
  const out = new Map<string, MarketInfo>();
  if (mints.length === 0) return out;
  const solUsd = await deps.solUsd().catch(() => null);
  for (const mint of mints.slice(0, 30)) {
    try {
      const pool = await findPool(deps.rpc, deps.web3, mint);
      if (!pool) continue;
      const info = await readPool(deps.rpc, deps.web3, mint, pool, solUsd);
      if (info) out.set(mint, info);
    } catch {
      // This token's pool could not be read now; the row says there is no market yet.
    }
  }
  return out;
}

/** SOL's price in dollars, from the deepest SOL pair DexScreener lists. */
export async function solanaUsd(fetchImpl: typeof fetch): Promise<number | null> {
  const res = await fetchImpl(`https://api.dexscreener.com/tokens/v1/solana/${WSOL}`, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  const pairs = (await res.json()) as { priceUsd?: string; baseToken?: { address?: string }; liquidity?: { usd?: number } }[];
  if (!Array.isArray(pairs)) return null;
  const best = pairs.filter((p) => p.baseToken?.address === WSOL && Number.isFinite(Number(p.priceUsd))).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const price = best ? Number(best.priceUsd) : NaN;
  return Number.isFinite(price) && price > 0 ? price : null;
}
