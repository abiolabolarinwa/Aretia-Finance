/**
 * Adding pools that already exist to the index, many at a time, from the chain.
 *
 * `trackSolanaPool` adds one pool on request and then reads its swaps (up to 120 transactions): right for one pool someone asked about, far
 * too heavy for thousands. This reads the pool accounts a hundred at a time (one `getMultipleAccounts`), checks each one's owner program
 * is a venue Aretia indexes, parses it with that venue's layout, and registers it with its reserves. Its swings are then followed by the
 * adapter's ordinary runs (the balance gate keeps that cheap), exactly as for a pool heard being created. Nothing here trusts the list the
 * address came from: an account that is missing, owned by another program, or the wrong size is skipped.
 */
import type { CreatedPool } from '../../indexer/solanaIndexer.js';
import type { RunReport } from '../engine.js';
import { SOLANA_SPECS } from '../dexes.js';
import { poolKeyOf } from '../types.js';
import { isSolanaAddress } from './accounts.js';
import { VENUE_LAYOUTS } from './discovery.js';
import { registerPool, type SolDeps, type TokenFacts } from './engine.js';
import { accountsWithOwner } from './listener.js';
import { PROGRAMS } from './track.js';

export interface KnownOutcome {
  registered: number;
  /** Already in the index. */
  known: number;
  /** Not a pool of a venue Aretia indexes, or an account of the wrong size or layout. */
  skipped: number;
  /** The account does not exist. */
  missing: number;
}

export type KnownDeps = Omit<SolDeps, 'spec'>;

/** Which of the addresses are already pools of the index (looked up in batches of a hundred). */
export async function knownAmong(store: KnownDeps['store'], addresses: readonly string[]): Promise<Set<string>> {
  const known = new Set<string>();
  for (let i = 0; i < addresses.length; i += 100) {
    const slice = addresses.slice(i, i + 100);
    const keys = slice.map((a) => poolKeyOf('solana', a));
    const got = await store.getPools(keys);
    slice.forEach((a, k) => {
      if (got.has(keys[k]!)) known.add(a);
    });
  }
  return known;
}

export async function registerKnownPools(d: KnownDeps, addresses: readonly string[], cache: Map<string, TokenFacts | null>, report: RunReport): Promise<KnownOutcome> {
  const out: KnownOutcome = { registered: 0, known: 0, skipped: 0, missing: 0 };
  const wanted = [...new Set(addresses)].filter(isSolanaAddress);
  out.skipped += new Set(addresses).size - wanted.length;
  const known = await knownAmong(d.store, wanted);
  out.known = known.size;
  const todo = wanted.filter((a) => !known.has(a));
  const accounts = await accountsWithOwner(d.rpc, todo);
  for (const address of todo) {
    const acct = accounts.get(address);
    if (!acct) {
      out.missing++;
      continue;
    }
    const program = PROGRAMS[acct.owner];
    const spec = program ? SOLANA_SPECS.find((s) => s.id === program.id) : undefined;
    const layout = spec ? VENUE_LAYOUTS[spec.id] : undefined;
    if (!program || !spec || (layout && acct.data.length !== layout.dataSize)) {
      out.skipped++;
      continue;
    }
    const parsed = await program.parse(acct.data, d.rpc);
    if (!parsed || ![parsed.mintA, parsed.mintB, parsed.vaultA, parsed.vaultB].every(isSolanaAddress) || parsed.mintA === parsed.mintB) {
      out.skipped++;
      continue;
    }
    // No creation transaction is known for a pool made before the index was watching: its age is left unknown (shown as a dash), not guessed.
    const created: CreatedPool = { venue: program.venue, pool: address, ...parsed, blockTime: 0, signature: 'tracked' };
    await registerPool({ ...d, spec }, created, 0, cache, report);
    out.registered++;
  }
  return out;
}
