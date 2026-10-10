/**
 * Aretia's own Solana swap provider. Pools are read from the venues' programs, the transaction is built by Aretia,
 * and it is run through the real programs on the RPC before the user is asked to sign. No aggregator is involved.
 *
 * Route shapes, all executed as ONE transaction (so each is atomic):
 *  - direct: one swap through one pool;
 *  - two hops: through a hub token (wrapped SOL, USDC, USDT), two swaps back to back;
 *  - split: the same swap divided between two pools of the same pair, when that pays measurably more.
 *
 * Pricing: venues with exact local maths (Raydium CPMM) are priced locally; the others (Orca, Meteora DAMM v2)
 * are priced by the program itself, by simulating the swap from the user's own account. A swap request always
 * carries that account, so the simulation runs from the account that would really sign.
 */
import type * as Web3 from '@solana/web3.js';
import { ataAddress, createAtaIdempotentInstruction, solTransferInstruction, TOKEN_PROGRAM_ID, transferCheckedInstruction } from '../../scripts/walletTools.js';
import { DEFAULT_FEE_CONFIG, FEE_PERCENT, planAretiaFee } from '../core/fee.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type AretiaFeeConfig, type DexProvider, type PreparedSwap, type Quote, type SwapRequest, type TokenRef } from '../core/types.js';
import type { ProviderHealth } from '../engine/health.js';
import type { AretiaDexRegistry } from '../engine/registry.js';
import type { LiquidityPool } from '../engine/types.js';
import { buildRouteTransaction, WSOL_MINT, type BuiltRoute, type RouteBuildOptions, type RouteStep } from './builder.js';
import { checkTip, DEFAULT_TIP_LAMPORTS, pickTipAccount } from './jito.js';
import type { SolRpc } from './raydiumCpmm.js';
import { simulateSolanaSwap, type SolanaSimResult } from './simulate.js';
import { createSolanaVenues, type SolanaVenue } from './venues.js';

