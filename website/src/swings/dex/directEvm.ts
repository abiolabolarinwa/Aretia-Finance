/**
 * Aretia's own EVM swap provider. It reads pools straight from each venue's contracts, routes with Aretia's
 * routing engine (V2 pools) and the venues' own quoters (V3), builds the transaction itself, and checks it
 * against the venue's own router before the user is asked to sign. It is a DexProvider only so it can use the
 * existing confirmation, once-only execution and tracking path; no aggregator is involved anywhere in it.
 */
import type { EvmSwapPayload } from '../chains/evm.js';
import { encodeApprove } from '../chains/evm.js';
import type { EvmRead } from '../chains/evmSession.js';
import { normalizeTokenRef } from '../core/token.js';
import { CHAINS, EVM_NATIVE_ADDRESS, SwingsError, type ChainId, type DexProvider, type PreparedSwap, type Quote, type SwapRequest, type TokenRef } from '../core/types.js';
import { address, addressArray, decodeUintArray, encodeCall, uint, wordToBigInt, words } from '../engine/abi.js';
import type { ProviderHealth } from '../engine/health.js';
import { LiquidityStore } from '../engine/liquidity.js';
import type { AretiaDexRegistry, DexEntry } from '../engine/registry.js';
import { RoutingEngine, type EngineDeps } from '../engine/routing.js';
import { buildV2Swap, simulateV2Swap } from '../execution/evmV2Builder.js';
import { HUB_TOKENS } from './hubs.js';
import { EvmV2Adapter } from './evmV2.js';
import { buildV3Split, buildV3Swap, EvmV3Adapter, simulateV3Swap, type V3Route } from './evmV3.js';
import { buildAerodromeSwap, EvmAerodromeAdapter, type AeroHop } from './evmAerodrome.js';
import { buildBalancerSwap, EvmBalancerAdapter, simulateBalancerSwap, type BalancerStep } from './evmBalancer.js';
import { buildCurveSwap, EvmCurveAdapter } from './evmCurve.js';
import { buildLaunchpadSwap, launchpadAdapter } from './evmLaunchpad.js';

export const DIRECT_QUOTE_TTL_MS = 15_000;
const DEADLINE_SECONDS = 20 * 60;
/** Router and quote may differ by at most this much (basis points) before the user is told. */
const MAX_DISAGREEMENT_BPS = 1n;
/** A split is only tried when the best single pool loses at least this much to the trade's own size. */
const SPLIT_IMPACT_BPS = 30;
/** A split must beat the best single pool by at least this much to be worth a second leg. */
const SPLIT_MIN_GAIN_BPS = 10n;

export interface DirectEvmDeps {
  registry: AretiaDexRegistry;
  read: (chain: ChainId) => EvmRead;
  health?: ProviderHealth;
  now?: () => number;
  engine?: Partial<EngineDeps>;
  /** Extra intermediate tokens beyond the built-in hubs, for example from tests. */
  extraHubs?: (chain: ChainId) => string[];
}

interface DirectRaw {
  kind: 'v2' | 'v3' | 'aero' | 'balancer' | 'curve' | 'launchpad';
  entryId: string;
  /** Token addresses along the route. */
  path: string[];
  /** V3 only: the fee tier of each hop. */
  fees: number[];
  /** Aerodrome only: the pools (volatile or stable) of each hop. */
  aeroHops?: AeroHop[];
  /** Balancer only: the Vault steps and the asset list they index. */
  balancer?: { steps: BalancerStep[]; assets: string[] };
  /** Curve only: the pool and the coin indices. */
  curve?: { pool: string; i: number; j: number };
  /** V3 only: the trade divided between fee tiers of the same pair, one `exactInputSingle` each, in one multicall. */
  v3split?: { fee: number; amountIn: bigint; minOut: bigint }[];
  nativeIn: boolean;
  nativeOut: boolean;
  block: string;
  reasons: string[];
  impactBps: number | null;
}

interface Candidate {
  kind: 'v2' | 'v3' | 'aero' | 'balancer' | 'curve' | 'launchpad';
  aeroHops?: AeroHop[];
  balancer?: { steps: BalancerStep[]; assets: string[] };
  curve?: { pool: string; i: number; j: number };
  v3split?: { fee: number; amountIn: bigint; out: bigint }[];
  entryId: string;
  path: string[];
  fees: number[];
  amountOut: bigint;
  impactBps: number | null;
  reasons: string[];
}

