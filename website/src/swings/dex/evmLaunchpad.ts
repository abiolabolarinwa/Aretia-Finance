/**
 * One face for every bonding-curve launchpad on an EVM chain, so the router can compare and build swaps without knowing
 * which launchpad is underneath. Each launchpad supplies a quoter and a transaction builder; adding one means adding
 * an entry in the registry and a case here, nothing in the routing code.
 */
import type { EvmRead } from '../chains/evmSession.js';
import { SwingsError } from '../core/types.js';
import type { DexEntry } from '../engine/registry.js';
import type { EvmTxPlan } from '../execution/evmV2Builder.js';
import { EvmFlapAdapter, buildFlapSwap } from './evmFlap.js';
import { EvmFourMemeAdapter, buildFourMemeSwap } from './evmFourMeme.js';

export interface LaunchpadAdapter {
  bestRoute(tokenIn: string, tokenOut: string, amountIn: bigint, block?: bigint): Promise<{ token: string; buying: boolean; amountOut: bigint } | null>;
  quoteBuy(token: string, bnbIn: bigint, block?: bigint): Promise<{ amountOut: bigint } | null>;
  quoteSell(token: string, amount: bigint, block?: bigint): Promise<{ amountOut: bigint } | null>;
}

export function launchpadAdapter(entry: DexEntry, read: EvmRead): LaunchpadAdapter {
  if (entry.protocol === 'fourmeme') return new EvmFourMemeAdapter(entry, read);
  if (entry.protocol === 'flap') return new EvmFlapAdapter(entry, read);
  throw new SwingsError('invalid', `${entry.id} is not a launchpad Aretia knows how to read.`);
}

export function buildLaunchpadSwap(entry: DexEntry, p: { token: string; buying: boolean; amountIn: bigint; minOut: bigint }): EvmTxPlan {
  if (entry.protocol === 'fourmeme') return buildFourMemeSwap(entry, p);
  if (entry.protocol === 'flap') return buildFlapSwap(entry, p);
  throw new SwingsError('invalid', `${entry.id} is not a launchpad Aretia knows how to build for.`);
}
