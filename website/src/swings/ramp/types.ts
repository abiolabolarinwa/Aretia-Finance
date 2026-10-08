/**
 * The ramp domain: how money in a bank or card becomes crypto in the user's own wallet (buy), and the reverse (sell).
 * It answers one question: "Can this person, in this country, turn this much of this currency into that token on that
 * chain, and what will it cost?" Ramps are interchangeable behind `RampProvider`; no one provider is built into Swings.
 *
 * Rules every provider and the router keep (tests enforce them):
 *  - a provider is offered only if it is really configured and really lists the token on the chain, today;
 *  - Aretia never holds fiat or crypto: the provider takes the payment and the crypto goes to the user's own wallet;
 *  - a price Aretia has not been given is never invented: a quote says so ("shown by the provider before you pay");
 *  - a ramp order is complete only when the crypto is seen in the wallet (buy) or the provider confirms payout (sell);
 *  - verification (KYC) is the provider's; Aretia never sees or stores identity documents.
 */
import type { ChainId } from '../core/types.js';

export type RampSide = 'buy' | 'sell';

export interface RampAssetRef {
  chain: ChainId;
  symbol: string;
  /** The token's address on its chain. */
  address: string;
  decimals: number;
}

export interface RampIntent {
  side: RampSide;
  /** Lower-case ISO currency code, for example "usd". */
  fiat: string;
  /** Whole units of the fiat currency (provider widgets take whole amounts). Null lets the user choose on the provider's page. */
  fiatAmount: number | null;
  asset: RampAssetRef;
  /** Buy: where the crypto is delivered. Sell: where it comes from and is refunded to. */
  wallet: string;
  /** Upper-case two-letter country, used to say "not available there". Null = not known, which fails closed. */
  country: string | null;
}

export interface RampCost {
  label: string;
  /** Null when the provider shows this cost only on its own page. */
  amount: string | null;
}

export type RampOrderCode = 'created' | 'awaiting-payment' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface RampQuote {
  id: string;
  providerId: string;
  providerName: string;
  intent: RampIntent;
  /**
   * False when Aretia has no price from the provider. Then `cryptoAmount` is null and `fees` say so; the provider shows
   * the exact price and fees on its own page, before the user pays.
   */
  priced: boolean;
  /** Raw units of the token the user is expected to receive (buy), when `priced`. */
  cryptoAmount: bigint | null;
  fees: RampCost[];
  /** Plain statements the user must see: who takes the payment, who verifies identity, limits that are known. */
  disclosures: string[];
  /** Whether the provider takes the user through identity checks. */
  verification: 'provider';
  expiresAt: number;
  /** Rough minutes from payment to funds, from the provider's own claims, or null if unknown. */
  estimatedMinutes: number | null;
}

export interface RampSession {
  kind: 'hosted';
  /** The provider's own page, opened by the user. Aretia does not see the payment. */
  url: string;
  host: string;
}

export interface RampOrderStatus {
  code: RampOrderCode;
  message: string;
  updatedAt: number;
}

export interface RampSupport {
  supported: boolean;
  reason: string | null;
}

export interface RampProvider {
  readonly id: string;
  readonly name: string;
  supports(intent: RampIntent, signal?: AbortSignal): Promise<RampSupport>;
  getQuote(intent: RampIntent, signal?: AbortSignal): Promise<RampQuote>;
  /** The hosted page for a quote. Opens nothing; the caller shows the link. */
  createSession(quote: RampQuote, signal?: AbortSignal): Promise<RampSession>;
  /** Where an order is, when the provider can be asked. Providers that cannot be asked answer `unknown`, never a guess. */
  trackOrder(quote: RampQuote, signal?: AbortSignal): Promise<RampOrderStatus>;
}
