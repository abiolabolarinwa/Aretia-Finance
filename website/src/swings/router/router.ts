/**
 * AretiaRouter: asks every provider that supports a chain for a quote, keeps only executable ones,
 * ranks them, and drives the chosen one through build -> check -> sign -> track.
 *
 * It imports no provider and no chain library. Rules it enforces:
 *  - a quote is executable only if fresh, internally consistent and for exactly the tokens asked for;
 *  - a failing provider never causes a silent switch to another route: the caller is told and chooses;
 *  - one quote executes at most once, and a broadcast is never retried here;
 *  - nothing is sent without an explicit confirmation naming the quote.
 */
import { BUILD_TIMEOUT_MS, QUOTE_GRACE_MS, TRACK_INTERVAL_MS, TRACK_TIMEOUT_MS } from './budget.js';
import { DEFAULT_FEE_CONFIG, FEE_PERCENT, planAretiaFee } from '../core/fee.js';
import { sameToken } from '../core/token.js';
import { summarizeQuote, type ExecutionSummary } from '../core/summary.js';
import {
  CHAINS,
  isTerminal,
  SwingsError,
  type AretiaFeeConfig,
  type ChainAdapter,
  type ChainId,
  type DexProvider,
  type PreparedSwap,
  type Quote,
  type SwapExecution,
  type SwapRequest,
  type TransactionStatus,
} from '../core/types.js';

export interface RouterOptions {
  providers: DexProvider[];
  /** After the first usable route arrives, how long the other providers get to beat it (default QUOTE_GRACE_MS). */
  quoteGraceMs?: number;
  /** Longest building and checking of a transaction (default BUILD_TIMEOUT_MS). */
  buildTimeoutMs?: number;
  adapters: ChainAdapter[];
  feeConfig?: AretiaFeeConfig;
  now?: () => number;
  /** Per-provider quote timeout. */
  providerTimeoutMs?: number;
  /** Quotes with a known price impact above this are not executable. */
  maxPriceImpactBps?: number;
  /** Override which chains may execute (tests). Defaults to CHAINS[chain].executionEnabled. */
  isChainEnabled?: (chain: ChainId) => boolean;
  /** A provider that fails this many searches in a row is skipped for `breakerCooldownMs`, and the skip is reported. */
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  /** Observer for debugging and analytics. Receives route metadata only: never keys or signed data. */
  onEvent?: (event: RouterEvent) => void;
}

export type RouterEvent =
  | { type: 'quote-failed'; providerId: string; message: string }
  | { type: 'quote-rejected'; providerId: string; reasons: string[] }
  | { type: 'routes-found'; chain: ChainId; count: number; bestProvider: string | null }
  /** Aretia's own route against the best aggregator route for the same request. `diffBps` is Aretia minus the rival, in basis points of the rival's output. */
  | { type: 'shadow'; chain: ChainId; winner: string; rival: string; diffBps: number }
  | { type: 'execution'; execution: SwapExecution };

export interface RejectedQuote {
  providerId: string;
  reasons: string[];
}

export interface ProviderFailure {
  providerId: string;
  message: string;
  /**
   * Set when the provider ANSWERED and said it has no route for this request (no pool, an amount too small, not enough SOL
   * for the account fees). That is a normal answer, not a fault: it never counts towards skipping the provider, and the
   * screen shows its own words instead of "did not answer".
   */
  answered?: true;
}

export interface RouteSearch {
  /** Executable quotes, best first. */
  routes: Quote[];
  rejected: RejectedQuote[];
  failures: ProviderFailure[];
}

/**
 * What to tell the person when no route came back, in words that match what really happened: the provider's own reason if it
 * answered; "too slow" if it timed out (that is not a missing route, and "try a different token" would be wrong advice); or
 * that it could not be reached.
 */
export function explainNoRoute(failures: readonly ProviderFailure[], labelOf: (providerId: string) => string = (id) => id): string {
  const answered = failures.find((f) => f.answered);
  const silent = failures.filter((f) => !f.answered && !f.message.startsWith('Temporarily skipped'));
  if (answered) return `No route was found for this swap. ${answered.message}${silent.length > 0 ? ` ${silent.map((f) => labelOf(f.providerId)).join(' and ')} did not answer.` : ''}`;
  const slow = silent.filter((f) => /in time/i.test(f.message));
  if (slow.length > 0) return `${slow.map((f) => labelOf(f.providerId)).join(' and ')} took too long to answer, so this is not a missing route: the network is slow right now. Try again in a moment.`;
  if (silent.length > 0) return `${silent.map((f) => labelOf(f.providerId)).join(' and ')} could not be reached. Try again in a moment.`;
  return 'No route was found for this swap. Try a different amount or token.';
}

