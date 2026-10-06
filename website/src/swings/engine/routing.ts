/**
 * Aretia Routing Engine V1. Finds routes across the pools Aretia has indexed (LiquidityStore), prices them
 * with Aretia's own maths, scores them with a fixed, readable formula, and decides whether splitting an
 * order across routes is worth it. No aggregator is consulted anywhere.
 *
 * Scope of V1, stated plainly:
 *  - exact local maths exists for constant-product pools only. Other pool models are not routed through yet
 *    (they would need their own quoter), and they are never split-simulated by guesswork;
 *  - a split assumes its legs execute in the order given, against pool state changed by the earlier legs.
 */
import { tokenKey, sameToken } from '../core/token.js';
import { SwingsError, type TokenRef } from '../core/types.js';
import { applyConstantProduct, orient, priceImpactBps, sideOf } from './amm.js';
import type { LiquidityStore } from './liquidity.js';
import type { AretiaDexRegistry } from './registry.js';
import { isSimulable, type LiquidityPool, type PlannedRoute, type RouteHop, type SplitLeg, type SplitRoute } from './types.js';

export interface ScoringConfig {
  /** Penalty per extra hop, in bps of output: more hops means more that can go wrong. */
  hopPenaltyBps: number;
  /** Penalty per pool whose data is older than `freshMs`. */
  stalePenaltyBps: number;
  /** Penalty per pool on a venue whose status is DEGRADED. */
  degradedPenaltyBps: number;
  /** Pools younger than this are fresh. */
  freshMs: number;
  /** A pool is ignored entirely once its data is older than this. */
  maxAgeMs: number;
  /** Penalty per hop through a token the caller marks risky (see `tokenPenaltyBps`). */
}

export const DEFAULT_SCORING: ScoringConfig = { hopPenaltyBps: 3, stalePenaltyBps: 5, degradedPenaltyBps: 20, freshMs: 30_000, maxAgeMs: 300_000 };

export interface RouteRequest {
  tokenIn: TokenRef;
  tokenOut: TokenRef;
  amountIn: bigint;
  /** Maximum pools in a route (default 3). */
  maxHops?: number;
  /** Routes kept after ranking (default 5). */
  maxRoutes?: number;
  /** Do not route through pools holding less than this raw amount of the pool's input token (default 1). */
  minReserveIn?: bigint;
  /** Only routes whose every pool is on one venue: what a single router transaction can execute. */
  sameVenueOnly?: boolean;
}

export interface EngineDeps {
  store: LiquidityStore;
  registry?: AretiaDexRegistry;
  now?: () => number;
  scoring?: Partial<ScoringConfig>;
  /** Tokens that must never be traded or routed through (for example restricted by the risk engine). */
  isBlocked?: (token: TokenRef) => boolean;
  /** Extra penalty in bps for routing through a token (for example from its risk score). Applied per intermediate token. */
  tokenPenaltyBps?: (token: TokenRef) => number;
  /** Network cost of a route expressed in the output token, when the caller can price it. Otherwise gas is reported unpriced. */
  gasCostInOut?: (hops: number) => bigint | null;
}

export interface RouteResult {
  best: PlannedRoute;
  alternatives: PlannedRoute[];
  /** A split order, only when it beats the best single route by a meaningful margin. */
  split: SplitRoute | null;
  /** Why the engine decided what it did: one line per decision, for debugging and display. */
  reasoning: string[];
}

export interface SplitOptions {
  /** Granularity of the allocation search (default 20 pieces). */
  chunks?: number;
  /** A split must beat the best single route by at least this much (default 10 bps). */
  minImprovementBps?: number;
  /** Each leg must carry at least this share (default 500 bps = 5%). */
  minShareBps?: number;
  maxLegs?: number;
}

export class RoutingEngine {
  private readonly cfg: ScoringConfig;
  private readonly now: () => number;

  constructor(private readonly deps: EngineDeps) {
    this.cfg = { ...DEFAULT_SCORING, ...deps.scoring };
    this.now = deps.now ?? Date.now;
  }

  // ------------------------------------------------------------------ discovery

