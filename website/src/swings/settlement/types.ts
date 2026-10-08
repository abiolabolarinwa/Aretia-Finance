/**
 * The settlement domain: how value moves from one chain to another. It answers one question, and nothing else:
 *
 *   "How can this much of this asset, on this chain, become that asset, on that chain, in that account?"
 *
 * Settlement is deliberately separate from routing (which DEX) and from ramps (fiat). A settlement provider moves value
 * between chains; it does not choose a DEX and it does not touch fiat. Providers are interchangeable behind
 * `SettlementProvider`: native stablecoin burn-and-mint (Circle's CCTP), a bridge, a liquidity network, a messaging
 * protocol. Swings is not built around any one of them.
 *
 * Rules every provider must keep (the engine and the tests enforce them):
 *  - report a route only if it can really be executed, now; "unsupported" is an answer with a reason, never a guess;
 *  - quote what the user will actually receive, with every cost shown separately and none hidden;
 *  - never claim completion on the source transaction alone: completion is the destination receiving the value.
 */
import type { ChainId } from '../core/types.js';
import type { AssetId, UnsignedTransaction } from '../wallet/types.js';

export interface SettlementIntent {
  sourceChain: ChainId;
  sourceAsset: AssetId;
  /** Raw units of the source asset. */
  sourceAmount: bigint;
  destinationChain: ChainId;
  destinationAsset: AssetId;
  /** Who signs on the source chain. */
  sender: string;
  /** Who receives on the destination chain. */
  recipient: string;
}

/** One thing that happens, in order. Some need the user's signature; some are waiting. */
export interface SettlementStep {
  id: string;
  kind: 'approve' | 'send' | 'wait' | 'receive';
  chain: ChainId;
  description: string;
  requiresSignature: boolean;
  /** A rough duration, from the provider's own published figures. Null when unknown. */
  estimatedSeconds: number | null;
}

export interface SettlementRoute {
  providerId: string;
  /** Human-readable name of the mechanism: "Circle CCTP, fast transfer". */
  mechanism: string;
  /**
   * `transfer`: the same asset arrives that was sent (value is conserved, so it can never be more than was sent).
   * `convert`: a different asset arrives, so amounts in different units cannot be compared directly.
   */
  kind: 'transfer' | 'convert';
  steps: SettlementStep[];
}

export interface SettlementRisk {
  level: 'low' | 'medium' | 'high';
  /** Who has to be trusted for this to work, in plain words. */
  trust: string;
  factors: string[];
}

/** A cost, in one asset on one chain. Costs are never added across assets into a number nobody can check. */
export interface SettlementCost {
  chain: ChainId;
  asset: AssetId;
  /** Raw units. */
  amount: bigint;
  description: string;
}

export interface SettlementQuote {
  id: string;
  providerId: string;
  intent: SettlementIntent;
  route: SettlementRoute;
  sourceAmount: bigint;
  /** What arrives, at the least. Never more than was sent in the same asset. */
  destinationAmount: bigint;
  /** What the settlement itself charges (taken from the amount, or paid on top). */
  settlementFee: SettlementCost;
  /** Network fees to be paid in each chain's own coin, when the provider can estimate them. Null = not estimated. */
  networkFees: SettlementCost[] | null;
  estimatedSeconds: number;
  /** The smallest and largest amount this route accepts, from the provider itself. */
  limits: { min: bigint | null; max: bigint | null };
  expiresAt: number;
  risk: SettlementRisk;
  /** What the user must be ready for (approvals, gas on the destination chain, time). */
  requirements: string[];
  /** Whatever the provider needs to build transactions later. Opaque to everything else. */
  raw: unknown;
}

export interface SettlementTransaction {
  stepId: string;
  chain: ChainId;
  description: string;
  unsigned: UnsignedTransaction;
}

/** Where a settlement is. Narrower than the whole-execution states of milestone 34, which wrap these. */
export type SettlementStatusCode =
  | 'awaiting-source' // not yet seen on the source chain
  | 'source-confirmed' // the source transaction is final; the provider is not yet ready to release funds
  | 'ready-to-complete' // the provider has what it needs; the destination step can be built and sent
  | 'completed' // the destination received the value
  | 'failed' // it will not complete without intervention
  | 'unknown'; // the provider could not be asked

export interface SettlementStatus {
  executionId: string;
  code: SettlementStatusCode;
  /** The destination transaction, once there is one. */
  destinationTxHash: string | null;
  message: string;
  updatedAt: number;
}

export interface SupportAnswer {
  supported: boolean;
  /** When not supported, why, in plain words. Required: "no" is never silent. */
  reason: string | null;
}

export interface SettlementProvider {
  readonly id: string;
  readonly name: string;
  /** Whether this provider can execute this intent right now, and if not, why. Must not report a route it cannot execute. */
  supports(intent: SettlementIntent, signal?: AbortSignal): Promise<SupportAnswer>;
  getQuote(intent: SettlementIntent, signal?: AbortSignal): Promise<SettlementQuote>;
  /** The source-chain transactions, in order, for a quote. Nothing is signed or sent here. */
  buildSettlement(quote: SettlementQuote): Promise<SettlementTransaction[]>;
  /** The destination-chain transaction once the provider is ready to release the funds, or null if it is not ready. */
  buildDestination(quote: SettlementQuote, executionId: string): Promise<SettlementTransaction | null>;
  /** Where a settlement is, given the id the provider issues from the source transaction. */
  trackSettlement(executionId: string, quote?: SettlementQuote): Promise<SettlementStatus>;
}

/** The id a provider uses to follow a settlement: provider, source chain and source transaction. */
export const executionIdOf = (providerId: string, sourceChain: ChainId, sourceTx: string): string => `${providerId}:${sourceChain}:${sourceTx}`;

export function parseExecutionId(id: string): { providerId: string; sourceChain: string; sourceTx: string } | null {
  const m = /^([a-z0-9-]+):([a-z]+):(.+)$/.exec(id);
  return m ? { providerId: m[1]!, sourceChain: m[2]!, sourceTx: m[3]! } : null;
}
