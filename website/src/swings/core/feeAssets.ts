/**
 * The major assets of each chain: a network's own coin (SOL, ETH, BNB, POL, AVAX), that coin wrapped, and the main stablecoins.
 *
 * This list no longer decides who pays the Aretia fee: since 2026-10-13 every swap pays it, a sale included (see `core/fee.ts`).
 * It stays because Shield uses it to recognise major assets. The earlier rule (fee only on these assets) existed so the fee wallet
 * never received tokens nobody can sell, and so a sale had no extra transfer that a token's own rules could block; that protection
 * is gone. The EVM list is not typed in a second time: it is the same wrapped-native and stablecoin list the router already hops
 * through (`dex/hubs.ts`), whose addresses the live tests read back from each chain.
 */
import { KNOWN_TOKENS } from './solanaTools.js';
import { HUB_TOKENS } from '../dex/hubs.js';
import { EVM_NATIVE_ADDRESS, type ChainId } from './types.js';

const SOLANA_FEE_SYMBOLS = ['SOL', 'USDC', 'USDT'];

const sets = new Map<ChainId, Set<string>>();

function feeAssetsOf(chain: ChainId): Set<string> {
  let s = sets.get(chain);
  if (s) return s;
  s = new Set<string>();
  if (chain === 'solana') {
    for (const k of KNOWN_TOKENS) if (SOLANA_FEE_SYMBOLS.includes(k.symbol)) s.add(k.mint.toLowerCase());
  } else {
    s.add(EVM_NATIVE_ADDRESS);
    for (const h of HUB_TOKENS[chain] ?? []) s.add(h.address.toLowerCase());
  }
  sets.set(chain, s);
  return s;
}

/** Whether this is one of the chain's major assets (coin, wrapped coin or main stablecoin). */
export const isFeeAsset = (chain: ChainId, address: string): boolean => feeAssetsOf(chain).has(address.toLowerCase());
