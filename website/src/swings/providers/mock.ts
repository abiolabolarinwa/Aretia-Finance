/**
 * A fake provider for tests and for developing the UI before real credentials exist. It is never
 * registered by the live wiring and cannot produce a real transaction.
 */
import { SwingsError, type ChainId, type DexProvider, type PreparedSwap, type Quote, type SwapRequest } from '../core/types.js';

export interface MockProviderOptions {
  id?: string;
  chains?: ChainId[];
  /** Output as basis points of the input amount (10_000 = 1:1). */
  rateBps?: number;
  failWith?: string;
  now?: () => number;
}

export class MockDexProvider implements DexProvider {
  readonly id: string;
  readonly name: string;
  constructor(private readonly options: MockProviderOptions = {}) {
    this.id = options.id ?? 'mock';
    this.name = `Mock (${this.id})`;
  }

  supports(chain: ChainId): boolean {
    return (this.options.chains ?? ['solana', 'ethereum', 'bnb', 'polygon', 'base', 'arbitrum', 'optimism', 'avalanche']).includes(chain);
  }

  async getQuote(request: SwapRequest): Promise<Quote> {
    if (this.options.failWith) throw new SwingsError('provider-failed', this.options.failWith);
    const now = (this.options.now ?? Date.now)();
    const out = (request.amountIn * BigInt(this.options.rateBps ?? 9_900)) / 10_000n;
    return {
      id: `${this.id}:${now}`,
      providerId: this.id,
      request,
      inAmount: request.amountIn,
      expectedOut: out,
      minOut: (out * BigInt(10_000 - request.slippageBps)) / 10_000n,
      priceImpactBps: 5,
      route: { legs: [{ venue: 'Mock pool', from: request.from, to: request.to, shareBps: 10_000 }] },
      costs: { network: null, provider: null, aretiaBuyback: { amount: 0n, asset: null } },
      fetchedAt: now,
      expiresAt: now + 15_000,
      raw: null,
    };
  }

  async buildTransaction(quote: Quote): Promise<PreparedSwap> {
    throw new SwingsError('not-enabled', `The mock provider cannot build a real transaction (quote ${quote.id}).`);
  }
}