  private usable(pool: LiquidityPool, minReserveIn: bigint, tokenIn: TokenRef): boolean {
    if (pool.status !== 'active' || !isSimulable(pool)) return false;
    if (this.deps.store.ageMs(pool) > this.cfg.maxAgeMs) return false;
    if (this.deps.registry) {
      const s = this.deps.registry.effectiveStatus(pool.ref.dex);
      if (s !== 'ACTIVE' && s !== 'DEGRADED') return false;
    }
    return orient(pool, tokenIn).reserveIn >= minReserveIn && orient(pool, tokenIn).reserveOut > 0n;
  }

  /** Every pool sequence from tokenIn to tokenOut within the hop limit, never visiting a token twice. */
  private paths(req: RouteRequest): LiquidityPool[][] {
    const maxHops = req.maxHops ?? 3;
    const minReserve = req.minReserveIn ?? 1n;
    const found: LiquidityPool[][] = [];
    const walk = (token: TokenRef, trail: LiquidityPool[], seen: Set<string>): void => {
      if (found.length >= 400) return;
      for (const pool of this.deps.store.forToken(token)) {
        if (!this.usable(pool, minReserve, token)) continue;
        const next = orient(pool, token).tokenOut;
        if (this.deps.isBlocked?.(next)) continue;
        const nextKey = tokenKey(next);
        if (seen.has(nextKey)) continue;
        const trailNext = [...trail, pool];
        if (req.sameVenueOnly && pool.ref.dex !== trail[0]?.ref.dex && trail.length > 0) continue;
        if (sameToken(next, req.tokenOut)) found.push(trailNext);
        else if (trailNext.length < maxHops) walk(next, trailNext, new Set([...seen, nextKey]));
      }
    };
    if (this.deps.isBlocked?.(req.tokenIn) || this.deps.isBlocked?.(req.tokenOut)) return [];
    walk(req.tokenIn, [], new Set([tokenKey(req.tokenIn)]));
    return found;
  }

  // ------------------------------------------------------------------ pricing and scoring

  /** Runs an amount through a pool sequence against the given pool states. Returns the hops and the new states. */
  private run(pools: LiquidityPool[], tokenIn: TokenRef, amountIn: bigint, state?: Map<string, LiquidityPool>): { hops: RouteHop[]; states: LiquidityPool[]; ideal: bigint } | null {
    const hops: RouteHop[] = [];
    const states: LiquidityPool[] = [];
    let token = tokenIn;
    let amount = amountIn;
    let ideal = amountIn;
    for (const original of pools) {
      const key = `${original.ref.chain}:${original.ref.dex}:${original.ref.address}`;
      const pool = state?.get(key) ?? original;
      try {
        const { reserveIn, reserveOut, tokenOut } = orient(pool, token);
        const { pool: after, amountOut } = applyConstantProduct(pool, token, amount);
        if (amountOut <= 0n) return null;
        ideal = (ideal * reserveOut) / reserveIn;
        hops.push({ pool, tokenIn: token, tokenOut, amountIn: amount, amountOut });
        states.push(after);
        token = tokenOut;
        amount = amountOut;
      } catch {
        return null;
      }
    }
    return { hops, states, ideal };
  }

  private plan(pools: LiquidityPool[], req: RouteRequest, amountIn: bigint, state?: Map<string, LiquidityPool>): PlannedRoute | null {
    const run = this.run(pools, req.tokenIn, amountIn, state);
    if (!run) return null;
    const out = run.hops[run.hops.length - 1]!.amountOut;
    const first = run.hops[0]!;
    const impact = run.ideal > 0n ? Number(((run.ideal > out ? run.ideal - out : 0n) * 10_000n) / run.ideal) : 0;
    void first;
    const { score, reasons } = this.score(run.hops, out, impact);
    return { hops: run.hops, amountIn, amountOut: out, idealOut: run.ideal, priceImpactBps: impact, score, reasons };
  }