const isNative = (t: TokenRef): boolean => t.address.toLowerCase() === EVM_NATIVE_ADDRESS;

export class DirectEvmProvider implements DexProvider {
  readonly id = 'aretia';
  readonly name = 'Aretia Router';
  private readonly now: () => number;

  constructor(private readonly deps: DirectEvmDeps) {
    this.now = deps.now ?? Date.now;
  }

  supports(chain: ChainId): boolean {
    return CHAINS[chain].kind === 'evm' && this.venues(chain).length > 0;
  }

  private venues(chain: ChainId): DexEntry[] {
    return this.deps.registry.routable(chain).filter((e) => e.mechanism === 'evm-v2-router' || e.mechanism === 'evm-v3-router' || e.mechanism === 'evm-aerodrome-router' || e.mechanism === 'evm-balancer-vault' || e.mechanism === 'evm-curve-pool' || e.mechanism === 'evm-launchpad-curve');
  }

  private track<T>(id: string, work: () => Promise<T>): Promise<T> {
    return this.deps.health ? this.deps.health.track(id, work) : work();
  }

  async getQuote(request: SwapRequest, signal?: AbortSignal): Promise<Quote> {
    const chain = request.chain;
    const info = CHAINS[chain];
    if (info.kind !== 'evm') throw new SwingsError('invalid', 'The Aretia EVM router only swaps on EVM chains.');
    const from = normalizeTokenRef(chain, request.from.address);
    const to = normalizeTokenRef(chain, request.to.address);
    if (!from || !to || from.address === to.address) throw new SwingsError('invalid', 'Choose two different, valid tokens on this network.');
    if (request.amountIn <= 0n) throw new SwingsError('invalid', 'Enter an amount above zero.');
    const venues = this.venues(chain);
    if (venues.length === 0) throw new SwingsError('no-route', `No ${info.name} venue is available right now.`);
    const wrapped = venues[0]!.wrappedNative!;
    const nativeIn = isNative(from);
    const nativeOut = isNative(to);
    const tokenIn: TokenRef = nativeIn ? { chain, address: wrapped } : from;
    const tokenOut: TokenRef = nativeOut ? { chain, address: wrapped } : to;
    if (tokenIn.address === tokenOut.address) throw new SwingsError('invalid', 'Wrapping and unwrapping is not a swap.');

    const read = this.deps.read(chain);
    const head = BigInt((await read('eth_blockNumber', [])) as string);
    if (signal?.aborted) throw new SwingsError('provider-failed', 'The request was cancelled.');
    const hubs = [...(HUB_TOKENS[chain] ?? []).map((h) => h.address), ...(this.deps.extraHubs?.(chain) ?? [])];
    const candidates = (await Promise.all([this.v2Candidate(venues, chain, tokenIn, tokenOut, request.amountIn, hubs, head, read), ...this.v3Candidates(venues, tokenIn, tokenOut, request.amountIn, hubs, head, read, nativeOut), ...this.aeroCandidates(venues, tokenIn, tokenOut, request.amountIn, hubs, head, read), ...this.balancerCandidates(venues, tokenIn, tokenOut, request.amountIn, head, read), ...this.curveCandidates(venues, tokenIn, tokenOut, request.amountIn, head, read, nativeIn || nativeOut), ...this.launchpadCandidates(venues, tokenIn, tokenOut, request.amountIn, head, read, nativeIn, nativeOut)])).flat().filter((c): c is Candidate => c !== null);
    if (candidates.length === 0) throw new SwingsError('no-route', 'No route was found through the venues Aretia reads directly.');

    // Most output wins; on a tie the route with fewer hops. The comparison is written into the reasoning.
    candidates.sort((a, b) => (a.amountOut !== b.amountOut ? (a.amountOut > b.amountOut ? -1 : 1) : a.path.length - b.path.length));
    const best = candidates[0]!;
    const comparison = candidates.map((c) => `${this.deps.registry.get(c.entryId)?.name ?? c.entryId} (${c.kind.toUpperCase()}, ${c.path.length - 1} hop${c.path.length === 2 ? '' : 's'}) pays ${c.amountOut}`).join('; ');
    const minOut = (best.amountOut * BigInt(10_000 - request.slippageBps)) / 10_000n;
    if (minOut <= 0n) throw new SwingsError('no-route', 'The route pays too little to set a minimum.');
    const fetchedAt = this.now();
    const slip = BigInt(request.slippageBps);
    const v3split = best.v3split?.map((l) => ({ fee: l.fee, amountIn: l.amountIn, minOut: (l.out * (10_000n - slip)) / 10_000n }));
    if (v3split?.some((l) => l.minOut <= 0n)) throw new SwingsError('no-route', 'The route pays too little to set a minimum.');
    const raw: DirectRaw = { kind: best.kind, entryId: best.entryId, path: best.path, fees: best.fees, aeroHops: best.aeroHops, balancer: best.balancer, curve: best.curve, ...(v3split ? { v3split } : {}), nativeIn, nativeOut, block: head.toString(), reasons: [`Compared: ${comparison}.`, ...best.reasons], impactBps: best.impactBps };
    const venueName = this.deps.registry.get(best.entryId)?.name ?? best.entryId;
    return {
      id: `aretia:${chain}:${fetchedAt}:${best.path[0]!.slice(2, 8)}:${best.path[best.path.length - 1]!.slice(2, 8)}`,
      providerId: this.id,
      request: { ...request, from, to },
      inAmount: request.amountIn,
      expectedOut: best.amountOut,
      minOut,
      priceImpactBps: best.impactBps,
      route: { legs: best.v3split ? best.v3split.map((l) => ({ venue: `${venueName} ${l.fee / 10_000}%`, from: { chain, address: best.path[0]! }, to: { chain, address: best.path[1]! }, shareBps: Number((l.amountIn * 10_000n) / request.amountIn) })) : best.path.slice(0, -1).map((token, i) => ({ venue: venueName, from: { chain, address: token }, to: { chain, address: best.path[i + 1]! }, shareBps: 10_000 })) },
      costs: { network: null, provider: null, aretiaBuyback: { amount: 0n, asset: null } },
      fetchedAt,
      expiresAt: fetchedAt + DIRECT_QUOTE_TTL_MS,
      raw,
    };
  }