/**
 * Whether a provider's rejection means the provider itself is unwell (it timed out, the network failed, or it said so) as
 * opposed to a plain answer about this one request. Only the first kind may ever count towards the circuit breaker: if
 * "no route for this token" counted, three attempts at tokens it cannot trade would switch the provider off for every token.
 */
export function isProviderFault(reason: unknown): boolean {
  return !(reason instanceof SwingsError) || reason.code === 'provider-failed';
}

export interface UserConfirmation {
  quoteId: string;
  /** Set only by the UI when the user pressed confirm on the review screen. */
  confirmed: true;
}

const withTimeout = <T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('The provider did not answer in time.'));
    }, ms);
  });
  return Promise.race([work(controller.signal), timeout]).finally(() => clearTimeout(timer));
};

export class AretiaRouter {
  private readonly providers: DexProvider[];
  private readonly adapters = new Map<ChainId, ChainAdapter>();
  private readonly feeConfig: AretiaFeeConfig;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly graceMs: number;
  private readonly buildTimeoutMs: number;
  private readonly maxImpact: number;
  private readonly enabled: (chain: ChainId) => boolean;
  private readonly emit: (e: RouterEvent) => void;
  private readonly executed = new Set<string>();
  private readonly health = new Map<string, { failures: number; skipUntil: number }>();
  private readonly breakerThreshold: number;
  private readonly breakerCooldown: number;

  constructor(options: RouterOptions) {
    this.providers = [...options.providers];
    for (const a of options.adapters) this.adapters.set(a.chain, a);
    this.feeConfig = options.feeConfig ?? DEFAULT_FEE_CONFIG;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.providerTimeoutMs ?? 8_000;
    this.graceMs = options.quoteGraceMs ?? QUOTE_GRACE_MS;
    this.buildTimeoutMs = options.buildTimeoutMs ?? BUILD_TIMEOUT_MS;
    this.maxImpact = options.maxPriceImpactBps ?? 1_500;
    this.enabled = options.isChainEnabled ?? ((c) => CHAINS[c].executionEnabled);
    this.emit = options.onEvent ?? (() => {});
    this.breakerThreshold = options.breakerThreshold ?? 3;
    this.breakerCooldown = options.breakerCooldownMs ?? 30_000;
  }

  private skipped(id: string): boolean {
    const h = this.health.get(id);
    return h !== undefined && h.failures >= this.breakerThreshold && this.now() < h.skipUntil;
  }
  private noteResult(id: string, ok: boolean): void {
    const h = this.health.get(id) ?? { failures: 0, skipUntil: 0 };
    if (ok) this.health.set(id, { failures: 0, skipUntil: 0 });
    else this.health.set(id, { failures: h.failures + 1, skipUntil: this.now() + this.breakerCooldown });
  }

  /** Adds (or replaces) the adapter for a chain, for example once an EVM wallet has been connected. */
  registerAdapter(adapter: ChainAdapter): void {
    this.adapters.set(adapter.chain, adapter);
  }

  hasAdapter(chain: ChainId): boolean {
    return this.adapters.has(chain);
  }

  /** The provider ids that could answer for a chain. */
  providersFor(chain: ChainId): string[] {
    return this.providers.filter((p) => p.supports(chain)).map((p) => p.id);
  }