  /** The scoring formula. Everything that moves a score is written into `reasons`. */
  private score(hops: RouteHop[], out: bigint, impactBps: number): { score: bigint; reasons: string[] } {
    const reasons: string[] = [`Expected output ${out} (raw), price impact ${(impactBps / 100).toFixed(2)}% including fees.`];
    let penalty = 0;
    if (hops.length > 1) {
      const p = this.cfg.hopPenaltyBps * (hops.length - 1);
      penalty += p;
      reasons.push(`${hops.length} hops: -${p} bps for added complexity.`);
    }
    for (const h of hops) {
      const age = this.deps.store.ageMs(h.pool);
      if (age > this.cfg.freshMs) {
        penalty += this.cfg.stalePenaltyBps;
        reasons.push(`Pool ${h.pool.ref.dex} data is ${Math.round(age / 1000)}s old: -${this.cfg.stalePenaltyBps} bps.`);
      }
      if (this.deps.registry?.effectiveStatus(h.pool.ref.dex) === 'DEGRADED') {
        penalty += this.cfg.degradedPenaltyBps;
        reasons.push(`${h.pool.ref.dex} is degraded: -${this.cfg.degradedPenaltyBps} bps.`);
      }
    }
    for (const h of hops.slice(0, -1)) {
      const extra = this.deps.tokenPenaltyBps?.(h.tokenOut) ?? 0;
      if (extra > 0) {
        penalty += extra;
        reasons.push(`Routes through a token with elevated risk: -${extra} bps.`);
      }
    }
    let score = (out * BigInt(Math.max(0, 10_000 - penalty))) / 10_000n;
    const gas = this.deps.gasCostInOut?.(hops.length) ?? null;
    if (gas === null) reasons.push('Network fee not priced in the output token, so it does not affect this score.');
    else {
      score -= gas;
      reasons.push(`Network fee ${gas} (raw output units) subtracted.`);
    }
    return { score, reasons };
  }

  private rank(routes: PlannedRoute[]): PlannedRoute[] {
    const id = (r: PlannedRoute): string => r.hops.map((h) => h.pool.ref.address).join('>');
    return [...routes].sort((a, b) => (a.score !== b.score ? (a.score > b.score ? -1 : 1) : a.hops.length !== b.hops.length ? a.hops.length - b.hops.length : id(a) < id(b) ? -1 : 1));
  }

  // ------------------------------------------------------------------ public