  /** The best route across every V2 venue, found by Aretia's routing engine over pools it read itself. */
  private async v2Candidate(venues: DexEntry[], chain: ChainId, tokenIn: TokenRef, tokenOut: TokenRef, amountIn: bigint, hubs: string[], head: bigint, read: EvmRead): Promise<Candidate[]> {
    const v2 = venues.filter((e) => e.mechanism === 'evm-v2-router');
    if (v2.length === 0) return [];
    const tokens = [...new Set([tokenIn.address, tokenOut.address, ...hubs])].map((a) => ({ chain, address: a }));
    const store = new LiquidityStore(this.now);
    await Promise.all(
      v2.map(async (entry) => {
        const adapter = new EvmV2Adapter(entry, read, this.now);
        const reads: Promise<void>[] = [];
        for (let i = 0; i < tokens.length; i++) {
          for (let j = i + 1; j < tokens.length; j++) {
            reads.push(
              (async () => {
                try {
                  const pool = await this.track(entry.id, () => adapter.getPool(tokens[i]!, tokens[j]!, { block: head }));
                  if (pool && pool.status === 'active') store.put(pool);
                } catch {
                  // One pair failing must not stop the search; health records it.
                }
              })(),
            );
          }
        }
        await Promise.all(reads);
      }),
    );
    try {
      const engine = new RoutingEngine({ store, registry: this.deps.registry, now: this.now, ...this.deps.engine });
      const route = engine.routes({ tokenIn, tokenOut, amountIn, maxHops: 3, maxRoutes: 10, sameVenueOnly: true })[0];
      if (!route) return [];
      return [{ kind: 'v2', entryId: route.hops[0]!.pool.ref.dex, path: [route.hops[0]!.tokenIn.address, ...route.hops.map((h) => h.tokenOut.address)], fees: [], amountOut: route.amountOut, impactBps: route.priceImpactBps, reasons: route.reasons }];
    } catch (e) {
      if (e instanceof SwingsError && e.code === 'no-route') return [];
      throw e;
    }
  }