  /** Why a quote cannot be executed; empty means it can. Pure apart from the clock. */
  executabilityProblems(quote: Quote, request: SwapRequest): string[] {
    const problems: string[] = [];
    if (this.now() >= quote.expiresAt) problems.push('The quote has expired.');
    if (quote.expectedOut <= 0n) problems.push('The quote returns nothing.');
    if (quote.minOut <= 0n) problems.push('The quote has no minimum output.');
    if (quote.minOut > quote.expectedOut) problems.push('The quote is inconsistent: minimum is above expected output.');
    // What the user entered is what is swapped plus the Aretia fee taken out of it.
    if (quote.inAmount + quote.costs.aretiaFee.amount !== request.amountIn) problems.push('The quote is for a different amount than you entered.');
    if (!sameToken(quote.request.from, request.from) || !sameToken(quote.request.to, request.to)) problems.push('The quote is for different tokens than you chose.');
    if (quote.request.chain !== request.chain) problems.push('The quote is for a different network.');
    if (quote.priceImpactBps !== null && quote.priceImpactBps > this.maxImpact) problems.push(`Price impact ${(quote.priceImpactBps / 100).toFixed(2)}% is above the limit.`);
    // Slippage promise: the minimum must honour the slippage the user chose.
    const floor = (quote.expectedOut * BigInt(10_000 - request.slippageBps)) / 10_000n;
    if (quote.minOut < floor) problems.push('The quote accepts more slippage than you chose.');
    return problems;
  }

