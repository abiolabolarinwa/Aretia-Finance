/**
 * The settlement quote engine:
 *
 *   intent -> provider discovery -> quotes -> checks -> risk -> cost and time -> best route
 *
 * It asks every provider whether it can execute the intent and gets a quote from those that can. It then checks every
 * quote itself, because a provider's answer is not trusted just because it is a provider's: a quote that does not match
 * the intent, that pays out more than was sent, that has expired, or whose route does not end with the destination
 * actually receiving the value is thrown out, with the reason. What survives is ranked by a stated rule.
 *
 * Nothing here moves value. It only decides which quote to put in front of the user.
 */
import { SwingsError } from '../core/types.js';
import type { SettlementIntent, SettlementProvider, SettlementQuote } from './types.js';

export type SettlementPreference = 'balanced' | 'cheapest' | 'fastest';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface SettlementSearch {
  /** Quotes that passed every check, best first. */
  quotes: SettlementQuote[];
  /** Providers that cannot execute this intent, and why. Shown to the user, not hidden. */
  declined: { providerId: string; reason: string }[];
  /** Providers that failed to answer, and quotes that failed the engine's checks. */
  failures: { providerId: string; message: string }[];
}

export interface SettlementEngineOptions {
  now?: () => number;
  /** How long to wait for one provider. */
  timeoutMs?: number;
  /** The riskiest quote that may be offered. Higher-risk quotes are declined with their reason. */
  maxRisk?: RiskLevel;
}

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

const sameIntent = (a: SettlementIntent, b: SettlementIntent): boolean =>
  a.sourceChain === b.sourceChain && a.destinationChain === b.destinationChain && a.sourceAmount === b.sourceAmount && a.sourceAsset.address.toLowerCase() === b.sourceAsset.address.toLowerCase() && a.sourceAsset.chain === b.sourceAsset.chain && a.destinationAsset.address.toLowerCase() === b.destinationAsset.address.toLowerCase() && a.destinationAsset.chain === b.destinationAsset.chain && a.recipient.toLowerCase() === b.recipient.toLowerCase() && a.sender.toLowerCase() === b.sender.toLowerCase();

/** What is wrong with a quote, judged without trusting the provider. Empty means it is acceptable. Pure. */
export function quoteProblems(intent: SettlementIntent, q: SettlementQuote, now: number): string[] {
  const p: string[] = [];
  if (!sameIntent(intent, q.intent)) p.push('The quote is for a different request than the one made.');
  if (q.sourceAmount !== intent.sourceAmount) p.push('The quote changes the amount being sent.');
  if (q.destinationAmount <= 0n) p.push('The quote delivers nothing.');
  if (q.route.kind === 'transfer' && q.destinationAmount > q.sourceAmount) p.push('The quote delivers more than was sent, which a transfer cannot do.');
  if (q.settlementFee.amount < 0n) p.push('The quote has a negative fee.');
  if (q.expiresAt <= now) p.push('The quote has already expired.');
  if (q.limits.min !== null && intent.sourceAmount < q.limits.min) p.push('The amount is below the route\'s minimum.');
  if (q.limits.max !== null && intent.sourceAmount > q.limits.max) p.push('The amount is above the route\'s maximum.');
  const steps = q.route.steps;
  if (steps.length === 0) p.push('The route has no steps.');
  else if (steps[steps.length - 1]!.kind !== 'receive') p.push('The route does not end with the destination receiving the value, so it could be reported complete too early.');
  if (steps.some((s) => s.requiresSignature && s.kind === 'wait')) p.push('A waiting step cannot need a signature.');
  if (!Number.isFinite(q.estimatedSeconds) || q.estimatedSeconds < 0) p.push('The quote has no usable time estimate.');
  return p;
}

/** Orders quotes by the stated preference. Risk always comes first; ties fall through to the next rule. Pure. */
export function rankQuotes(quotes: readonly SettlementQuote[], preference: SettlementPreference): SettlementQuote[] {
  const byCost = (a: SettlementQuote, b: SettlementQuote): number => (a.destinationAmount === b.destinationAmount ? 0 : a.destinationAmount > b.destinationAmount ? -1 : 1);
  const byTime = (a: SettlementQuote, b: SettlementQuote): number => a.estimatedSeconds - b.estimatedSeconds;
  const byRisk = (a: SettlementQuote, b: SettlementQuote): number => RISK_ORDER[a.risk.level] - RISK_ORDER[b.risk.level];
  const order = preference === 'fastest' ? [byRisk, byTime, byCost] : [byRisk, byCost, byTime];
  return [...quotes].sort((a, b) => {
    for (const rule of order) {
      const r = rule(a, b);
      if (r !== 0) return r;
    }
    return a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0;
  });
}

function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, outer?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  outer?.addEventListener('abort', () => controller.abort(), { once: true });
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new SwingsError('provider-failed', 'The provider took too long to answer.'));
    }, ms);
    work(controller.signal).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class SettlementQuoteEngine {
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxRisk: RiskLevel;

  constructor(
    private readonly providers: readonly SettlementProvider[],
    options: SettlementEngineOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.maxRisk = options.maxRisk ?? 'medium';
  }

  async quote(intent: SettlementIntent, preference: SettlementPreference = 'balanced', signal?: AbortSignal): Promise<SettlementSearch> {
    if (intent.sourceAmount <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
    if (intent.sourceChain === intent.destinationChain) throw new SwingsError('invalid', 'Settlement moves value between two different chains. Use a swap for one chain.');
    const declined: SettlementSearch['declined'] = [];
    const failures: SettlementSearch['failures'] = [];
    const quotes: SettlementQuote[] = [];
    await Promise.all(
      this.providers.map(async (p) => {
        try {
          const support = await withTimeout((s) => p.supports(intent, s), this.timeoutMs, signal);
          if (!support.supported) {
            declined.push({ providerId: p.id, reason: support.reason ?? 'This provider cannot execute this request.' });
            return;
          }
          const q = await withTimeout((s) => p.getQuote(intent, s), this.timeoutMs, signal);
          const problems = quoteProblems(intent, q, this.now());
          if (q.providerId !== p.id) problems.push('The quote names a different provider.');
          if (problems.length > 0) {
            failures.push({ providerId: p.id, message: problems.join(' ') });
            return;
          }
          if (RISK_ORDER[q.risk.level] > RISK_ORDER[this.maxRisk]) {
            declined.push({ providerId: p.id, reason: `Declined for risk (${q.risk.level}): ${q.risk.factors.join('; ') || q.risk.trust}` });
            return;
          }
          quotes.push(q);
        } catch (e) {
          failures.push({ providerId: p.id, message: e instanceof Error ? e.message : 'The provider failed.' });
        }
      }),
    );
    declined.sort((a, b) => (a.providerId < b.providerId ? -1 : 1));
    failures.sort((a, b) => (a.providerId < b.providerId ? -1 : 1));
    return { quotes: rankQuotes(quotes, preference), declined, failures };
  }

  /** The best quote, or a clear error that names why no provider could help. */
  async best(intent: SettlementIntent, preference: SettlementPreference = 'balanced', signal?: AbortSignal): Promise<SettlementQuote> {
    const search = await this.quote(intent, preference, signal);
    const first = search.quotes[0];
    if (first) return first;
    const why = [...search.declined.map((d) => `${d.providerId}: ${d.reason}`), ...search.failures.map((f) => `${f.providerId}: ${f.message}`)].join(' | ');
    throw new SwingsError('no-route', `No settlement route is available for this request.${why ? ' ' + why : ''}`);
  }
}
