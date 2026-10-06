/**
 * Cross-chain interfaces. INTERFACES ONLY: nothing here can move funds, and no bridge is registered.
 *
 * The future flow is: source chain -> bridge/cross-chain provider -> destination chain -> destination DEX.
 * Providers (Wormhole NTT for ACT, aggregators, intent solvers) will implement CrossChainProvider and
 * plug into a CrossChainRouter without the same-chain router or the UI changing. Wormhole NTT is
 * testnet-only today, so cross-chain execution stays off until its path has had its own review.
 */
import { CHAINS, SwingsError, type ChainId, type PreparedSwap, type SimulationReport, type SwapRequest, type TokenRef } from '../core/types.js';

export type SwapKind = 'same-chain' | 'cross-chain';

/** What the UI must call a request. Same-chain is the only kind that can run today. */
export function classifySwap(from: TokenRef, to: TokenRef): SwapKind {
  return from.chain === to.chain ? 'same-chain' : 'cross-chain';
}

export interface CrossChainRequest {
  from: TokenRef;
  to: TokenRef;
  amountIn: bigint;
  slippageBps: number;
  /** The account that signs on the source chain and the address that receives on the destination chain. */
  sender: { chain: ChainId; address: string };
  recipient: { chain: ChainId; address: string };
}

/** One hop of a cross-chain journey: a swap on a chain, or a bridge between two. */
export type CrossChainStep =
  | { kind: 'swap'; chain: ChainId; request: SwapRequest }
  | { kind: 'bridge'; from: ChainId; to: ChainId; provider: string; estimatedSeconds: number | null };

export interface CrossChainQuote {
  id: string;
  providerId: string;
  request: CrossChainRequest;
  steps: CrossChainStep[];
  expectedOut: bigint;
  minOut: bigint;
  /** Fees in each chain's own terms; never merged into one number the user cannot check. */
  fees: { chain: ChainId; description: string }[];
  expiresAt: number;
  /** Risks that must be shown before signing (bridge trust, finality time, partial-failure handling). */
  risks: string[];
}

/** What a bridge or cross-chain aggregator provides. It builds transactions; it never holds keys. */
export interface CrossChainProvider {
  readonly id: string;
  readonly name: string;
  supports(from: ChainId, to: ChainId): boolean;
  getQuote(request: CrossChainRequest, signal?: AbortSignal): Promise<CrossChainQuote>;
  /** One prepared transaction per signing step on the source chain. */
  prepare(quote: CrossChainQuote): Promise<{ steps: PreparedSwap[]; simulation: SimulationReport }>;
  /** Progress of a journey that has left the source chain. */
  track(sourceTxId: string): Promise<{ status: 'pending' | 'completed' | 'failed' | 'needs-attention'; destinationTxId?: string }>;
}

/** Registers providers and, today, refuses to execute anything. */
export class CrossChainRouter {
  /** Flip only after a reviewed bridge path exists. Intentionally not configurable at runtime. */
  static readonly EXECUTION_ENABLED = false;
  private readonly providers: CrossChainProvider[] = [];

  register(p: CrossChainProvider): void {
    this.providers.push(p);
  }

  providersFor(from: ChainId, to: ChainId): string[] {
    return this.providers.filter((p) => p.supports(from, to)).map((p) => p.id);
  }

  async getQuote(request: CrossChainRequest): Promise<CrossChainQuote> {
    if (!CrossChainRouter.EXECUTION_ENABLED) {
      throw new SwingsError('not-enabled', `Swapping from ${CHAINS[request.from.chain].name} to ${CHAINS[request.to.chain].name} is not available yet. Cross-chain swaps need a reviewed bridge path first.`);
    }
    throw new SwingsError('no-route', 'No cross-chain provider is registered.');
  }
}
