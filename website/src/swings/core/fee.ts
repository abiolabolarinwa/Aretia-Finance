/**
 * Aretia's economics live here and only here: no provider, adapter or screen may carry its own rate.
 *
 * Policy: Aretia charges 0.58% of the amount the user pays, on every listed network, on every swap, whatever the user pays with:
 * a network's own coin, a wrapped coin, a stablecoin, or any other token (a sale). The fee is taken in the asset being paid with.
 * (Until 2026-10-13 a sale carried no fee, so the fee wallet only ever received coins and stablecoins; see ADR-0003. A sale now pays
 * it too, in the token being sold.) It is taken out of the amount the user enters, so what the user spends is exactly what they
 * typed: the fee, plus the rest, which is what is swapped. There is no other Aretia charge; the old ACT buyback has been removed.
 *
 * `DEFAULT_FEE_CONFIG` is the neutral baseline (off) that tests and any code without an explicit choice get.
 * `liveFeeConfig` is what the product runs: on for every network, for every swap. Solana's fee goes to the owner's existing fee wallet. An
 * EVM network's fee goes to the one EVM fee address the owner supplies at build time (`PUBLIC_ARETIA_EVM_FEE_ADDRESS`); until
 * it is supplied, EVM swaps are blocked with a plain message instead of quietly skipping the fee. Missing configuration
 * blocks execution; nothing falls back to another address.
 */
import { SWAP_FEE_WALLET } from './solanaTools.js';
import { isFeeAsset } from './feeAssets.js';
import { CHAIN_IDS, type AretiaChainFeeConfig, type AretiaFeeConfig, type AretiaFeePolicy, type ChainId } from './types.js';

/** The rate: 58 basis points, 0.58%. */
export const ARETIA_FEE_BPS = 58;
/** The rate as it is written on screen and in messages, always read from the one number above. */
export const FEE_PERCENT = `${(ARETIA_FEE_BPS / 100).toFixed(2)}%`;
/** Hard ceiling on the rate (1%). A config above it is rejected, not clamped. */
export const MAX_FEE_BPS = 100;

export const DEFAULT_FEE_POLICY: AretiaFeePolicy = { enabled: false, rateBps: ARETIA_FEE_BPS };

export const DEFAULT_FEE_CONFIG: AretiaFeeConfig = {
  policy: DEFAULT_FEE_POLICY,
  chains: {
    solana: { chainId: 'solana', treasuryAddress: SWAP_FEE_WALLET, enabled: false },
    ethereum: { chainId: 'ethereum', enabled: false },
    bnb: { chainId: 'bnb', enabled: false },
    polygon: { chainId: 'polygon', enabled: false },
    base: { chainId: 'base', enabled: false },
    arbitrum: { chainId: 'arbitrum', enabled: false },
    optimism: { chainId: 'optimism', enabled: false },
    avalanche: { chainId: 'avalanche', enabled: false },
    robinhood: { chainId: 'robinhood', enabled: false },
  },
};

const isEvmAddress = (a: string | undefined): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

/**
 * What the product runs: the fee on every network, on every swap. Solana pays the owner's existing fee wallet. Every EVM network
 * pays `evmFeeAddress` when it is a valid address; without one the EVM networks stay "on" with no address, which blocks
 * their swaps (see `planAretiaFee`) rather than letting them through without the fee.
 */
export function liveFeeConfig(evmFeeAddress?: string): AretiaFeeConfig {
  const evm = isEvmAddress(evmFeeAddress) ? evmFeeAddress.toLowerCase() : undefined;
  const chains = { ...DEFAULT_FEE_CONFIG.chains };
  for (const id of CHAIN_IDS) {
    chains[id] = id === 'solana' ? { chainId: id, treasuryAddress: SWAP_FEE_WALLET, enabled: true } : { chainId: id, ...(evm ? { treasuryAddress: evm } : {}), enabled: true };
  }
  return { policy: { enabled: true, rateBps: ARETIA_FEE_BPS }, chains };
}

/** The shipped configuration without an EVM fee address (tests and any code that has none). */
export const LIVE_FEE_CONFIG: AretiaFeeConfig = liveFeeConfig();

/** Throws if the config could mislead: a rate outside 0..MAX or not a whole number of basis points. */
export function validateFeeConfig(config: AretiaFeeConfig): void {
  const { rateBps } = config.policy;
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > MAX_FEE_BPS) {
    throw new Error(`The fee rate must be a whole number of basis points between 0 and ${MAX_FEE_BPS}.`);
  }
  for (const id of CHAIN_IDS) {
    if (config.chains[id]?.chainId !== id) throw new Error(`Fee config for ${id} is missing or mislabelled.`);
  }
}

/** Which side of a swap pays the Aretia fee: the amount entered ('input'), or what is received ('output'). */
export type FeeSide = 'input' | 'output';

/**
 * Solana only. When a token that is not SOL, USDC or USDT is sold for one of those three, the fee is taken from what is RECEIVED, in
 * that asset, after the swap and in the same transaction. The fee wallet then only ever receives SOL, USDC or USDT, whose accounts it
 * already has, instead of an arbitrary token that costs the seller account rent and can be taxed, blocked or impossible to sell.
 * Every other swap (a buy, SOL, USDC or USDT sold, or one token swapped for another) pays on the amount entered, as before. The rate
 * is the same either way; only the side differs.
 */
export function solanaFeeSide(from: string, to: string): FeeSide {
  return !isFeeAsset('solana', from) && isFeeAsset('solana', to) ? 'output' : 'input';
}

export type FeePlan =
  /** `offBecause`: the fee is switched off by policy (or for that chain). */
  | { state: 'off'; fee: 0n; net: bigint; treasury: null; reasons: []; offBecause: 'policy' }
  | { state: 'blocked'; fee: 0n; net: bigint; treasury: null; reasons: string[] }
  | { state: 'ready'; fee: bigint; net: bigint; treasury: string; reasons: [] };

/**
 * The Aretia fee for a swap of `amountIn` raw units of the asset the user pays with, on `chain`: the fee
 * (rounded down) and what is left to swap. The two always add up to exactly what the user entered. Every asset pays the same rate.
 *
 * - policy or chain switched off  -> 'off', no fee, everything is swapped
 * - enabled but no address        -> 'blocked' with reasons; execution must not proceed
 */
export function planAretiaFee(amountIn: bigint, chain: ChainId, config: AretiaFeeConfig): FeePlan {
  validateFeeConfig(config);
  const c: AretiaChainFeeConfig = config.chains[chain];
  if (!config.policy.enabled || !c.enabled) return { state: 'off', fee: 0n, net: amountIn, treasury: null, reasons: [], offBecause: 'policy' };
  const reasons: string[] = [];
  if (!c.treasuryAddress) reasons.push(`The Aretia fee address for ${chain} is not set up yet, so swaps on this network are paused.`);
  if (amountIn <= 0n) reasons.push('The swap amount must be above zero.');
  if (reasons.length > 0) return { state: 'blocked', fee: 0n, net: amountIn, treasury: null, reasons };
  const fee = (amountIn * BigInt(config.policy.rateBps)) / 10_000n;
  return { state: 'ready', fee, net: amountIn - fee, treasury: c.treasuryAddress!, reasons: [] };
}
