/**
 * MoonPay as the first ramp provider. It never touches a key: it talks to Aretia's own `/api/ramp`, which holds the
 * keys, lists only what MoonPay currently offers, and signs the hosted-page link.
 *
 * What MoonPay's public interface lets Aretia know, and what it does not:
 *  - known: which tokens and countries are available now, so unsupported requests are declined with a reason;
 *  - not known: a price. MoonPay shows the exact price and fees on its own page, so the quote says "priced: false".
 *  - not known: an order's progress. Orders cannot be followed from here, so tracking answers `unknown` and a buy is
 *    finished only when the crypto is seen in the wallet (see ramp/watch.ts).
 */
import { CHAINS, SwingsError } from '../core/types.js';
import type { RampIntent, RampOrderStatus, RampProvider, RampQuote, RampSession, RampSupport } from './types.js';

export interface RampApiCatalog {
  countries: { code: string; name: string; buy: boolean; sell: boolean }[];
  fiats: string[];
  tokens: { chain: string; symbol: string; contract: string; sell: boolean }[];
}
export interface RampApiStatus {
  enabled: boolean;
  providers?: { id: string; name: string; sides: string[] }[];
}

/** Calls Aretia's `/api/ramp`. Injected so tests need no network. */
export type RampApi = (body: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

export interface MoonPayOptions {
  api: RampApi;
  now?: () => number;
  quoteTtlMs?: number;
}

const ALLOWED_HOSTS = /^(?:buy|sell)(?:-sandbox)?\.moonpay\.com$/;

export class MoonPayRampProvider implements RampProvider {
  readonly id = 'moonpay';
  readonly name = 'MoonPay';
  private readonly now: () => number;
  private cache: { at: number; status: RampApiStatus; catalog: RampApiCatalog | null } | null = null;

  constructor(private readonly o: MoonPayOptions) {
    this.now = o.now ?? Date.now;
  }

  private async state(signal?: AbortSignal): Promise<{ status: RampApiStatus; catalog: RampApiCatalog | null }> {
    if (this.cache && this.now() - this.cache.at < 5 * 60_000) return this.cache;
    const status = (await this.o.api({ action: 'status' }, signal)) as RampApiStatus;
    const live = status?.enabled === true && (status.providers ?? []).some((p) => p.id === 'moonpay');
    const catalog = live ? ((await this.o.api({ action: 'catalog' }, signal)) as RampApiCatalog) : null;
    this.cache = { at: this.now(), status, catalog };
    return this.cache;
  }

  /** What MoonPay currently offers, for filling the screen's choices. Null if the service is off or unreachable. */
  async availability(signal?: AbortSignal): Promise<{ catalog: RampApiCatalog; sides: string[] } | null> {
    try {
      const s = await this.state(signal);
      const me = (s.status.providers ?? []).find((p) => p.id === 'moonpay');
      return s.status.enabled && me && s.catalog ? { catalog: s.catalog, sides: me.sides } : null;
    } catch {
      return null;
    }
  }

  async supports(intent: RampIntent, signal?: AbortSignal): Promise<RampSupport> {
    const no = (reason: string): RampSupport => ({ supported: false, reason });
    let s: Awaited<ReturnType<MoonPayRampProvider['state']>>;
    try {
      s = await this.state(signal);
    } catch {
      return no('The buy and sell service could not be reached, so MoonPay cannot be confirmed right now.');
    }
    const me = (s.status.providers ?? []).find((p) => p.id === 'moonpay');
    if (!s.status.enabled || !me) return no('Buying and selling is not switched on yet.');
    if (!me.sides.includes(intent.side)) return no(`${this.name} is not offering ${intent.side === 'buy' ? 'buying' : 'selling'} yet.`);
    if (!s.catalog) return no('MoonPay\'s availability list could not be loaded.');
    if (!intent.country) return no('Choose your country first: availability depends on it.');
    const country = s.catalog.countries.find((c) => c.code === intent.country);
    if (!country || !(intent.side === 'buy' ? country.buy : country.sell)) return no(`${this.name} does not ${intent.side === 'buy' ? 'sell crypto to' : 'buy crypto from'} customers in ${country?.name ?? intent.country}.`);
    if (!s.catalog.fiats.includes(intent.fiat)) return no(`${this.name} does not support ${intent.fiat.toUpperCase()} right now.`);
    const token = s.catalog.tokens.find((t) => t.chain === intent.asset.chain && t.contract.toLowerCase() === intent.asset.address.toLowerCase());
    if (!token) return no(`${this.name} does not list ${intent.asset.symbol} on ${CHAINS[intent.asset.chain].name} right now.`);
    if (intent.side === 'sell' && !token.sell) return no(`${this.name} does not list selling ${intent.asset.symbol} on ${CHAINS[intent.asset.chain].name}.`);
    if (intent.fiatAmount !== null && (!Number.isInteger(intent.fiatAmount) || intent.fiatAmount < 1)) return no('Enter a whole amount of at least 1.');
    return { supported: true, reason: null };
  }

  async getQuote(intent: RampIntent, signal?: AbortSignal): Promise<RampQuote> {
    const support = await this.supports(intent, signal);
    if (!support.supported) throw new SwingsError('no-route', support.reason ?? 'Not supported.');
    const buy = intent.side === 'buy';
    const t = this.now();
    return {
      id: `moonpay:${t}:${intent.asset.chain}:${intent.side}`,
      providerId: this.id,
      providerName: this.name,
      intent,
      priced: false,
      cryptoAmount: null,
      fees: [{ label: `${this.name} fee and exchange rate`, amount: null }, { label: 'Aretia fee', amount: '0' }],
      disclosures: [
        buy ? `${this.name} takes your payment and checks your identity. Aretia never sees your card or documents.` : `You send ${intent.asset.symbol} from your own wallet to the address ${this.name} shows, and ${this.name} pays you in ${intent.fiat.toUpperCase()}. Aretia never holds your crypto.`,
        'The exact price, fees and limits are shown on the provider\'s page before you pay. Compare them before you confirm.',
        buy ? `The ${intent.asset.symbol} is sent to ${intent.wallet} on ${CHAINS[intent.asset.chain].name}. Check that address is yours.` : `If the sale does not go through, ${intent.asset.symbol} is returned to ${intent.wallet}.`,
      ],
      verification: 'provider',
      expiresAt: t + (this.o.quoteTtlMs ?? 10 * 60_000),
      estimatedMinutes: null,
    };
  }

  async createSession(quote: RampQuote, signal?: AbortSignal): Promise<RampSession> {
    if (quote.providerId !== this.id) throw new SwingsError('invalid', 'This quote was not made by this provider.');
    if (quote.expiresAt <= this.now()) throw new SwingsError('expired', 'This quote has expired. Get a new one.');
    const i = quote.intent;
    const out = (await this.o.api({ action: 'session', provider: 'moonpay', side: i.side, asset: i.asset.symbol, chain: i.asset.chain, wallet: i.wallet, fiat: i.fiat, ...(i.fiatAmount !== null ? { amount: i.fiatAmount } : {}) }, signal)) as { url?: unknown };
    if (typeof out?.url !== 'string') throw new SwingsError('provider-failed', 'The service did not give a checkout link.');
    let u: URL;
    try {
      u = new URL(out.url);
    } catch {
      throw new SwingsError('provider-failed', 'The checkout link was not valid.');
    }
    // Only the provider's own domain is ever shown as a checkout link.
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.test(u.host)) throw new SwingsError('provider-failed', 'The checkout link was not on the provider\'s own site, so it was not used.');
    return { kind: 'hosted', url: u.toString(), host: u.host };
  }

  async trackOrder(): Promise<RampOrderStatus> {
    return { code: 'unknown', message: 'This provider\'s order cannot be followed from Aretia. A purchase is finished when the crypto appears in your wallet.', updatedAt: this.now() };
  }
}