  /** Concurrently asks all supporting providers; returns executable routes best-first plus why others were dropped. */
  async findRoutes(request: SwapRequest): Promise<RouteSearch> {
    if (!this.enabled(request.chain)) throw new SwingsError('not-enabled', `${CHAINS[request.chain].name} swaps are not enabled yet.`);
    if (request.slippageBps < 0 || request.slippageBps > 5_000) throw new SwingsError('invalid', 'Slippage must be between 0% and 50%.');
    const candidates = this.providers.filter((p) => p.supports(request.chain));
    if (candidates.length === 0) throw new SwingsError('no-route', `No provider is available for ${CHAINS[request.chain].name}.`);

    const failures: RouteSearch['failures'] = [];
    let active = candidates.filter((p) => !this.skipped(p.id));
    if (active.length === 0) {
      // Skipping every provider would turn a hiccup into an outage with nothing left to try. Ask them all anyway.
      active = candidates;
    } else {
      for (const p of candidates) {
        // Reported, never silent: the user is told a provider was left out and why.
        if (!active.includes(p)) failures.push({ providerId: p.id, message: 'Temporarily skipped after repeated failures.' });
      }
    }
    // Every provider is asked at once. The first usable route starts a short grace window for the others to beat it; whoever has
    // not answered when it ends is left out (and told to stop), so one slow provider never holds the price back.
    const problemsOf = (provider: DexProvider, quote: Quote): string[] => {
      const problems = this.executabilityProblems(quote, request);
      if (!provider.carriesAretiaFee && planAretiaFee(request.amountIn, request.chain, this.feeConfig, request.from.address).state === 'ready') problems.push(`An outside route was found, but it cannot collect the ${FEE_PERCENT} Aretia fee, so Aretia does not offer it.`);
      return problems;
    };
    const asked = active.map((p) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const promise = new Promise<Quote>((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('The provider did not answer in time.'));
        }, p.quoteTimeoutMs ?? this.timeoutMs);
        p.getQuote(request, controller.signal).then(resolve, reject);
      }).finally(() => clearTimeout(timer));
      return { controller, promise };
    });
    const settled: (PromiseSettledResult<Quote> | undefined)[] = active.map(() => undefined);
    await new Promise<void>((done) => {
      let left = active.length;
      let grace: ReturnType<typeof setTimeout> | undefined;
      asked.forEach((a, i) => {
        a.promise.then(
          (value) => (settled[i] = { status: 'fulfilled', value }),
          (reason: unknown) => (settled[i] = { status: 'rejected', reason }),
        ).then(() => {
          left--;
          if (left === 0) {
            clearTimeout(grace);
            return done();
          }
          const got = settled[i];
          if (grace === undefined && got?.status === 'fulfilled' && problemsOf(active[i]!, got.value).length === 0) grace = setTimeout(done, this.graceMs);
        });
      });
    });
    asked.forEach((a, i) => {
      if (settled[i] === undefined) a.controller.abort();
    });
    const routes: Quote[] = [];
    const rejected: RejectedQuote[] = [];
    settled.forEach((result, i) => {
      const providerId = active[i]!.id;
      if (result === undefined) {
        // A faster route was already in hand: this one is left out, and that is not held against it.
        failures.push({ providerId, message: 'Left out: a route was already found and this one was too slow to beat it.', answered: true });
        return;
      }
      const fault = result.status === 'rejected' && isProviderFault(result.reason);
      this.noteResult(providerId, !fault);
      if (result.status === 'rejected') {
        const message = result.reason instanceof Error ? result.reason.message : 'The provider failed.';
        failures.push({ providerId, message, ...(fault ? {} : { answered: true as const }) });
        this.emit({ type: 'quote-failed', providerId, message });
        return;
      }
      const problems = problemsOf(active[i]!, result.value);
      if (problems.length > 0) {
        rejected.push({ providerId, reasons: problems });
        this.emit({ type: 'quote-rejected', providerId, reasons: problems });
      } else routes.push(result.value);
    });
    const ranked = this.compareRoutes(routes);
    this.emitShadow(request.chain, ranked);
    this.emit({ type: 'routes-found', chain: request.chain, count: ranked.length, bestProvider: ranked[0]?.providerId ?? null });
    return { routes: ranked, rejected, failures };
  }

  /**
   * Shadow comparison: when Aretia's own provider and at least one other provider both quoted, record how far apart
   * they were and who won. The better route is the one executed either way (the list is already ranked); this only
   * keeps the evidence of where Aretia is behind. No address, amount or token is part of the event.
   */
  private emitShadow(chain: ChainId, ranked: Quote[]): void {
    const own = ranked.find((q) => q.providerId.startsWith('aretia'));
    const rival = ranked.find((q) => !q.providerId.startsWith('aretia'));
    if (!own || !rival || rival.expectedOut <= 0n) return;
    const raw = ((own.expectedOut - rival.expectedOut) * 10_000n) / rival.expectedOut;
    const diffBps = Math.max(-10_000, Math.min(10_000, Number(raw)));
    this.emit({ type: 'shadow', chain, winner: ranked[0]!.providerId, rival: rival.providerId, diffBps });
  }

  /** The best executable quote, or a clear error. */
  async getQuote(request: SwapRequest): Promise<Quote> {
    const { routes, failures } = await this.findRoutes(request);
    const best = routes[0];
    if (!best) {
      const why = failures.length > 0 ? ' Providers that failed: ' + failures.map((f) => f.providerId).join(', ') + '.' : '';
      throw new SwingsError('no-route', 'No executable route was found for this swap.' + why);
    }
    return best;
  }

  /**
   * Orders quotes for the same request. All are in the same output token, so more expected output wins;
   * then a higher guaranteed minimum, then fewer legs (less to go wrong), then the fresher quote.
   * Network cost is not folded in because it can be in a different asset; it is shown, not guessed at.
   */
  compareRoutes(quotes: readonly Quote[]): Quote[] {
    return [...quotes].sort((a, b) => {
      if (a.expectedOut !== b.expectedOut) return a.expectedOut > b.expectedOut ? -1 : 1;
      if (a.minOut !== b.minOut) return a.minOut > b.minOut ? -1 : 1;
      if (a.route.legs.length !== b.route.legs.length) return a.route.legs.length - b.route.legs.length;
      return b.fetchedAt - a.fetchedAt;
    });
  }

  /**
   * How much less a fallback route pays than the one the user was shown, in basis points (0 if equal or better).
   * The UI uses it to ask for explicit acceptance: a worse route is never taken automatically.
   */
  static degradationBps(shown: Quote, fallback: Quote): number {
    if (shown.expectedOut <= 0n || fallback.expectedOut >= shown.expectedOut) return 0;
    return Number(((shown.expectedOut - fallback.expectedOut) * 10_000n) / shown.expectedOut);
  }

  /** The four-part summary to show before signing. */
  summarize(quote: Quote): ExecutionSummary {
    return summarizeQuote(quote, this.feeConfig);
  }

  /** Builds and checks the transaction. Throws if the fee policy or simulation says it must not proceed. Never switches provider. */
  async buildTransaction(quote: Quote): Promise<PreparedSwap> {
    if (!this.enabled(quote.request.chain)) throw new SwingsError('not-enabled', `${CHAINS[quote.request.chain].name} swaps are not enabled yet.`);
    if (this.now() >= quote.expiresAt) throw new SwingsError('expired', 'This quote has expired. Get a new one.');
    const summary = this.summarize(quote);
    if (!summary.canProceed) throw new SwingsError('config-missing', summary.aretiaFee.reasons.join(' ') || 'The Aretia fee configuration is incomplete.');
    const provider = this.providers.find((p) => p.id === quote.providerId);
    if (!provider) throw new SwingsError('invalid', 'The provider for this quote is no longer available.');
    if (summary.aretiaFee.state === 'ready' && !provider.carriesAretiaFee) throw new SwingsError('config-missing', 'This route cannot collect the Aretia fee, so it cannot be executed while the fee is on.');
    // Building reads the chain and simulates the swap; it is given a limit, so a stuck node ends in an answer instead of a spinner.
    return withTimeout(() => provider.buildTransaction(quote), this.buildTimeoutMs).catch((e: unknown) => {
      if (e instanceof Error && e.message === 'The provider did not answer in time.') throw new SwingsError('provider-failed', 'Preparing the swap took too long. Nothing was sent. Try again.');
      throw e;
    });
  }

  /** Same as buildTransaction; named for the spec. The prepared swap carries its simulation report. */
  simulateRoute(quote: Quote): Promise<PreparedSwap> {
    return this.buildTransaction(quote);
  }

  /**
   * Signs and sends a prepared swap, once. Requires the user's confirmation for this exact quote and a
   * passing simulation. A failure to send is reported, never retried automatically.
   */
  async executeRoute(prepared: PreparedSwap, quote: Quote, confirmation: UserConfirmation): Promise<SwapExecution> {
    if (!confirmation.confirmed || confirmation.quoteId !== quote.id || prepared.quoteId !== quote.id) {
      throw new SwingsError('rejected', 'The swap was not confirmed for this quote.');
    }
    if (this.now() >= quote.expiresAt) throw new SwingsError('expired', 'This quote expired before it was signed. Get a new one.');
    if (!prepared.simulation.ok) throw new SwingsError('simulation-failed', prepared.simulation.blockers.join(' ') || 'The swap failed its checks.');
    if (this.executed.has(quote.id)) throw new SwingsError('invalid', 'This quote was already executed.');
    const adapter = this.adapters.get(prepared.chain);
    if (!adapter) throw new SwingsError('not-enabled', `No ${CHAINS[prepared.chain].name} adapter is installed.`);

    this.executed.add(quote.id);
    const startedAt = this.now();
    const execution: SwapExecution = { id: `exec:${quote.id}`, quoteId: quote.id, chain: prepared.chain, status: 'awaiting-signature', startedAt, updatedAt: startedAt };
    this.emit({ type: 'execution', execution: { ...execution } });
    try {
      execution.txId = await adapter.signAndSubmit(prepared);
      execution.status = 'submitted';
    } catch (e) {
      const message = e instanceof Error ? e.message : 'The swap could not be sent.';
      const notSent = e instanceof SwingsError && e.code === 'not-sent';
      execution.status = notSent ? 'failed' : /reject|denied|declin|cancel/i.test(message) ? 'rejected' : 'failed';
      execution.error = message;
      if (notSent) execution.notSent = true;
      // A rejected signature, or a wallet that reports it never sent anything, sent nothing, so the same quote may be tried again;
      // anything else might have been broadcast.
      if (execution.status === 'rejected' || notSent) this.executed.delete(quote.id);
    }
    execution.updatedAt = this.now();
    this.emit({ type: 'execution', execution: { ...execution } });
    return execution;
  }

  /** Polls the chain until the transaction settles or the timeout passes. Read-only: it never resends. */
  async trackExecution(execution: SwapExecution, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<SwapExecution> {
    if (!execution.txId || isTerminal(execution.status)) return execution;
    const adapter = this.adapters.get(execution.chain);
    if (!adapter) return execution;
    const deadline = this.now() + (options.timeoutMs ?? TRACK_TIMEOUT_MS);
    const interval = options.intervalMs ?? TRACK_INTERVAL_MS;
    let status: TransactionStatus = execution.status;
    while (this.now() < deadline) {
      status = await adapter.getStatus(execution.txId);
      if (isTerminal(status)) break;
      await new Promise((r) => setTimeout(r, interval));
    }
    const next: SwapExecution = { ...execution, status, updatedAt: this.now() };
    this.emit({ type: 'execution', execution: next });
    return next;
  }
}