  /** Routes only, best first. Throws when no route exists. */
  routes(req: RouteRequest): PlannedRoute[] {
    if (req.amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
    if (sameToken(req.tokenIn, req.tokenOut)) throw new SwingsError('invalid', 'Choose two different tokens.');
    const planned = this.paths(req).map((p) => this.plan(p, req, req.amountIn)).filter((r): r is PlannedRoute => r !== null);
    if (planned.length === 0) throw new SwingsError('no-route', 'No route was found through the pools Aretia has indexed.');
    return this.rank(planned).slice(0, req.maxRoutes ?? 5);
  }

  find(req: RouteRequest, splitOptions: SplitOptions | false = {}): RouteResult {
    const ranked = this.routes({ ...req, maxRoutes: 50 });
    const best = ranked[0]!;
    const reasoning = [`${ranked.length} route${ranked.length === 1 ? '' : 's'} found; best pays ${best.amountOut} (raw) through ${best.hops.map((h) => h.pool.ref.dex).join(' > ')}.`];
    if (ranked.length > 1) reasoning.push(`Runner-up pays ${ranked[1]!.amountOut}; the best route is ahead by ${best.score - ranked[1]!.score} in score.`);
    let split: SplitRoute | null = null;
    if (splitOptions === false) reasoning.push('Splitting was not requested.');
    else {
      const res = this.split(req, ranked, splitOptions);
      split = res.split;
      reasoning.push(res.reason);
    }
    return { best, alternatives: ranked.slice(1, req.maxRoutes ?? 5), split, reasoning };
  }

  // ------------------------------------------------------------------ split routing

  split(req: RouteRequest, ranked: PlannedRoute[], options: SplitOptions = {}): { split: SplitRoute | null; reason: string } {
    const chunks = options.chunks ?? 20;
    const minImprovement = options.minImprovementBps ?? 10;
    const minShare = options.minShareBps ?? 500;
    const maxLegs = options.maxLegs ?? 4;
    const best = ranked[0]!;
    if (req.amountIn < BigInt(chunks)) return { split: null, reason: 'Not split: the amount is too small to divide.' };
    let candidates = ranked.slice(0, 8).map((r) => r.hops.map((h) => h.pool));
    if (candidates.length < 2) return { split: null, reason: 'Not split: only one route exists.' };

    // Greedy water-filling: hand each piece to whichever route pays most for it *given what earlier pieces did to the pools*.
    for (let attempt = 0; attempt < maxLegs + 4; attempt++) {
      const state = new Map<string, LiquidityPool>();
      const alloc = candidates.map(() => 0n);
      const piece = req.amountIn / BigInt(chunks);
      let remaining = req.amountIn;
      for (let i = 0; i < chunks; i++) {
        const amount = i === chunks - 1 ? remaining : piece;
        let bestIdx = -1;
        let bestOut = -1n;
        candidates.forEach((pools, idx) => {
          const run = this.run(pools, req.tokenIn, amount, state);
          const out = run ? run.hops[run.hops.length - 1]!.amountOut : -1n;
          if (out > bestOut) {
            bestOut = out;
            bestIdx = idx;
          }
        });
        if (bestIdx < 0) return { split: null, reason: 'Not split: pieces could not be priced.' };
        const run = this.run(candidates[bestIdx]!, req.tokenIn, amount, state)!;
        run.states.forEach((s) => state.set(`${s.ref.chain}:${s.ref.dex}:${s.ref.address}`, s));
        alloc[bestIdx]! += amount;
        remaining -= amount;
      }
      // Drop routes that ended up with too small a share, then allocate again without them.
      const tooSmall = alloc.map((a, i) => ({ a, i })).filter((x) => x.a > 0n && (x.a * 10_000n) / req.amountIn < BigInt(minShare));
      const used = alloc.filter((a) => a > 0n).length;
      if (tooSmall.length > 0 && used > 1) {
        const drop = new Set(tooSmall.map((x) => x.i));
        candidates = candidates.filter((_, i) => !drop.has(i));
        continue;
      }
      if (used < 2) return { split: null, reason: 'Not split: the best single route was also the best for every piece.' };
      if (used > maxLegs) return { split: null, reason: `Not split: it would need more than ${maxLegs} legs.` };

      // Replay the legs in order on fresh state: this is the amount a real execution would see.
      const replay = new Map<string, LiquidityPool>();
      const legs: SplitLeg[] = [];
      let total = 0n;
      for (let i = 0; i < candidates.length; i++) {
        if (alloc[i]! === 0n) continue;
        const route = this.plan(candidates[i]!, req, alloc[i]!, replay);
        if (!route) return { split: null, reason: 'Not split: a leg could not be priced when replayed.' };
        route.hops.forEach((h, k) => {
          const after = applyConstantProduct(h.pool, h.tokenIn, h.amountIn).pool;
          void k;
          replay.set(`${after.ref.chain}:${after.ref.dex}:${after.ref.address}`, after);
        });
        total += route.amountOut;
        legs.push({ share: route, shareBps: Number((alloc[i]! * 10_000n) / req.amountIn) });
      }
      const sum = legs.reduce((s, l) => s + l.shareBps, 0);
      if (sum !== 10_000 && legs.length > 0) {
        const biggest = legs.reduce((a, b) => (b.shareBps > a.shareBps ? b : a));
        biggest.shareBps += 10_000 - sum;
      }
      const improvement = best.amountOut > 0n ? Number(((total - best.amountOut) * 10_000n) / best.amountOut) : 0;
      if (total <= best.amountOut || improvement < minImprovement) return { split: null, reason: `Not split: splitting gains ${improvement} bps, below the ${minImprovement} bps needed to justify the extra complexity.` };
      return { split: { legs, amountIn: req.amountIn, amountOut: total, improvementBps: improvement }, reason: `Split across ${legs.length} routes gains ${improvement} bps over the best single route.` };
    }
    return { split: null, reason: 'Not split: no stable allocation was found.' };
  }
}

// Re-exported helpers used by callers that display route results.
export { priceImpactBps, sideOf };