  /** Bonding-curve launchpads: only a swap between the native coin and a token still on its curve, priced by the launchpad itself. */
  private launchpadCandidates(venues: DexEntry[], tokenIn: TokenRef, tokenOut: TokenRef, amountIn: bigint, head: bigint, read: EvmRead, nativeIn: boolean, nativeOut: boolean): Promise<Candidate[]>[] {
    if (!nativeIn && !nativeOut) return [];
    return venues
      .filter((e) => e.mechanism === 'evm-launchpad-curve')
      .map(async (entry): Promise<Candidate[]> => {
        try {
          const adapter = launchpadAdapter(entry, read);
          const route = await this.track(entry.id, () => adapter.bestRoute(tokenIn.address, tokenOut.address, amountIn, head));
          if (!route) return [];
          // How far this trade moves the price: its rate against a trade 1/100th its size.
          let impactBps: number | null = null;
          if (amountIn >= 100n) {
            const small = await adapter.bestRoute(tokenIn.address, tokenOut.address, amountIn / 100n, head).catch(() => null);
            if (small && small.amountOut > 0n) {
              const ideal = small.amountOut * 100n;
              impactBps = ideal > route.amountOut ? Number(((ideal - route.amountOut) * 10_000n) / ideal) : 0;
            }
          }
          return [{ kind: 'launchpad', entryId: entry.id, path: [tokenIn.address, tokenOut.address], fees: [], amountOut: route.amountOut, impactBps, reasons: [`${entry.name} bonding curve, priced by the launchpad's own contract at block ${head}. The token is still on its curve, not yet on a DEX.`] }];
        } catch {
          return [];
        }
      });
  }

  /** The best pool each Curve venue offers, priced by the pool itself. Token-to-token only: these pools hold ERC-20 coins. */
  private curveCandidates(venues: DexEntry[], tokenIn: TokenRef, tokenOut: TokenRef, amountIn: bigint, head: bigint, read: EvmRead, usesNative: boolean): Promise<Candidate[]>[] {
    if (usesNative) return [];
    return venues
      .filter((e) => e.mechanism === 'evm-curve-pool')
      .map(async (entry): Promise<Candidate[]> => {
        try {
          const adapter = new EvmCurveAdapter(entry, read);
          const route = await this.track(entry.id, () => adapter.bestRoute(tokenIn.address, tokenOut.address, amountIn, head));
          if (!route) return [];
          let impactBps: number | null = null;
          if (amountIn >= 100n) {
            const small = await adapter.quote(route.pool, route.i, route.j, amountIn / 100n, head);
            if (small && small > 0n) {
              const ideal = small * 100n;
              impactBps = ideal > route.amountOut ? Number(((ideal - route.amountOut) * 10_000n) / ideal) : 0;
            }
          }
          return [{ kind: 'curve', entryId: entry.id, path: [tokenIn.address, tokenOut.address], fees: [], curve: { pool: route.pool, i: route.i, j: route.j }, amountOut: route.amountOut, impactBps, reasons: [`${entry.name} pool ${route.pool.slice(0, 8)}… priced by the pool itself at block ${head}.`] }];
        } catch {
          return [];
        }
      });
  }

  /** The best route each Balancer venue offers through its curated pools, priced by the Vault itself. */
  private balancerCandidates(venues: DexEntry[], tokenIn: TokenRef, tokenOut: TokenRef, amountIn: bigint, head: bigint, read: EvmRead): Promise<Candidate[]>[] {
    return venues
      .filter((e) => e.mechanism === 'evm-balancer-vault')
      .map(async (entry): Promise<Candidate[]> => {
        try {
          const adapter = new EvmBalancerAdapter(entry, read);
          const route = await this.track(entry.id, () => adapter.bestRoute(tokenIn.address, tokenOut.address, amountIn, head));
          if (!route) return [];
          let impactBps: number | null = null;
          if (amountIn >= 100n) {
            const small = await adapter.quote(route.steps, route.assets, amountIn / 100n, head);
            if (small && small > 0n) {
              const ideal = small * 100n;
              impactBps = ideal > route.amountOut ? Number(((ideal - route.amountOut) * 10_000n) / ideal) : 0;
            }
          }
          const path = [route.assets[route.steps[0]!.assetIn]!, ...route.steps.map((s) => route.assets[s.assetOut]!)];
          return [{ kind: 'balancer', entryId: entry.id, path, fees: [], balancer: { steps: route.steps, assets: route.assets }, amountOut: route.amountOut, impactBps, reasons: [`${entry.name} priced by its own Vault at block ${head} through ${route.steps.length} pool${route.steps.length === 1 ? '' : 's'}.`] }];
        } catch {
          return [];
        }
      });
  }

