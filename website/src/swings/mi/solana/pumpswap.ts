/**
 * PumpSwap (program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA) pool creation, decoded exactly from the program's published IDL
 * (github.com/pump-fun/pump-public-docs, idl/pump_amm.json): `create_pool` has discriminator [233,146,209,142,207,104,64,188] and
 * accounts 0 pool, 3 base_mint, 4 quote_mint, 9 pool_base_token_account, 10 pool_quote_token_account. The instruction's argument
 * list holds optional fields, so its length is not fixed; the discriminator, the program and the account count are what is checked.
 *
 * Finding these pools: pump.fun graduations create their PumpSwap pool through the migration authority below, so that account's
 * signatures list them. That account is NOT named in Pump's documentation: it was found by reading the account's real transactions
 * on mainnet (4 of the 6 successful ones created a PumpSwap pool). It therefore covers pools created by graduation, not a pool
 * someone creates directly with `create_pool`. That limit is stated wherever PumpSwap is listed.
 */
import { decodeBase58 } from './accounts.js';
import { isSolanaAddress } from './accounts.js';
import type { CreatedPool } from '../../indexer/solanaIndexer.js';

export const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const PUMP_MIGRATION_AUTHORITY = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';
const CREATE_POOL = Uint8Array.of(233, 146, 209, 142, 207, 104, 64, 188);

interface Ix {
  programId?: string;
  accounts?: string[];
  data?: string;
}
interface Tx {
  blockTime?: number | null;
  meta?: { err?: unknown; innerInstructions?: { instructions?: Ix[] }[] } | null;
  transaction?: { message?: { instructions?: Ix[] } };
}

export function decodeCreatePool(ix: Ix, blockTime: number, signature: string): CreatedPool | null {
  if (ix.programId !== PUMPSWAP_PROGRAM || !Array.isArray(ix.accounts) || typeof ix.data !== 'string' || ix.accounts.length < 11) return null;
  const data = decodeBase58(ix.data);
  if (!data || data.length < 8 || !CREATE_POOL.every((b, i) => data[i] === b)) return null;
  const a = ix.accounts;
  if (![a[0], a[3], a[4], a[9], a[10]].every(isSolanaAddress)) return null;
  return { venue: 'PumpSwap' as unknown as CreatedPool['venue'], pool: a[0]!, mintA: a[3]!, mintB: a[4]!, vaultA: a[9]!, vaultB: a[10]!, blockTime, signature };
}

/** Every PumpSwap pool a successful transaction created, top-level or called by another program (the pump.fun migration calls it). */
export function pumpswapPoolsCreatedIn(tx: Tx | null, signature: string): CreatedPool[] {
  if (!tx || (tx.meta?.err !== null && tx.meta?.err !== undefined) || typeof tx.blockTime !== 'number') return [];
  const all: Ix[] = [...(tx.transaction?.message?.instructions ?? []), ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions ?? [])];
  const seen = new Set<string>();
  const out: CreatedPool[] = [];
  for (const ix of all) {
    const p = decodeCreatePool(ix, tx.blockTime, signature);
    if (p && !seen.has(p.pool)) {
      seen.add(p.pool);
      out.push(p);
    }
  }
  return out;
}
