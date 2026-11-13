/**
 * The facts a network's page states, read from the code that actually runs (the chain list and the DEX adapters), so the page cannot
 * list a venue the indexer does not support or miss one it does. No claim about depth or speed is made here: those are said in the
 * guide "How Aretia Markets works", with their limits.
 */
import { CHAINS, type ChainId } from '../swings/core/types.js';
import { allSpecs, SOLANA_SPECS } from '../swings/mi/dexes.js';

export interface ChainFacts {
  id: ChainId;
  name: string;
  nativeSymbol: string;
  /** The chain's own number for EVM networks (1 for Ethereum), null for Solana. */
  evmChainId: number | null;
  /** The distinct names of the venues the indexer reads on this network, in a stable order. */
  venues: string[];
}

export function chainFacts(id: ChainId): ChainFacts {
  const c = CHAINS[id];
  const names = id === 'solana' ? SOLANA_SPECS.map((s) => s.name) : allSpecs().filter((s) => s.chain === id).map((s) => s.name);
  // "Uniswap V2" and "Uniswap V3" are different adapters but one list reads better with each name once.
  const venues = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  return { id, name: c.name, nativeSymbol: c.nativeSymbol, evmChainId: c.evmChainId, venues };
}
