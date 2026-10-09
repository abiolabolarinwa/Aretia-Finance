/**
 * Aretia's own way of finding the pools of a Solana token, read from the chain instead of asked of DexScreener.
 *
 * Raydium AMM v4, Raydium CLMM and Meteora's bonding curve (DBC) each keep one account per pool, and that account holds
 * the token's address at a fixed place. Asking an RPC for "accounts of this program with this mint at that place"
 * returns the pools. Every address found is still checked by the venue's own adapter before it is used, exactly like
 * an address that came from anywhere else, so a wrong or hostile answer cannot route a swap.
 *
 * It needs an RPC that allows getProgramAccounts, so it runs on the server (the browser's proxy does not allow it), and
 * the very busy tokens (SOL and the main stablecoins) are skipped: they sit in thousands of pools, and the pool of a
 * pair is found from the pair's other token.
 */
import { AMM_V4_PROGRAM } from './raydiumAmmV4.js';
import { CLMM_PROGRAM } from './raydiumClmm.js';
import { DBC_PROGRAM } from './meteoraDbc.js';

export type ScanRpc = <T>(method: string, params: unknown[]) => Promise<T>;

const DISC_CLMM_POOL = Uint8Array.from([247, 237, 227, 245, 215, 195, 222, 70]);
const DISC_DBC_POOL = Uint8Array.from([213, 224, 5, 209, 98, 69, 119, 92]);
const AMM_V4_SIZE = 752;
const MAX_PER_VENUE = 8;

/** Tokens that sit in too many pools to list. */
export const SKIPPED_MINTS: ReadonlySet<string> = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));

interface Query {
  program: string;
  filters: unknown[];
}

/** The account queries that can find pools holding this mint. Pure. */
export function scanQueries(mint: string): Query[] {
  const at = (offset: number): unknown => ({ memcmp: { offset, bytes: mint } });
  const disc = (d: Uint8Array): unknown => ({ memcmp: { offset: 0, bytes: b64(d), encoding: 'base64' } });
  return [
    { program: AMM_V4_PROGRAM, filters: [{ dataSize: AMM_V4_SIZE }, at(400)] },
    { program: AMM_V4_PROGRAM, filters: [{ dataSize: AMM_V4_SIZE }, at(432)] },
    { program: CLMM_PROGRAM, filters: [disc(DISC_CLMM_POOL), at(73)] },
    { program: CLMM_PROGRAM, filters: [disc(DISC_CLMM_POOL), at(105)] },
    { program: DBC_PROGRAM, filters: [disc(DISC_DBC_POOL), at(136)] },
  ];
}

/** Candidate pool addresses holding `mint`, at most a few per venue. A failing query gives nothing, not an error. */
export async function scanPools(rpc: ScanRpc, mint: string): Promise<string[]> {
  if (SKIPPED_MINTS.has(mint) || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return [];
  const found = await Promise.all(
    scanQueries(mint).map(async (q) => {
      try {
        const rows = await rpc<{ pubkey?: string }[]>('getProgramAccounts', [q.program, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, filters: q.filters }]);
        return Array.isArray(rows) ? rows.map((r) => r.pubkey).filter((p): p is string => typeof p === 'string').slice(0, MAX_PER_VENUE) : [];
      } catch {
        return [];
      }
    }),
  );
  return [...new Set(found.flat())];
}
