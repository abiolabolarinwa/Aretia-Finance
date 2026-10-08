/**
 * The ramp routing engine: intent -> eligible providers -> quotes -> checks -> ranking. Like the settlement engine it
 * asks every provider, keeps their reasons for declining, checks each quote itself, and ranks by a stated rule.
 *
 * Ranking: a priced quote (one with a real number) ranks above an unpriced one, because a price Aretia can show is
 * worth more than one it cannot; among priced quotes the one delivering more crypto (buy) or paying more fiat is not
 * comparable without a fiat figure, so a deterministic order by provider id breaks the rest. Aretia takes no payment
 * for ranking and no provider is favoured by position.
 */
import { SwingsError } from '../core/types.js';
import type { RampIntent, RampProvider, RampQuote } from './types.js';

export interface RampSearch {
  quotes: RampQuote[];
  declined: { providerId: string; reason: string }[];
  failures: { providerId: string; message: string }[];
}

export function rampQuoteProblems(intent: RampIntent, q: RampQuote, now: number): string[] {
  const p: string[] = [];
  const i = q.intent;
  if (i.side !== intent.side || i.fiat !== intent.fiat || i.fiatAmount !== intent.fiatAmount || i.wallet.toLowerCase() !== intent.wallet.toLowerCase() || i.asset.chain !== intent.asset.chain || i.asset.address.toLowerCase() !== intent.asset.address.toLowerCase()) p.push('The quote is for a different request than the one made.');
  if (q.expiresAt <= now) p.push('The quote has already expired.');
  if (q.priced && (q.cryptoAmount === null || q.cryptoAmount <= 0n)) p.push('The quote claims a price but gives no amount.');
  if (!q.priced && q.cryptoAmount !== null) p.push('The quote gives an amount without saying where the price comes from.');
  if (q.verification !== 'provider') p.push('The quote does not say who verifies identity.');
  if (q.disclosures.length === 0) p.push('The quote carries no disclosures.');
  return p;
}

export function rankRampQuotes(quotes: readonly RampQuote[]): RampQuote[] {
  return [...quotes].sort((a, b) => (a.priced === b.priced ? (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0) : a.priced ? -1 : 1));
}

export class RampRouter {
  constructor(
    private readonly providers: readonly RampProvider[],
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 8_000,
  ) {}

  async quote(intent: RampIntent, signal?: AbortSignal): Promise<RampSearch> {
    const declined: RampSearch['declined'] = [];
    const failures: RampSearch['failures'] = [];
    const quotes: RampQuote[] = [];
    await Promise.all(
      this.providers.map(async (p) => {
        const ctl = new AbortController();
        signal?.addEventListener('abort', () => ctl.abort(), { once: true });
        const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
        try {
          const timeout = new Promise<never>((_, rej) => ctl.signal.addEventListener('abort', () => rej(new SwingsError('provider-failed', 'The provider took too long to answer.')), { once: true }));
          const work = (async () => {
            const sup = await p.supports(intent, ctl.signal);
            if (!sup.supported) return declined.push({ providerId: p.id, reason: sup.reason ?? 'This provider cannot do this.' });
            const q = await p.getQuote(intent, ctl.signal);
            const problems = rampQuoteProblems(intent, q, this.now());
            if (q.providerId !== p.id) problems.push('The quote names a different provider.');
            if (problems.length > 0) failures.push({ providerId: p.id, message: problems.join(' ') });
            else quotes.push(q);
          })();
          await Promise.race([work, timeout]);
        } catch (e) {
          failures.push({ providerId: p.id, message: e instanceof Error ? e.message : 'The provider failed.' });
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    declined.sort((a, b) => (a.providerId < b.providerId ? -1 : 1));
    failures.sort((a, b) => (a.providerId < b.providerId ? -1 : 1));
    return { quotes: rankRampQuotes(quotes), declined, failures };
  }
}