  /** The best route each Aerodrome-style venue offers, priced by its own router. */
  private aeroCandidates(venues: DexEntry[], tokenIn: TokenRef, tokenOut: TokenRef, amountIn: bigint, hubs: string[], head: bigint, read: EvmRead): Promise<Candidate[]>[] {
    return venues
      .filter((e) => e.mechanism === 'evm-aerodrome-router')
      .map(async (entry): Promise<Candidate[]> => {
        try {
          const adapter = new EvmAerodromeAdapter(entry, read);
          const route = await this.track(entry.id, () => adapter.bestRoute(tokenIn.address, tokenOut.address, amountIn, hubs, head));
          if (!route) return [];
          let impactBps: number | null = null;
          if (amountIn >= 100n) {
            const small = await adapter.quote(route.hops, amountIn / 100n, head);
            if (small && small > 0n) {
              const ideal = small * 100n;
              impactBps = ideal > route.amountOut ? Number(((ideal - route.amountOut) * 10_000n) / ideal) : 0;
            }
          }
          const path = [route.hops[0]!.from, ...route.hops.map((h) => h.to)];
          return [{ kind: 'aero', entryId: entry.id, path, fees: [], aeroHops: route.hops, amountOut: route.amountOut, impactBps, reasons: [`${entry.name} priced by its own router at block ${head} (${route.hops.map((h) => (h.stable ? 'stable' : 'volatile')).join(', ')} pool${route.hops.length === 1 ? '' : 's'}).`] }];
        } catch {
          return [];
        }
      });
  }

  /** The trade divided between the two best fee tiers of the pair, each priced by the quoter; null unless it beats the single pool by enough. */
  private async v3Split(adapter: EvmV3Adapter, entry: DexEntry, route: V3Route, amountIn: bigint, head: bigint): Promise<Candidate | null> {
    const [a, b] = [route.tokens[0]!, route.tokens[1]!];
    const tiers = await adapter.tierQuotes(a, b, amountIn, head);
    if (tiers.length < 2) return null;
    const [x, y] = [tiers[0]!, tiers[1]!];
    let best: { legs: { fee: number; amountIn: bigint; out: bigint }[]; total: bigint } | null = null;
    for (const shareX of [7_000n, 5_000n]) {
      const amountX = (amountIn * shareX) / 10_000n;
      const amountY = amountIn - amountX;
      if (amountX <= 0n || amountY <= 0n) continue;
      const [qx, qy] = await Promise.all([adapter.quotePath([a, b], [x.fees[0]!], amountX, head), adapter.quotePath([a, b], [y.fees[0]!], amountY, head)]);
      if (!qx || !qy) continue;
      const total = qx.amountOut + qy.amountOut;
      if (!best || total > best.total) best = { legs: [{ fee: x.fees[0]!, amountIn: amountX, out: qx.amountOut }, { fee: y.fees[0]!, amountIn: amountY, out: qy.amountOut }], total };
    }
    if (!best || best.total <= route.amountOut || ((best.total - route.amountOut) * 10_000n) / route.amountOut < SPLIT_MIN_GAIN_BPS) return null;
    return { kind: 'v3', entryId: entry.id, path: [a, b], fees: [best.legs[0]!.fee], v3split: best.legs, amountOut: best.total, impactBps: null, reasons: [`${entry.name}: split between the ${best.legs[0]!.fee / 10_000}% and ${best.legs[1]!.fee / 10_000}% pools of the pair (${Number((best.legs[0]!.amountIn * 100n) / amountIn)}% / ${100 - Number((best.legs[0]!.amountIn * 100n) / amountIn)}%), each priced by the venue's own quoter at block ${head}, in one multicall so both fill or neither does.`] };
  }

