/**
 * Aretia's economics live here and only here: no provider, adapter or screen may carry its own rate.
 *
 * Policy: 0.87% of the qualifying transaction value is used to buy ACT. There is no separate Aretia
 * transaction fee. The buyback is an execution policy, not a deduction from the quoted output.
 *
 * It ships OFF. Turning it on needs, per chain, official treasury/executor addresses from the owner
 * and a reviewed execution design (slippage, failure and circular-routing behaviour). Missing
 * configuration blocks execution; nothing falls back to another address.
 */
import { SWAP_FEE_WALLET } from '../../scripts/walletTools.js';
import { CHAIN_IDS, type AretiaBuybackPolicy, type AretiaChainFeeConfig, type AretiaFeeConfig, type ChainId } from './types.js';

/** Hard ceiling on the buyback rate (1%). A config above it is rejected, not clamped. */
export const MAX_BUYBACK_BPS = 100;

export const DEFAULT_BUYBACK_POLICY: AretiaBuybackPolicy = { enabled: false, rateBps: 87, asset: 'ACT', mode: 'BUYBACK' };

export const DEFAULT_FEE_CONFIG: AretiaFeeConfig = {
  policy: DEFAULT_BUYBACK_POLICY,
  chains: {
    // Solana references the existing management-fee wallet as treasury. No buyback executor exists yet.
    solana: { chainId: 'solana', treasuryAddress: SWAP_FEE_WALLET, enabled: false },
    // EVM addresses stay unset until the owner supplies the official ones.
    ethereum: { chainId: 'ethereum', enabled: false },
    bnb: { chainId: 'bnb', enabled: false },
    polygon: { chainId: 'polygon', enabled: false },
    base: { chainId: 'base', enabled: false },
    arbitrum: { chainId: 'arbitrum', enabled: false },
    optimism: { chainId: 'optimism', enabled: false },
    avalanche: { chainId: 'avalanche', enabled: false },
  },
};

/** Throws if the config could mislead: a rate outside 0..MAX or not a whole number of basis points. */
export function validateFeeConfig(config: AretiaFeeConfig): void {
  const { rateBps } = config.policy;
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > MAX_BUYBACK_BPS) {
    throw new Error(`Buyback rate must be a whole number of basis points between 0 and ${MAX_BUYBACK_BPS}.`);
  }
  for (const id of CHAIN_IDS) {
    if (config.chains[id]?.chainId !== id) throw new Error(`Fee config for ${id} is missing or mislabelled.`);
  }
}

export type BuybackPlan =
  | { state: 'off'; amount: 0n; reasons: [] }
  | { state: 'blocked'; amount: 0n; reasons: string[] }
  | { state: 'ready'; amount: bigint; reasons: [] };

/**
 * The buyback allocation for a swap of `amountIn` raw units on `chain`. Rounds down. The user's swap
 * amount is never reduced by this: callers show it as its own line and decide how to fund it.
 *
 * - policy or chain switched off  -> 'off', zero
 * - enabled but addresses missing -> 'blocked' with reasons; execution must not proceed
 */
export function planBuyback(amountIn: bigint, chain: ChainId, config: AretiaFeeConfig = DEFAULT_FEE_CONFIG): BuybackPlan {
  validateFeeConfig(config);
  const c: AretiaChainFeeConfig = config.chains[chain];
  if (!config.policy.enabled || !c.enabled) return { state: 'off', amount: 0n, reasons: [] };
  const reasons: string[] = [];
  if (!c.treasuryAddress) reasons.push(`No treasury address is configured for ${chain}.`);
  if (!c.buybackExecutorAddress) reasons.push(`No ACT buyback executor is configured for ${chain}.`);
  if (amountIn <= 0n) reasons.push('The swap amount must be above zero.');
  if (reasons.length > 0) return { state: 'blocked', amount: 0n, reasons };
  return { state: 'ready', amount: (amountIn * BigInt(config.policy.rateBps)) / 10_000n, reasons: [] };
}
