/**
 * Jupiter, as one DexProvider among others.
 *
 * NON-CORE: this is an aggregator integration kept for benchmarking, comparison and migration only.
 * Aretia's production routing is the engine in src/swings/engine (own pools, own maths, own transactions).
 * Nothing in engine/, dex/ or execution/ imports this file, and removing it must not break them. This file adapts the existing, working Jupiter code
 * (scripts/walletSwap.ts) to the Swings interface; it does not reimplement it. The live wiring that
 * imports walletSwap is in swings/live.ts, so this module stays testable without a browser.
 */
import { normalizeTokenRef, sameToken } from '../core/token.js';
import { SwingsError, type DexProvider, type PreparedSwap, type Quote, type SwapRequest } from '../core/types.js';

/** The slice of walletSwap.ts this provider uses. */
export interface JupiterBackend {
  fetchQuote(inMint: string, outMint: string, amountRaw: bigint, slippageBps: number, signal?: AbortSignal): Promise<JupiterQuote>;
  /** Builds and simulates the swap transaction for a quote; resolves with the plan the wallet will sign. */
  planSwap(args: { user: string; from: JupiterToken; to: JupiterToken; amountRaw: bigint; slippageBps: number; quote: JupiterQuote }): Promise<JupiterPlan>;
  /** Looks up decimals and symbol for a mint; null if it cannot be read. */
  resolveToken(mint: string): Promise<JupiterToken | null>;
}

export interface JupiterToken {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  icon: string | null;
  verified: boolean | null;
}

export interface JupiterQuote {
  inAmount: bigint;
  outAmount: bigint;
  minOut: bigint;
  slippageBps: number;
  routes: string[];
  raw?: unknown;
}

export interface JupiterPlan {
  blockers: string[];
  priorityFeeLamports: number;
  opensOutputAccount: boolean;
}

/** Jupiter quotes go stale quickly; the router refuses them after this long. */
export const JUPITER_QUOTE_TTL_MS = 20_000;

export class SolanaJupiterProvider implements DexProvider {
  readonly id = 'jupiter';
  readonly name = 'Jupiter';

  constructor(
    private readonly backend: JupiterBackend,
    private readonly now: () => number = Date.now,
  ) {}

  supports(chain: SwapRequest['chain']): boolean {
    return chain === 'solana';
  }

  async getQuote(request: SwapRequest, signal?: AbortSignal): Promise<Quote> {
    if (request.chain !== 'solana' || request.from.chain !== 'solana' || request.to.chain !== 'solana') {
      throw new SwingsError('invalid', 'Jupiter only swaps on Solana.');
    }
    if (sameToken(request.from, request.to)) throw new SwingsError('invalid', 'Choose two different tokens.');
    if (request.amountIn <= 0n) throw new SwingsError('invalid', 'Enter an amount above zero.');

    const q = await this.backend.fetchQuote(request.from.address, request.to.address, request.amountIn, request.slippageBps, signal);
    const fetchedAt = this.now();
    const venues = q.routes.length > 0 ? q.routes : ['Jupiter'];
    return {
      id: `jupiter:${fetchedAt}:${request.from.address.slice(0, 6)}:${request.to.address.slice(0, 6)}`,
      providerId: this.id,
      request,
      inAmount: q.inAmount,
      expectedOut: q.outAmount,
      minOut: q.minOut,
      // Jupiter's own impact figure is meaningless for tokens it has no reference price for, so it is not used.
      priceImpactBps: null,
      route: { legs: venues.map((venue) => ({ venue, from: request.from, to: request.to, shareBps: Math.floor(10_000 / venues.length) })) },
      costs: { network: null, provider: null, aretiaFee: { amount: 0n, asset: null } },
      fetchedAt,
      expiresAt: fetchedAt + JUPITER_QUOTE_TTL_MS,
      raw: q,
    };
  }

  async buildTransaction(quote: Quote): Promise<PreparedSwap> {
    if (quote.providerId !== this.id) throw new SwingsError('invalid', 'This quote was not made by Jupiter.');
    if (this.now() >= quote.expiresAt) throw new SwingsError('expired', 'This quote has expired. Get a new one.');
    const { request } = quote;
    // Token identity comes from the request, never from provider text: re-check it is a real Solana mint.
    const from = normalizeTokenRef('solana', request.from.address);
    const to = normalizeTokenRef('solana', request.to.address);
    if (!from || !to) throw new SwingsError('invalid', 'The token address is not a valid Solana mint.');
    const [fromInfo, toInfo] = await Promise.all([this.backend.resolveToken(from.address), this.backend.resolveToken(to.address)]);
    if (!fromInfo || !toInfo) throw new SwingsError('invalid', 'One of the tokens could not be read on-chain.');

    const plan = await this.backend.planSwap({
      user: request.account.address,
      from: fromInfo,
      to: toInfo,
      amountRaw: request.amountIn,
      slippageBps: request.slippageBps,
      quote: quote.raw as JupiterQuote,
    });
    const warnings: string[] = [];
    if (plan.opensOutputAccount) warnings.push(`This swap opens a ${toInfo.symbol} account in your wallet, which costs a small amount of SOL.`);
    return {
      quoteId: quote.id,
      chain: 'solana',
      payload: plan,
      simulation: { ok: plan.blockers.length === 0, blockers: plan.blockers, warnings },
      preparedAt: this.now(),
    };
  }
}