  /** The best route each V3 venue offers, from the venue's own quoter. V3 output cannot be the native coin in this version. */
  private v3Candidates(venues: DexEntry[], tokenIn: TokenRef, tokenOut: TokenRef, amountIn: bigint, hubs: string[], head: bigint, read: EvmRead, nativeOut: boolean): Promise<Candidate[]>[] {
    if (nativeOut) return [];
    return venues
      .filter((e) => e.mechanism === 'evm-v3-router')
      .map(async (entry): Promise<Candidate[]> => {
        try {
          const adapter = new EvmV3Adapter(entry, read);
          const route = await this.track(entry.id, () => adapter.bestRoute(tokenIn.address, tokenOut.address, amountIn, hubs, head));
          if (!route) return [];
          // How far this trade moves the price: its rate against the rate of a trade 1/100th its size on the same path.
          let impactBps: number | null = null;
          if (amountIn >= 100n) {
            const small = await adapter.quotePath(route.tokens, route.fees, amountIn / 100n, head).catch(() => null);
            const single = route.tokens.length === 2 && small === null ? await adapter.bestRoute(route.tokens[0]!, route.tokens[1]!, amountIn / 100n, [], head).catch(() => null) : null;
            const ref = small ?? (single && single.fees[0] === route.fees[0] ? single : null);
            if (ref && ref.amountOut > 0n) {
              const ideal = ref.amountOut * 100n;
              impactBps = ideal > route.amountOut ? Number(((ideal - route.amountOut) * 10_000n) / ideal) : 0;
            }
          }
          const single: Candidate = { kind: 'v3', entryId: entry.id, path: route.tokens, fees: route.fees, amountOut: route.amountOut, impactBps, reasons: [`${entry.name} quoted by the venue's own on-chain quoter at block ${head}; fee tier${route.fees.length > 1 ? 's' : ''} ${route.fees.map((f) => f / 10_000 + '%').join(' then ')}.`] };
          const split = route.tokens.length === 2 && impactBps !== null && impactBps >= SPLIT_IMPACT_BPS ? await this.v3Split(adapter, entry, route, amountIn, head).catch(() => null) : null;
          return split ? [single, split] : [single];
        } catch {
          return [];
        }
      });
  }

