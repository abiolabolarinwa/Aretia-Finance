/**
 * A settlement provider for TESTS ONLY. It moves nothing and is named so in everything it reports. It is never wired
 * into the product: a test checks that no production module imports this file.
 */
import type { ChainId } from '../core/types.js';
import { executionIdOf, type SettlementIntent, type SettlementProvider, type SettlementQuote, type SettlementStatus, type SettlementTransaction, type SupportAnswer } from './types.js';

export interface MockSettlementOptions {
  id?: string;
  /** Pairs "source>destination" this mock claims to support. Empty means every pair. */
  pairs?: string[];
  feeBps?: number;
  seconds?: number;
  risk?: 'low' | 'medium' | 'high';
  now?: () => number;
  /** What `trackSettlement` reports, so tests can walk a settlement through its states. */
  status?: () => SettlementStatus['code'];
  failQuote?: boolean;
  sloppy?: Partial<{ changeAmount: boolean; payMore: boolean; expired: boolean; noReceiveStep: boolean; otherProvider: boolean }>;
}

export class MockSettlementProvider implements SettlementProvider {
  readonly id: string;
  readonly name: string;
  constructor(private readonly o: MockSettlementOptions = {}) {
    this.id = o.id ?? 'mock-settlement';
    this.name = 'Mock settlement (tests only)';
  }

  private now = (): number => (this.o.now ?? Date.now)();

  async supports(intent: SettlementIntent): Promise<SupportAnswer> {
    const pair = `${intent.sourceChain}>${intent.destinationChain}`;
    const ok = !this.o.pairs || this.o.pairs.length === 0 || this.o.pairs.includes(pair);
    return ok ? { supported: true, reason: null } : { supported: false, reason: `The mock does not list ${pair}.` };
  }

  async getQuote(intent: SettlementIntent): Promise<SettlementQuote> {
    if (this.o.failQuote) throw new Error('mock provider is down');
    const fee = (intent.sourceAmount * BigInt(Math.round((this.o.feeBps ?? 10) * 100))) / 1_000_000n;
    const s = this.o.sloppy ?? {};
    return {
      id: `${this.id}:${this.now()}`,
      providerId: s.otherProvider ? 'someone-else' : this.id,
      intent,
      route: {
        providerId: this.id,
        mechanism: 'Mock stablecoin transfer (tests only)',
        kind: 'transfer',
        steps: [
          { id: 'send', kind: 'send', chain: intent.sourceChain, description: 'Send (mock)', requiresSignature: true, estimatedSeconds: 5 },
          ...(s.noReceiveStep ? [] : [{ id: 'receive', kind: 'receive' as const, chain: intent.destinationChain, description: 'Receive (mock)', requiresSignature: false, estimatedSeconds: this.o.seconds ?? 60 }]),
        ],
      },
      sourceAmount: s.changeAmount ? intent.sourceAmount + 1n : intent.sourceAmount,
      destinationAmount: s.payMore ? intent.sourceAmount + 1n : intent.sourceAmount - fee,
      settlementFee: { chain: intent.sourceChain, asset: intent.sourceAsset, amount: fee, description: 'Mock fee' },
      networkFees: null,
      estimatedSeconds: this.o.seconds ?? 60,
      limits: { min: null, max: null },
      expiresAt: s.expired ? this.now() - 1 : this.now() + 60_000,
      risk: { level: this.o.risk ?? 'low', trust: 'Nothing real is trusted: this is a test double.', factors: this.o.risk === 'high' ? ['Test double marked high risk'] : [] },
      requirements: [],
      raw: null,
    };
  }

  async buildSettlement(quote: SettlementQuote): Promise<SettlementTransaction[]> {
    const chain: ChainId = quote.intent.sourceChain;
    return [{ stepId: 'send', chain, description: 'Mock send (tests only)', unsigned: { kind: 'evm', tx: { from: quote.intent.sender, to: '0x' + '0'.repeat(40) }, chainId: 0 } }];
  }

  async buildDestination(): Promise<SettlementTransaction | null> {
    return null;
  }

  async trackSettlement(executionId: string): Promise<SettlementStatus> {
    return { executionId, code: this.o.status?.() ?? 'awaiting-source', destinationTxHash: null, message: 'mock', updatedAt: this.now() };
  }

  executionIdFor(chain: ChainId, tx: string): string {
    return executionIdOf(this.id, chain, tx);
  }
}
