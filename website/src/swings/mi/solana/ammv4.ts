/**
 * Raydium AMM v4 pool creation. The program (675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8) is not an Anchor program: `initialize2` is
 * instruction number 1, 26 bytes of data, 21 accounts. Pool creation pays a fee to one account (the "create pool fee destination"
 * that Raydium's own SDK names), so that account's signatures are exactly the creations: checked on mainnet, every successful
 * transaction in its recent list held one `initialize2` (8 of 8). Accounts: 4 amm (the pool), 8 coin mint, 9 pc mint, 10 coin vault,
 * 11 pc vault, 14 the fee destination (compared against the anchor, so an unrelated instruction cannot pass).
 */
import { decodeBase58, isSolanaAddress } from './accounts.js';
import type { CreatedPool } from '../../indexer/solanaIndexer.js';

export const AMM_V4_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
export const AMM_V4_CREATE_FEE_DESTINATION = '7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5';

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

export function decodeInitialize2(ix: Ix, blockTime: number, signature: string): CreatedPool | null {
  if (ix.programId !== AMM_V4_PROGRAM || !Array.isArray(ix.accounts) || typeof ix.data !== 'string' || ix.accounts.length < 21) return null;
  const data = decodeBase58(ix.data);
  if (!data || data.length !== 26 || data[0] !== 1) return null;
  const a = ix.accounts;
  if (a[14] !== AMM_V4_CREATE_FEE_DESTINATION || ![a[4], a[8], a[9], a[10], a[11]].every(isSolanaAddress)) return null;
  return { venue: 'Raydium AMM v4' as unknown as CreatedPool['venue'], pool: a[4]!, mintA: a[8]!, mintB: a[9]!, vaultA: a[10]!, vaultB: a[11]!, blockTime, signature };
}

export function ammV4PoolsCreatedIn(tx: Tx | null, signature: string): CreatedPool[] {
  if (!tx || (tx.meta?.err !== null && tx.meta?.err !== undefined) || typeof tx.blockTime !== 'number') return [];
  const all: Ix[] = [...(tx.transaction?.message?.instructions ?? []), ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions ?? [])];
  const seen = new Set<string>();
  const out: CreatedPool[] = [];
  for (const ix of all) {
    const p = decodeInitialize2(ix, tx.blockTime, signature);
    if (p && !seen.has(p.pool)) {
      seen.add(p.pool);
      out.push(p);
    }
  }
  return out;
}