  async buildTransaction(quote: Quote): Promise<PreparedSwap> {
    if (quote.providerId !== this.id) throw new SwingsError('invalid', 'This quote was not made by the Aretia router.');
    if (this.now() >= quote.expiresAt) throw new SwingsError('expired', 'This quote has expired. Get a new one.');
    const { request } = quote;
    const chain = request.chain;
    const info = CHAINS[chain];
    const raw = quote.raw as DirectRaw;
    const entry = this.deps.registry.get(raw.entryId);
    if (!entry || entry.chain !== chain || (!entry.router && entry.mechanism !== 'evm-curve-pool')) throw new SwingsError('invalid', 'The venue for this quote is no longer available.');
    const status = this.deps.registry.effectiveStatus(entry.id);
    if (status !== 'ACTIVE' && status !== 'DEGRADED') throw new SwingsError('not-enabled', `${entry.name} is not accepting swaps right now.`);
    if (info.evmChainId === null) throw new SwingsError('invalid', 'Not an EVM chain.');

    const read = this.deps.read(chain);
    const taker = request.account.address.toLowerCase();
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (status === 'DEGRADED') warnings.push(`${entry.name} has been unreliable recently.`);

    const deadline = Math.floor(this.now() / 1000) + DEADLINE_SECONDS;
    const plan =
      raw.kind === 'launchpad'
        ? buildLaunchpadSwap(entry, { token: raw.nativeIn ? raw.path[1]! : raw.path[0]!, buying: raw.nativeIn, amountIn: quote.inAmount, minOut: quote.minOut })
        : raw.kind === 'curve'
        ? buildCurveSwap(entry, { pool: raw.curve?.pool ?? '', i: raw.curve?.i ?? -1, j: raw.curve?.j ?? -1, tokenIn: raw.path[0]!, amountIn: quote.inAmount, minOut: quote.minOut })
        : raw.kind === 'balancer'
        ? buildBalancerSwap(entry, { steps: raw.balancer?.steps ?? [], assets: raw.balancer?.assets ?? [], amountIn: quote.inAmount, minOut: quote.minOut, recipient: taker, deadline, nativeIn: raw.nativeIn, nativeOut: raw.nativeOut }, Math.floor(this.now() / 1000))
        : raw.kind === 'aero'
        ? buildAerodromeSwap(entry, { hops: raw.aeroHops ?? [], amountIn: quote.inAmount, minOut: quote.minOut, recipient: taker, deadline, nativeIn: raw.nativeIn, nativeOut: raw.nativeOut }, Math.floor(this.now() / 1000))
        : raw.kind === 'v3' && raw.v3split
        ? buildV3Split(entry, { tokenIn: raw.path[0]!, tokenOut: raw.path[1]!, legs: raw.v3split, recipient: taker, deadline, nativeIn: raw.nativeIn }, Math.floor(this.now() / 1000))
        : raw.kind === 'v3'
        ? buildV3Swap(entry, { tokens: raw.path, fees: raw.fees, amountIn: quote.inAmount, minOut: quote.minOut, recipient: taker, deadline, nativeIn: raw.nativeIn }, Math.floor(this.now() / 1000))
        : buildV2Swap(entry, { path: raw.path, amountIn: quote.inAmount, minOut: quote.minOut, recipient: taker, deadline, nativeIn: raw.nativeIn, nativeOut: raw.nativeOut }, Math.floor(this.now() / 1000));

    // 1. Ask the venue itself what it would pay right now. This is the check that Aretia's numbers and the chain agree.
    let venueOut: bigint | null;
    try {
      if (raw.kind === 'v3' && raw.v3split) {
        const adapter = new EvmV3Adapter(entry, read);
        const legs = await Promise.all(raw.v3split.map((l) => adapter.quotePath(raw.path, [l.fee], l.amountIn)));
        venueOut = legs.every((l) => l !== null) ? legs.reduce((n, l) => n + l!.amountOut, 0n) : null;
      } else if (raw.kind === 'v3') venueOut = (await new EvmV3Adapter(entry, read).quotePath(raw.path, raw.fees, quote.inAmount))?.amountOut ?? null;
      else if (raw.kind === 'aero') venueOut = await new EvmAerodromeAdapter(entry, read).quote(raw.aeroHops ?? [], quote.inAmount);
      else if (raw.kind === 'launchpad') {
        const fm = launchpadAdapter(entry, read);
        const q = raw.nativeIn ? await fm.quoteBuy(raw.path[1]!, quote.inAmount) : await fm.quoteSell(raw.path[0]!, quote.inAmount);
        venueOut = q?.amountOut ?? null;
      } else if (raw.kind === 'curve') venueOut = raw.curve ? await new EvmCurveAdapter(entry, read).quote(raw.curve.pool, raw.curve.i, raw.curve.j, quote.inAmount) : null;
      else if (raw.kind === 'balancer') venueOut = raw.balancer ? await new EvmBalancerAdapter(entry, read).quote(raw.balancer.steps, raw.balancer.assets, quote.inAmount) : null;
      else {
        const out = (await read('eth_call', [{ to: entry.router, data: encodeCall('getAmountsOut(uint256,address[])', [uint(quote.inAmount), addressArray(raw.path)]) }, 'latest'])) as string;
        const amounts = decodeUintArray(out);
        venueOut = amounts[amounts.length - 1] ?? null;
      }
    } catch {
      venueOut = null;
    }
    if (venueOut === null) blockers.push(`${entry.name} could not price this route right now.`);
    else {
      if (venueOut < quote.minOut) blockers.push('The price has moved since the quote: the venue would now pay less than your minimum. Get a new quote.');
      const diff = venueOut > quote.expectedOut ? venueOut - quote.expectedOut : quote.expectedOut - venueOut;
      if (quote.expectedOut > 0n && (diff * 10_000n) / quote.expectedOut > MAX_DISAGREEMENT_BPS && venueOut >= quote.minOut) {
        warnings.push(`The venue's price differs from the quote by ${Number((diff * 10_000n) / quote.expectedOut) / 100}%; the minimum you set still protects you.`);
      }
    }

    // 2. Balance and allowance, so the user is not asked to sign something that cannot work.
    let approval: EvmSwapPayload['approval'] = null;
    let needsApproval = false;
    if (!raw.nativeIn) {
      const token = raw.path[0]!;
      try {
        const bal = wordToBigInt(words((await read('eth_call', [{ to: token, data: encodeCall('balanceOf(address)', [address(taker)]) }, 'latest'])) as string)[0] ?? '0');
        if (bal < quote.inAmount) blockers.push('Your balance is too low for this swap.');
        // The spender is whatever the built transaction needs approved: the router, the Vault, or a Curve pool.
        const spender = plan.approval?.spender ?? entry.router!;
        const allowance = wordToBigInt(words((await read('eth_call', [{ to: token, data: encodeCall('allowance(address,address)', [address(taker), address(spender)]) }, 'latest'])) as string)[0] ?? '0');
        if (allowance < quote.inAmount) {
          needsApproval = true;
          approval = { tx: { from: taker, to: token, data: encodeApprove(spender, quote.inAmount) }, token, spender, amount: quote.inAmount };
          warnings.push('This swap needs a one-time approval for exactly the amount you are selling. Your wallet will ask twice: approval first, then the swap.');
        }
      } catch {
        blockers.push('Your token balance could not be read, so the swap could not be checked.');
      }
    } else {
      try {
        const nativeBal = BigInt((await read('eth_getBalance', [taker, 'latest'])) as string);
        if (nativeBal < quote.inAmount) blockers.push(`Your ${info.nativeSymbol} balance is too low for this swap.`);
      } catch {
        blockers.push('Your balance could not be read, so the swap could not be checked.');
      }
    }

    // 3. Simulate the exact transaction against the real router. With a pending approval it cannot succeed yet.
    if (needsApproval) warnings.push('The swap itself can only be simulated after the approval is mined.');
    else if (blockers.length === 0) {
      if (raw.kind === 'launchpad') {
        // The launchpad enforces the floor itself and reverts with a plain reason, so success is "did not revert".
        try {
          await read('eth_call', [{ from: taker, to: plan.to, data: plan.data, value: '0x' + plan.value.toString(16) }, 'latest']);
        } catch (e) {
          blockers.push(`The network would reject this swap: ${e instanceof Error ? e.message.slice(0, 200) : 'simulation failed'}`);
        }
      } else if (raw.kind === 'curve') {
        // Curve pools return nothing on older pools, so success is simply "did not revert". The pool enforces the floor itself.
        try {
          await read('eth_call', [{ from: taker, to: plan.to, data: plan.data, value: '0x0' }, 'latest']);
        } catch (e) {
          blockers.push(`The network would reject this swap: ${e instanceof Error ? e.message.slice(0, 200) : 'simulation failed'}`);
        }
      } else if (raw.kind === 'balancer') {
        const sim = await simulateBalancerSwap(read, plan, taker, raw.balancer?.steps[raw.balancer.steps.length - 1]?.assetOut ?? 1);
        if (!sim.ok) blockers.push(`The network would reject this swap: ${sim.error ?? 'simulation failed'}`);
        else if (sim.amountOut !== null && sim.amountOut < quote.minOut) blockers.push('The simulation shows the swap paying less than your minimum. It was blocked.');
      } else if (raw.kind === 'v3') {
        const sim = await simulateV3Swap(read, plan, taker);
        if (!sim.ok) blockers.push(`The network would reject this swap: ${sim.error ?? 'simulation failed'}`);
        else if (sim.amountOut !== null && sim.amountOut < quote.minOut) blockers.push('The simulation shows the swap paying less than your minimum. It was blocked.');
      } else {
        const sim = await simulateV2Swap(read, plan, taker);
        if (!sim.ok) blockers.push(`The network would reject this swap: ${sim.error ?? 'simulation failed'}`);
      }
    }

    const payload: EvmSwapPayload = { chainId: info.evmChainId, taker, approval, swap: { from: taker, to: plan.to, data: plan.data, value: '0x' + plan.value.toString(16) } };
    return { quoteId: quote.id, chain, payload, simulation: { ok: blockers.length === 0, blockers, warnings }, preparedAt: this.now() };
  }
}
