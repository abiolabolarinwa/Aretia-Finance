/**
 * Aretia's economics live here and only here: no provider, adapter or screen may carry its own rate.
 *
 * Policy: Aretia charges 0.58% of the amount the user pays, on every listed network, when the swap is PAID with a network's own
 * coin (SOL, ETH, BNB, POL, AVAX), that coin wrapped, or a main stablecoin (USDC, USDT, ...): see `core/feeAssets.ts`. Paying with
 * any other token (selling it) carries no fee. So the fee always arrives in an asset that is easy to sell, and swapping between two
 * of those assets (USDC to SOL, say) pays it too. It is taken out of the amount the user enters, so what the user spends is exactly
 * what they typed: the fee, plus the rest, which is what is swapped. The only other Aretia charge is the Move USDC fee below
 * (`MOVE_FEE_BPS`, 0.1% of every Circle CCTP move, taken in USDC on the source chain); the old ACT buyback has been removed.
 *
 * `DEFAULT_FEE_CONFIG` is the neutral baseline (off) that tests and any code without an explicit choice get.
 * `liveFeeConfig` is what the product runs: on for every network, for swaps paid with those assets. Solana's fee goes to the owner's existing fee wallet. An
 * EVM network's fee goes to the one EVM fee address the owner supplies at build time (`PUBLIC_ARETIA_EVM_FEE_ADDRESS`); until
 * it is supplied, EVM swaps are blocked with a plain message instead of quietly skipping the fee. Missing configuration
 * blocks execution; nothing falls back to another address.
 */
import { SWAP_FEE_WALLET } from '../../scripts/walletTools.js';
import { isFeeAsset } from './feeAssets.js';
import { CHAIN_IDS, type AretiaChainFeeConfig, type AretiaFeeConfig, type AretiaFeePolicy, type ChainId } from './types.js';

/** The rate: 58 basis points, 0.58%. */
export const ARETIA_FEE_BPS = 58;
/** The rate as it is written on screen and in messages, always read from the one number above. */
export const FEE_PERCENT = `${(ARETIA_FEE_BPS / 100).toFixed(2)}%`;
/** Hard ceiling on the rate (1%). A config above it is rejected, not clamped. */
export const MAX_FEE_BPS = 100;

/**
 * Aretia's fee on every "Move USDC" move (Circle CCTP), on every route (fast and standard) and from every source chain (EVM and
 * Solana): 10 basis points, 0.1%, of the amount the user enters. It is taken OUT of that amount, in USDC on the source chain, so
 * what leaves the wallet is exactly what was typed: the fee, plus the rest, which is what is burned (and Circle's own fee, if any, is
 * then taken from the burn). The fee is always worked out again from this one number, never read back from a saved quote. Raised or
 * lowered only by a reviewed change here.
 */
export const MOVE_FEE_BPS = 10;
/** The Move USDC rate as it is written on screen, read from the one number above. */
export const MOVE_FEE_PERCENT = `${MOVE_FEE_BPS / 100}%`;

/**
 * The Move USDC fee for `entered` raw USDC units (6 decimals): ceil(entered * MOVE_FEE_BPS / 10,000). Rounded UP, so any amount
 * above zero pays at least one raw unit (0.000001 USDC) and the fee never rounds down to nothing. Zero or less pays nothing (such an
 * amount is refused anyway).
 */
export function moveFeeFor(entered: bigint): bigint {
  if (entered <= 0n) return 0n;
  return (entered * BigInt(MOVE_FEE_BPS) + 9_999n) / 10_000n;
}

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
 * What the product runs: the fee on every network, on swaps paid with a coin or stablecoin. Solana pays the owner's existing fee wallet. Every EVM network
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

export type FeePlan =
  /** `offBecause`: 'policy' when the fee is switched off, 'token' when the swap is paid with a token that carries no fee (a sale). */
  | { state: 'off'; fee: 0n; net: bigint; treasury: null; reasons: []; offBecause: 'policy' | 'token' }
  | { state: 'blocked'; fee: 0n; net: bigint; treasury: null; reasons: string[] }
  | { state: 'ready'; fee: bigint; net: bigint; treasury: string; reasons: [] };

/**
 * The Aretia fee for a swap of `amountIn` raw units of `payAsset` (the token address the user pays with) on `chain`: the fee
 * (rounded down) and what is left to swap. The two always add up to exactly what the user entered. `payAsset` is required so no
 * caller can forget to say what is being paid with.
 *
 * - policy or chain switched off  -> 'off', no fee, everything is swapped
 * - paying with a token that carries no fee (selling it) -> 'off', no fee, everything is swapped
 * - enabled but no address        -> 'blocked' with reasons; execution must not proceed
 */
export function planAretiaFee(amountIn: bigint, chain: ChainId, config: AretiaFeeConfig, payAsset: string): FeePlan {
  validateFeeConfig(config);
  const c: AretiaChainFeeConfig = config.chains[chain];
  if (!config.policy.enabled || !c.enabled) return { state: 'off', fee: 0n, net: amountIn, treasury: null, reasons: [], offBecause: 'policy' };
  if (!isFeeAsset(chain, payAsset)) return { state: 'off', fee: 0n, net: amountIn, treasury: null, reasons: [], offBecause: 'token' };
  const reasons: string[] = [];
  if (!c.treasuryAddress) reasons.push(`The Aretia fee address for ${chain} is not set up yet, so swaps on this network are paused.`);
  if (amountIn <= 0n) reasons.push('The swap amount must be above zero.');
  if (reasons.length > 0) return { state: 'blocked', fee: 0n, net: amountIn, treasury: null, reasons };
  const fee = (amountIn * BigInt(config.policy.rateBps)) / 10_000n;
  return { state: 'ready', fee, net: amountIn - fee, treasury: c.treasuryAddress!, reasons: [] };
}