export const SOLANA_QUOTE_TTL_MS = 12_000;
/** SOL a swap may use beyond the amount: fees, priority fee and rent for several new accounts. */
const OVERHEAD_LAMPORTS = 8_000_000n;
/** Intermediate tokens a route may pass through. */
export const SOLANA_HUBS = [WSOL_MINT, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'] as const;
/** The second hop sells slightly less than the first is expected to deliver, so normal movement cannot starve it. */
const HOP_BUFFER_BPS = 10n;
/** A split is only considered when the best single pool loses at least this much to the trade's own size. */
const SPLIT_IMPACT_BPS = 30;
/** A split must beat the best single route by at least this much to be worth its extra instructions. */
const SPLIT_MIN_GAIN_BPS = 10n;

export interface DirectSolanaDeps {
  web3: () => Promise<typeof Web3>;
  rpc: SolRpc;
  registry: AretiaDexRegistry;
  health?: ProviderHealth;
  /** The Aretia fee policy. Defaults to the shipped neutral one, which is off. */
  fee?: AretiaFeeConfig;
  now?: () => number;
}

/** What the quote keeps about a leg so the transaction can be rebuilt from fresh pool data at signing time. */
interface LegRaw {
  entryId: string;
  poolAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minOut: bigint;
}

interface SolanaRaw {
  shape: 'direct' | 'two-hop' | 'split';
  legs: LegRaw[];
  nativeIn: boolean;
  nativeOut: boolean;
  reasons: string[];
  /** The Aretia fee carried in the same transaction, when the fee policy is on: a transfer, in the asset being sold, to the fee address. */
  fee?: { amount: bigint; treasury: string; mint: string; native: boolean };
}

interface Leg {
  venue: SolanaVenue;
  pool: LiquidityPool;
  tokenIn: TokenRef;
  tokenOut: TokenRef;
  amountIn: bigint;
  minOut: bigint;
}

interface Plan {
  shape: SolanaRaw['shape'];
  legs: Leg[];
  /** Expected output of each leg that ends at the route's output token. */
  legOuts: bigint[];
  amountOut: bigint;
  impactBps: number | null;
  reasons: string[];
}

export interface SolanaSwapPayload {
  /** The unsigned transaction the wallet will be asked to sign. */
  transaction: Web3.VersionedTransaction;
  /** Plain-language list of what the transaction does, in order. */
  steps: string[];
  plannedAt: number;
  /** Present when the user chose protected sending: the signed transaction must go through Jito, not the public path. */
  protectedSubmission?: { tipLamports: number };
}

const isWsol = (t: TokenRef): boolean => t.address === WSOL_MINT;
/** How much of `mint` a pool holds: the yardstick for "deepest pool" among pools that share that token. */
const depthOf = (pool: LiquidityPool, mint: string): bigint => (pool.token0.address === mint ? pool.reserve0 : pool.reserve1);
const after = (amount: bigint, bps: bigint): bigint => (amount * (10_000n - bps)) / 10_000n;
const short = (a: string): string => `${a.slice(0, 6)}…`;

export class DirectSolanaProvider implements DexProvider {
  readonly id = 'aretia-sol';
  readonly name = 'Aretia Router';
  /** This provider puts the Aretia fee inside the transaction it builds, so it may be used while the fee is on. */
  readonly carriesAretiaFee = true;
  private readonly now: () => number;
  private readonly fee: AretiaFeeConfig;
  /** Why pools that were found could not be used in the quote being worked out (a simulation refusal, an unanswered check). */
  private skipped: string[] = [];

  constructor(private readonly deps: DirectSolanaDeps) {
    this.now = deps.now ?? Date.now;
    this.fee = deps.fee ?? DEFAULT_FEE_CONFIG;
  }

  supports(chain: SwapRequest['chain']): boolean {
    return chain === 'solana' && this.deps.registry.routable('solana').some((e) => e.mechanism === 'solana-program');
  }

  private track<T>(id: string, work: () => Promise<T>): Promise<T> {
    return this.deps.health ? this.deps.health.track(id, work) : work();
  }

  // ------------------------------------------------------------------ building and probing

  private stepOf(leg: Leg, user: string): RouteStep {
    return {
      tokenIn: leg.tokenIn,
      tokenOut: leg.tokenOut,
      programIn: leg.venue.programFor(leg.pool, leg.tokenIn.address),
      programOut: leg.venue.programFor(leg.pool, leg.tokenOut.address),
      amountIn: leg.amountIn,
      label: leg.venue.label(leg.pool, leg.amountIn, leg.minOut),
      swapInstruction: (i, o) => leg.venue.swapInstruction(user, leg.pool, leg.tokenIn, leg.tokenOut, i, o, leg.amountIn, leg.minOut),
    };
  }

  private build(web3: typeof Web3, user: string, legs: Leg[], o: { nativeIn: boolean; nativeOut: boolean; closeWsol: boolean; tip?: { account: string; lamports: number }; prelude?: RouteBuildOptions['prelude'] }, blockhash: string): Promise<BuiltRoute> {
    return buildRouteTransaction(web3, { user, steps: legs.map((l) => this.stepOf(l, user)), nativeIn: o.nativeIn, nativeOut: o.nativeOut, closeWsol: o.closeWsol, recentBlockhash: blockhash, ...(o.tip ? { tip: o.tip } : {}), ...(o.prelude ? { prelude: o.prelude } : {}) });
  }

  /** A mint's decimals, read from the mint account itself (byte 44 for both token programs). */
  private async mintDecimals(mint: string): Promise<number> {
    const r = await this.deps.rpc<{ value: { data: [string, string] } | null }>('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }]);
    const d = r.value ? Uint8Array.from(atob(r.value.data[0]), (c) => c.charCodeAt(0)) : null;
    if (!d || d.length < 82 || d[44]! > 18) throw new SwingsError('invalid', 'The token being sold could not be read, so the Aretia fee could not be set up.');
    return d[44]!;
  }

  private async blockhash(): Promise<string> {
    return (await this.deps.rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
  }

  private simulate(built: BuiltRoute, user: string, route: { nativeIn: boolean; outputIsNative: boolean; amountIn: bigint; minOut: bigint }, watch: string[] = []): Promise<SolanaSimResult> {
    return simulateSolanaSwap(this.deps.rpc, built.transaction, {
      user,
      inAccount: built.inAccount,
      outAccount: built.outAccount,
      inputIsSol: route.nativeIn,
      outputIsSol: route.outputIsNative,
      amountIn: route.amountIn,
      minOut: route.minOut,
      overheadLamports: OVERHEAD_LAMPORTS,
      watch,
    });
  }

  /** What the programs say these legs deliver, simulated from the user's accounts with a floor of 1 (a probe, not the real swap). */
  private async probe(web3: typeof Web3, request: SwapRequest, legs: Leg[], blockhash: string, watchMint?: string): Promise<{ received: bigint | null; watched: bigint | null }> {
    const nativeIn = isWsol(request.from);
    const built = await this.build(web3, request.account.address, legs, { nativeIn, nativeOut: false, closeWsol: false }, blockhash);
    const sim = await this.simulate(built, request.account.address, { nativeIn, outputIsNative: false, amountIn: request.amountIn, minOut: 1n }, watchMint ? [built.accounts[watchMint]!] : []);
    if (sim.blockers.length > 0) {
      this.skipped.push(...sim.blockers);
      return { received: null, watched: null };
    }
    const w = sim.watched[0];
    return { received: sim.verdict.received, watched: w ? (w.post ?? 0n) - (w.pre ?? 0n) : null };
  }

  /** One leg's output: exact local maths where the venue has it, otherwise the program's own answer by simulation. */
  private async legOut(web3: typeof Web3, request: SwapRequest, leg: Leg, blockhash: string): Promise<bigint | null> {
    if (leg.venue.localQuote) {
      try {
        return leg.venue.localQuote(leg.pool, leg.tokenIn, leg.amountIn);
      } catch {
        return null;
      }
    }
    const r = await this.probe(web3, { ...request, from: leg.tokenIn, amountIn: leg.amountIn }, [{ ...leg, minOut: 1n }], blockhash).catch(() => {
      this.skipped.push('the network did not answer the price check');
      return { received: null, watched: null };
    });
    return r.received !== null && r.received > 0n ? r.received : null;
  }

  // ------------------------------------------------------------------ route discovery

  private async poolsOf(venues: SolanaVenue[], a: TokenRef, b: TokenRef): Promise<{ venue: SolanaVenue; pool: LiquidityPool }[]> {
    const lists = await Promise.all(
      venues.map(async (venue) => {
        try {
          return (await this.track(venue.id, () => venue.getPools(a, b))).filter((p) => p.status === 'active').map((pool) => ({ venue, pool }));
        } catch {
          return [];
        }
      }),
    );
    return lists.flat();
  }

  /**
   * How much the trade's own size costs: the fill against a hundredth of the amount scaled up, both priced the same way
   * (exact maths or the program). Null when the small trade cannot be priced.
   */
  private async impactOf(web3: typeof Web3, request: SwapRequest, leg: Leg, out: bigint, blockhash: string): Promise<number | null> {
    const small = leg.amountIn / 100n;
    if (small <= 0n) return null;
    const o = await this.legOut(web3, request, { ...leg, amountIn: small }, blockhash).catch(() => null);
    if (o === null) return null;
    const ideal = o * 100n;
    return ideal > out ? Number(((ideal - out) * 10_000n) / ideal) : 0;
  }

  /** Every route that can fill `req` (direct, two-hop, split), best first. Throws no-route when none can. */
  private async findPlans(web3: typeof Web3, req: SwapRequest, venues: SolanaVenue[], blockhash: string): Promise<{ plans: Plan[]; read: string }> {
    const { from, to } = req;
    const request = req;
    this.skipped = [];
    const hubs = SOLANA_HUBS.filter((h) => h !== from.address && h !== to.address).map((address): TokenRef => ({ chain: 'solana', address }));

    // Read every pool the plans might use, in parallel.
    const [direct, ...viaHubs] = await Promise.all([this.poolsOf(venues, from, to), ...hubs.flatMap((h) => [this.poolsOf(venues, from, h), this.poolsOf(venues, h, to)])]);
    const plans: Plan[] = [];

    // 1. Direct, through each pool.
    const directLegs: Leg[] = direct.map(({ venue, pool }) => ({ venue, pool, tokenIn: from, tokenOut: to, amountIn: request.amountIn, minOut: 1n }));
    const directOuts = await Promise.all(directLegs.map((leg) => this.legOut(web3, req, leg, blockhash).catch(() => null)));
    const directPlans: Plan[] = [];
    directLegs.forEach((leg, i) => {
      const out = directOuts[i];
      if (out === null || out === undefined) return;
      directPlans.push({
        shape: 'direct',
        legs: [leg],
        legOuts: [out],
        amountOut: out,
        impactBps: null,
        reasons: [`${leg.venue.name} pool ${short(leg.pool.ref.address)} ${leg.venue.localQuote ? "priced by Aretia's own exact maths" : 'priced by the program itself (simulated from your account)'}.`],
      });
    });
    plans.push(...directPlans);
    directPlans.sort((a, b) => (a.amountOut > b.amountOut ? -1 : a.amountOut < b.amountOut ? 1 : 0));
    if (directPlans[0]) directPlans[0].impactBps = await this.impactOf(web3, req, directPlans[0].legs[0]!, directPlans[0].amountOut, blockhash);

    // 2. Two hops through each hub: the deepest pool for each leg, checked by simulating the whole transaction.
    for (let k = 0; k < hubs.length; k++) {
      const hub = hubs[k]!;
      const first = viaHubs[k * 2]!;
      const second = viaHubs[k * 2 + 1]!;
      if (first.length === 0 || second.length === 0) continue;
      const deepest = (xs: typeof first): (typeof first)[number] => xs.reduce((a, b) => (depthOf(b.pool, hub.address) > depthOf(a.pool, hub.address) ? b : a));
      const p1 = deepest(first);
      const p2 = deepest(second);
      try {
        const leg1: Leg = { venue: p1.venue, pool: p1.pool, tokenIn: from, tokenOut: hub, amountIn: request.amountIn, minOut: 1n };
        const leg2: Leg = { venue: p2.venue, pool: p2.pool, tokenIn: hub, tokenOut: to, amountIn: 1n, minOut: 1n };
        // Pass 1: learn what the first hop delivers, from the intermediate account's balance change.
        const learned = await this.probe(web3, req, [leg1, leg2], blockhash, hub.address);
        if (learned.watched === null) continue;
        const out1 = learned.watched + leg2.amountIn;
        // Pass 2: sell slightly less than that, then read the real final output.
        const hop2In = after(out1, HOP_BUFFER_BPS);
        if (hop2In <= 0n) continue;
        const legs: Leg[] = [{ ...leg1, minOut: hop2In }, { ...leg2, amountIn: hop2In }];
        const final = await this.probe(web3, req, legs, blockhash);
        if (final.received === null || final.received <= 0n) continue;
        plans.push({
          shape: 'two-hop',
          legs,
          legOuts: [hop2In, final.received],
          amountOut: final.received,
          impactBps: null,
          reasons: [`Two hops through ${hub.address === WSOL_MINT ? 'SOL' : short(hub.address)}: ${p1.venue.name} then ${p2.venue.name}. The whole transaction was simulated on the real programs.`],
        });
      } catch {
        // This hub cannot carry the trade from this account; the others still can.
      }
    }

    // 3. Split a large trade between the two best direct pools when that pays measurably more.
    const best = directPlans[0];
    if (best && best.impactBps !== null && best.impactBps >= SPLIT_IMPACT_BPS && directPlans.length >= 2) {
      const a = directPlans[0]!.legs[0]!;
      const b = directPlans[1]!.legs[0]!;
      let bestSplit: Plan | null = null;
      for (const shareA of [7_000n, 5_000n]) {
        const amountA = (request.amountIn * shareA) / 10_000n;
        const amountB = request.amountIn - amountA;
        if (amountA <= 0n || amountB <= 0n) continue;
        try {
          const legA: Leg = { ...a, amountIn: amountA };
          const legB: Leg = { ...b, amountIn: amountB };
          const [outA, outB] = await Promise.all([this.legOut(web3, req, legA, blockhash), this.legOut(web3, req, legB, blockhash)]);
          if (outA === null || outB === null) continue;
          const pct = Number(shareA) / 100;
          const plan: Plan = {
            shape: 'split',
            legs: [legA, legB],
            legOuts: [outA, outB],
            amountOut: outA + outB,
            impactBps: null,
            reasons: [`Split ${pct}% / ${100 - pct}% between ${a.venue.name} ${short(a.pool.ref.address)} and ${b.venue.name} ${short(b.pool.ref.address)}, in one transaction.`],
          };
          if (!bestSplit || plan.amountOut > bestSplit.amountOut) bestSplit = plan;
        } catch {
          // This split could not be priced.
        }
      }
      if (bestSplit && bestSplit.amountOut > best.amountOut && ((bestSplit.amountOut - best.amountOut) * 10_000n) / best.amountOut >= SPLIT_MIN_GAIN_BPS) plans.push(bestSplit);
    }

    if (plans.length === 0) {
      // Pools were found but none could be used: say why, because "no pool" would send the user looking in the wrong place.
      if (direct.length > 0 && this.skipped.length > 0) {
        const why = [...new Set(this.skipped)].slice(0, 2).join('; ');
        throw new SwingsError('no-route', `Aretia found a pool for this pair but could not price the trade from your account: ${why}. A first swap into a token also needs a little extra SOL for the new token account and fees.`);
      }
      throw new SwingsError('no-route', 'No pool Aretia reads directly can fill this trade.');
    }
    plans.sort((x, y) => (x.amountOut !== y.amountOut ? (x.amountOut > y.amountOut ? -1 : 1) : x.legs.length - y.legs.length));
    const counts = new Map<string, number>();
    for (const d of direct) counts.set(d.venue.name, (counts.get(d.venue.name) ?? 0) + 1);
    const read = [...counts].map(([name, n]) => `${n} ${name} pool${n === 1 ? '' : 's'} read`).join(', ');
    return { plans, read };
  }
  async getQuote(request: SwapRequest): Promise<Quote> {
    if (request.chain !== 'solana') throw new SwingsError('invalid', 'The Aretia Solana router only swaps on Solana.');
    const from = normalizeTokenRef('solana', request.from.address);
    const to = normalizeTokenRef('solana', request.to.address);
    if (!from || !to || from.address === to.address) throw new SwingsError('invalid', 'Choose two different, valid tokens.');
    if (request.amountIn <= 0n) throw new SwingsError('invalid', 'Enter an amount above zero.');
    // The Aretia fee comes out of the amount entered, in the asset being sold; the rest is what is routed and swapped.
    const feePlan = planAretiaFee(request.amountIn, 'solana', this.fee, from.address);
    if (feePlan.state === 'blocked') throw new SwingsError('config-missing', feePlan.reasons.join(' '));
    if (feePlan.net <= 0n) throw new SwingsError('invalid', 'The amount is too small once the Aretia fee is taken out.');
    if (!this.supports('solana')) throw new SwingsError('no-route', 'No Solana venue is available right now.');

    const web3 = await this.deps.web3();
    const req: SwapRequest = { ...request, from, to, amountIn: feePlan.net };
    const venues = createSolanaVenues(web3, this.deps.rpc, this.deps.registry, this.now);
    const blockhash = await this.blockhash();
    const { plans, read } = await this.findPlans(web3, req, venues, blockhash);
    const chosen = plans[0]!;
    const slip = BigInt(request.slippageBps);
    const minOut = after(chosen.amountOut, slip);
    if (minOut <= 0n) throw new SwingsError('no-route', 'The route pays too little to set a minimum.');

    const legs = this.finalLegs(chosen, minOut, slip);
    if (legs.some((l) => l.minOut <= 0n)) throw new SwingsError('no-route', 'The route pays too little to set a minimum.');

    // The Aretia fee, taken in the same transaction: SOL for a swap that starts in SOL, otherwise USDC or USDT (paying with any other token carries no fee).
    const fee: SolanaRaw['fee'] = feePlan.state === 'ready' && feePlan.fee > 0n ? { amount: feePlan.fee, treasury: feePlan.treasury, mint: from.address, native: isWsol(from) } : undefined;

    const label = (p: Plan): string => (p.shape === 'direct' ? p.legs[0]!.venue.name : p.shape === 'two-hop' ? 'two hops' : 'split');
    const compared = plans.slice(0, 5).map((p) => `${label(p)} pays ${p.amountOut}`).join('; ') + (plans.length > 5 ? `; and ${plans.length - 5} more that pay less` : '');
    const fetchedAt = this.now();
    const raw: SolanaRaw = { shape: chosen.shape, legs, nativeIn: isWsol(from), nativeOut: isWsol(to), reasons: [`Compared: ${compared}.`, ...(read ? [`${read}.`] : []), ...chosen.reasons, ...(fee ? [`Aretia fee: ${fee.amount} (raw, ${FEE_PERCENT} of the amount entered) is sent to ${fee.treasury.slice(0, 6)}… in the same transaction, in ${fee.native ? 'SOL' : 'the stablecoin you are paying with'}.`] : [])], ...(fee ? { fee } : {}) };
    return {
      id: `aretia-sol:${fetchedAt}:${from.address.slice(0, 6)}:${to.address.slice(0, 6)}`,
      providerId: this.id,
      request: { ...req, amountIn: request.amountIn },
      inAmount: feePlan.net,
      expectedOut: chosen.amountOut,
      minOut,
      priceImpactBps: chosen.impactBps,
      route: { legs: chosen.legs.map((l) => ({ venue: l.venue.name, from: l.tokenIn, to: l.tokenOut, shareBps: chosen.shape === 'split' ? Number((l.amountIn * 10_000n) / feePlan.net) : 10_000 })) },
      costs: { network: null, provider: null, aretiaFee: fee ? { amount: fee.amount, asset: from } : { amount: 0n, asset: null } },
      fetchedAt,
      expiresAt: fetchedAt + SOLANA_QUOTE_TTL_MS,
      raw,
    };
  }

  private rawOf(l: Leg): LegRaw {
    return { entryId: l.venue.id, poolAddress: l.pool.ref.address, tokenIn: l.tokenIn.address, tokenOut: l.tokenOut.address, amountIn: l.amountIn, minOut: l.minOut, };
  }

  /**
   * Each leg's on-chain floor. Hop 1 must deliver at least what hop 2 sells; the last leg ends at the plan's minimum.
   * A split's legs each carry the same slippage on their own expected share, so the sum is never under the minimum.
   */
  private finalLegs(plan: Plan, minOut: bigint, slip: bigint): LegRaw[] {
    if (plan.shape === 'two-hop') return [{ ...this.rawOf(plan.legs[0]!), minOut: plan.legs[1]!.amountIn }, { ...this.rawOf(plan.legs[1]!), minOut }];
    if (plan.shape === 'split') return plan.legs.map((l, i) => ({ ...this.rawOf(l), minOut: after(plan.legOuts[i]!, slip) }));
    return [{ ...this.rawOf(plan.legs[0]!), minOut }];
  }

  /** Reads every pool of these legs again, now, and rebuilds the legs from what is on-chain at this moment. */
  private async restore(venues: SolanaVenue[], raw: LegRaw[]): Promise<Leg[]> {
    const legs: Leg[] = [];
    for (const l of raw) {
      const venue = venues.find((v) => v.id === l.entryId);
      const tokenIn: TokenRef = { chain: 'solana', address: l.tokenIn };
      const tokenOut: TokenRef = { chain: 'solana', address: l.tokenOut };
      const pool = venue ? (await this.track(venue.id, () => venue.getPools(tokenIn, tokenOut))).find((p) => p.ref.address === l.poolAddress && p.status === 'active') : undefined;
      if (!venue || !pool) throw new SwingsError('no-route', 'A pool in this quote is no longer available. Get a new quote.');
      legs.push({ venue, pool, tokenIn, tokenOut, amountIn: l.amountIn, minOut: l.minOut });
    }
    return legs;
  }

  // ------------------------------------------------------------------ building the real transaction

  async buildTransaction(quote: Quote): Promise<PreparedSwap> {
    if (quote.providerId !== this.id) throw new SwingsError('invalid', 'This quote was not made by the Aretia router.');
    if (this.now() >= quote.expiresAt) throw new SwingsError('expired', 'This quote has expired. Get a new one.');
    const raw = quote.raw as SolanaRaw;
    const { request } = quote;
    for (const l of raw.legs) {
      const st = this.deps.registry.effectiveStatus(l.entryId);
      if (st !== 'ACTIVE' && st !== 'DEGRADED') throw new SwingsError('not-enabled', `${this.deps.registry.get(l.entryId)?.name ?? l.entryId} is not accepting swaps right now.`);
    }
    const web3 = await this.deps.web3();
    const user = request.account.address;
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (raw.legs.some((l) => this.deps.registry.effectiveStatus(l.entryId) === 'DEGRADED')) warnings.push('A venue in this route has been unreliable recently.');
    const venues = createSolanaVenues(web3, this.deps.rpc, this.deps.registry, this.now);

    // 1. Read every pool in the route again, now, and rebuild the legs from what is on-chain at this moment.
    const mainLegs = await this.restore(venues, raw.legs);
    if (raw.shape === 'direct') {
      const l = mainLegs[0]!;
      if (l.venue.localQuote && l.venue.localQuote(l.pool, l.tokenIn, l.amountIn) < quote.minOut) blockers.push('The price has moved since the quote: the pool would now pay less than your minimum. Get a new quote.');
    }
    // A two-hop route sells at hop 2 a little less than hop 1 delivers. Prices move between the quote and now, so what
    // hop 1 delivers is measured again, on the programs, and hop 2 is sized from that. The final minimum is unchanged.
    if (raw.shape === 'two-hop' && mainLegs.length === 2) {
      try {
        const [first, second] = mainLegs as [Leg, Leg];
        const hub = first.tokenOut;
        const learned = await this.probe(web3, { ...request, amountIn: first.amountIn }, [{ ...first, minOut: 1n }, { ...second, amountIn: 1n, minOut: 1n }], await this.blockhash(), hub.address);
        if (learned.watched !== null) {
          const hop2In = after(learned.watched + 1n, HOP_BUFFER_BPS);
          if (hop2In > 0n) {
            first.minOut = hop2In;
            second.amountIn = hop2In;
          }
        }
      } catch {
        // Keep the quoted sizes: the whole transaction is still simulated below, and a bad fit blocks the swap.
      }
    }
    const legs = mainLegs;
    // What leaves the wallet in all: the amount swapped and the Aretia fee, taken from the amount the user entered.
    const totalIn = quote.inAmount + (raw.fee?.amount ?? 0n);
    if (raw.fee) warnings.push(`The Aretia fee of ${raw.fee.amount} (raw, ${FEE_PERCENT}) is taken from the amount you entered, in ${raw.fee.native ? 'SOL' : 'the stablecoin you are paying with'}, in this same transaction.`);

    // 2. wSOL handling: never close a wSOL account that already holds something.
    const wsolAccount = ataAddress(web3, user, WSOL_MINT, TOKEN_PROGRAM_ID);
    const wsol = await this.deps.rpc<{ value: { data: [string, string] } | null }>('getAccountInfo', [wsolAccount, { encoding: 'base64', commitment: 'confirmed' }]);
    const wsolHolds = wsol.value
      ? (() => {
          const d = Uint8Array.from(atob(wsol.value.data[0]), (c) => c.charCodeAt(0));
          return d.length >= 72 && new DataView(d.buffer).getBigUint64(64, true) > 0n;
        })()
      : false;
    const closeWsol = !wsolHolds;
    const outputIsNativeNow = raw.nativeOut && closeWsol;
    if (raw.nativeOut && wsolHolds) warnings.push('You already hold wrapped SOL, so the SOL you receive stays as wrapped SOL in that account instead of being unwrapped.');
    if (raw.shape === 'two-hop') warnings.push('This route has two swaps. A very small amount of the intermediate token can stay in your wallet.');
    if (raw.shape === 'split') warnings.push('This trade is split between two pools in a single transaction: both swaps happen together or not at all.');

    // Protected sending: the tip is part of the transaction the user signs, so the review screen shows it and nothing is taken later.
    const protect = request.execution?.protect === true;
    const tipLamports = protect ? checkTip(request.execution?.tipLamports ?? DEFAULT_TIP_LAMPORTS) : 0;
    if (protect) warnings.push(`Protected sending is on: this swap will be sent privately through Jito, with a tip of ${tipLamports} lamports (${tipLamports / 1e9} SOL). It lowers the chance of being sandwiched; it is not a guarantee.`);
    // The Aretia fee is one transfer, made before the swap: SOL straight to the fee address, or USDC or USDT into the fee
    // address's account for it (opened if it is new; the user pays its rent once).
    const fee = raw.fee;
    let prelude: RouteBuildOptions['prelude'];
    if (fee) {
      if (fee.native) {
        prelude = () => ({ ixs: [solTransferInstruction(web3, user, fee.treasury, fee.amount)], steps: [`Aretia fee: send ${fee.amount} lamports (${FEE_PERCENT}) to ${fee.treasury.slice(0, 6)}….`] });
      } else {
        const program = mainLegs[0]!.venue.programFor(mainLegs[0]!.pool, fee.mint);
        const decimals = await this.mintDecimals(fee.mint);
        prelude = (accounts) => {
          const dest = ataAddress(web3, fee.treasury, fee.mint, program);
          return {
            ixs: [createAtaIdempotentInstruction(web3, user, dest, fee.treasury, fee.mint, program), transferCheckedInstruction(web3, program, accounts[fee.mint]!, fee.mint, dest, user, fee.amount, decimals)],
            steps: [`Aretia fee: send ${fee.amount} (raw, ${FEE_PERCENT}) of the stablecoin you are paying with to ${fee.treasury.slice(0, 6)}… (you pay the new account's rent only if it is new).`],
          };
        };
      }
    }
    const built = await this.build(web3, user, legs, { nativeIn: raw.nativeIn, nativeOut: raw.nativeOut, closeWsol, ...(protect ? { tip: { account: pickTipAccount(), lamports: tipLamports } } : {}), ...(prelude ? { prelude } : {}) }, await this.blockhash());

    // 3. Run the exact transaction through the real programs and judge it by what it does to the wallet.
    if (blockers.length === 0) {
      const sim = await this.simulate(built, user, { nativeIn: raw.nativeIn, outputIsNative: outputIsNativeNow, amountIn: totalIn, minOut: quote.minOut });
      blockers.push(...sim.blockers);
      if (sim.opensOutputAccount) warnings.push('This swap opens a token account in your wallet, which costs a small amount of SOL.');
    }

    const payload: SolanaSwapPayload = { transaction: built.transaction, steps: built.steps, plannedAt: this.now(), ...(protect ? { protectedSubmission: { tipLamports } } : {}) };
    warnings.push(...built.steps.map((s) => `Transaction step: ${s}`));
    return { quoteId: quote.id, chain: 'solana', payload, simulation: { ok: blockers.length === 0, blockers, warnings }, preparedAt: this.now() };
  }
}
