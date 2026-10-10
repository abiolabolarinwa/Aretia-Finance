/**
 * The assets that carry Aretia's fee. The fee is charged when a swap is PAID with one of these: a network's own coin (SOL, ETH,
 * BNB, POL, AVAX), that coin wrapped, or a main stablecoin. Paying with any other token (selling it) carries no fee.
 *
 * Why this rule: the fee always arrives in an asset that is easy to sell, so the fee wallet never fills with tokens nobody can sell,
 * and a sale (approve, then swap) has no extra transfer that a token's own rules could block. The EVM list is not typed in a second
 * time: it is the same wrapped-native and stablecoin list the router already hops through (`dex/hubs.ts`), whose addresses the live
 * tests read back from each chain.
 */
import { KNOWN_TOKENS } from '../../scripts/walletTools.js';
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

/** Whether paying with this asset carries the Aretia fee. */
export const isFeeAsset = (chain: ChainId, address: string): boolean => feeAssetsOf(chain).has(address.toLowerCase());
