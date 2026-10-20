/**
 * GET /api/swings-pools?mint=: candidate Raydium AMM v4, Raydium CLMM and Meteora bonding-curve pools of a Solana token,
 * read from the chain by Aretia (see src/swings/solana/poolScan.ts). The answer is only a list of addresses to check:
 * the swap code verifies each one on-chain before using it. Answers are kept for ten minutes per token.
 *
 * Each scan costs several paid program-wide queries, so: the mint must first be shown to exist as an SPL Token or Token-2022 mint
 * (one cheap getAccountInfo), scans share a global budget of SCANS_PER_MINUTE per instance on top of the per-IP limit, and the
 * answer never carries the provider's own error text.
 */
import { isOriginAllowed, overLimit } from './_rpcProxy.js';
import { scanPoolsDetailed, SKIPPED_MINTS, type ScanRpc } from '../src/swings/solana/poolScan.js';
import { overBudget } from './_limits.js';
import type { TokensInput, TokensOutput } from './_swingsTokens.js';

const KEEP_MS = 10 * 60_000;
const cache = new Map<string, { at: number; pools: string[] }>();
// The public endpoint that allows getProgramAccounts; the key-holding provider is used when SOLANA_RPC_URL is set.
const SCAN_FALLBACK_RPC = 'https://api.mainnet-beta.solana.com';
/** New (uncached) scans allowed per minute on one instance, whoever asks. */
export const SCANS_PER_MINUTE = 30;
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
/** Mints for which getAccountInfo said there is no such mint, kept like answers so a made-up address costs one read per ten minutes. */
const missing = new Map<string, number>();

const json = (status: number, data: unknown, headers: Record<string, string>): TokensOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });

export function resetPoolCache(): void {
  cache.clear();
  missing.clear();
}

export async function handlePools(input: TokensInput): Promise<TokensOutput> {
  const headers: Record<string, string> = { vary: 'origin', 'cache-control': 'no-store' };
  const allowed = isOriginAllowed(input.origin, input.env);
  if (allowed) {
    headers['access-control-allow-origin'] = input.origin!;
    headers['access-control-allow-methods'] = 'GET, OPTIONS';
  }
  if (input.method === 'OPTIONS') return { status: allowed ? 204 : 403, body: '', headers };
  if (input.method !== 'GET') return json(405, { error: 'method' }, { ...headers, allow: 'GET, OPTIONS' });
  if (!allowed) return json(403, { error: 'origin' }, headers);
  const mint = input.query.mint ?? '';
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return json(400, { error: 'bad-request' }, headers);
  const hit = cache.get(mint);
  if (hit && input.now - hit.at < KEEP_MS) return json(200, { pools: hit.pools, cached: true }, headers);
  if (overLimit(`pools:${input.ip}`, input.now)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '60' });
  const rpcFor = (url: string): ScanRpc => async <T>(method: string, params: unknown[]): Promise<T> => {
    const res = await input.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!res.ok) throw new Error(`RPC answered ${res.status}`);
    const out = (await res.json()) as { result?: T; error?: { message?: string } };
    if (out.result === undefined) throw new Error(`RPC error: ${out.error?.message ?? 'no result'}`);
    return out.result;
  };
  if (SKIPPED_MINTS.has(mint)) return json(200, { pools: [] }, headers);
  const miss = missing.get(mint);
  if (miss !== undefined && input.now - miss < KEEP_MS) return json(200, { pools: [], cached: true }, headers);
  const keyed = input.env.SOLANA_RPC_URL?.trim();
  // A real mint first: an account owned by the SPL Token or Token-2022 program, at least the 82 bytes of a mint.
  try {
    const info = await rpcFor(keyed || SCAN_FALLBACK_RPC)<{ value: { owner?: string; data?: [string, string] | unknown; space?: number } | null }>('getAccountInfo', [mint, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }]);
    const v = info?.value;
    if (!v || !TOKEN_PROGRAMS.has(v.owner ?? '') || (typeof v.space === 'number' && v.space < 82)) {
      if (missing.size > 5000) missing.clear();
      missing.set(mint, input.now);
      return json(200, { pools: [] }, headers);
    }
  } catch {
    return json(200, { pools: [], failed: 1, reason: 'The token could not be checked right now.' }, headers);
  }
  if (overBudget('pools-scan:global', input.now, SCANS_PER_MINUTE)) return json(429, { error: 'busy' }, { ...headers, 'retry-after': '30' });
  let scan = await scanPoolsDetailed(rpcFor(keyed || SCAN_FALLBACK_RPC), mint);
  let usedFallback = false;
  // The paid provider may refuse some program-wide queries on its plan (it still answers the others), so whatever it failed
  // is asked again of the public endpoint and the two answers are joined.
  if (keyed && scan.failed > 0) {
    const more = await scanPoolsDetailed(rpcFor(SCAN_FALLBACK_RPC), mint);
    scan = { pools: [...new Set([...scan.pools, ...more.pools])], failed: more.failed, reason: more.reason };
    usedFallback = true;
  }
  // An empty answer is only kept when every question was answered (a real "none"); a failed one is retried next time.
  if (scan.failed === 0 || scan.pools.length > 0) {
    if (cache.size > 2000) cache.clear();
    cache.set(mint, { at: input.now, pools: scan.pools });
  }
  // The provider's own error text stays on the server: only a count and a plain sentence are returned.
  return json(200, { pools: scan.pools, ...(scan.failed > 0 ? { failed: scan.failed, reason: 'Some pool lists could not be read; try again later.' } : {}), ...(usedFallback ? { fallback: true } : {}) }, headers);
}

