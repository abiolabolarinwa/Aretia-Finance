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
import { buildV3Swap, EvmV3Adapter, simulateV3Swap } from './evmV3.js';

export const DIRECT_QUOTE_TTL_MS = 15_000;
const DEADLINE_SECONDS = 20 * 60;
/** Router and quote may differ by at most this much (basis points) before the user is told. */
const MAX_DISAGREEMENT_BPS = 1n;

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
  kind: 'v2' | 'v3';
  entryId: string;
  /** Token addresses along the route. */
  path: string[];
  /** V3 only: the fee tier of each hop. */
  fees: number[];
  nativeIn: boolean;
  nativeOut: boolean;
  block: string;
  reasons: string[];
  impactBps: number | null;
}

interface Candidate {
  kind: 'v2' | 'v3';
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
    return this.deps.registry.routable(chain).filter((e) => e.mechanism === 'evm-v2-router' || e.mechanism === 'evm-v3-router');
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
    const candidates = (await Promise.all([this.v2Candidate(venues, chain, tokenIn, tokenOut, request.amountIn, hubs, head, read), ...this.v3Candidates(venues, tokenIn, tokenOut, request.amountIn, hubs, head, read, nativeOut)])).flat().filter((c): c is Candidate => c !== null);
    if (candidates.length === 0) throw new SwingsError('no-route', 'No route was found through the venues Aretia reads directly.');

    // Most output wins; on a tie the route with fewer hops. The comparison is written into the reasoning.
    candidates.sort((a, b) => (a.amountOut !== b.amountOut ? (a.amountOut > b.amountOut ? -1 : 1) : a.path.length - b.path.length));
    const best = candidates[0]!;
    const comparison = candidates.map((c) => `${this.deps.registry.get(c.entryId)?.name ?? c.entryId} (${c.kind.toUpperCase()}, ${c.path.length - 1} hop${c.path.length === 2 ? '' : 's'}) pays ${c.amountOut}`).join('; ');
    const minOut = (best.amountOut * BigInt(10_000 - request.slippageBps)) / 10_000n;
    if (minOut <= 0n) throw new SwingsError('no-route', 'The route pays too little to set a minimum.');
    const fetchedAt = this.now();
    const raw: DirectRaw = { kind: best.kind, entryId: best.entryId, path: best.path, fees: best.fees, nativeIn, nativeOut, block: head.toString(), reasons: [`Compared: ${comparison}.`, ...best.reasons], impactBps: best.impactBps };
    const venueName = this.deps.registry.get(best.entryId)?.name ?? best.entryId;
    return {
      id: `aretia:${chain}:${fetchedAt}:${best.path[0]!.slice(2, 8)}:${best.path[best.path.length - 1]!.slice(2, 8)}`,
      providerId: this.id,
      request: { ...request, from, to },
      inAmount: request.amountIn,
      expectedOut: best.amountOut,
      minOut,
      priceImpactBps: best.impactBps,
      route: { legs: best.path.slice(0, -1).map((token, i) => ({ venue: venueName, from: { chain, address: token }, to: { chain, address: best.path[i + 1]! }, shareBps: 10_000 })) },
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
          return [{ kind: 'v3', entryId: entry.id, path: route.tokens, fees: route.fees, amountOut: route.amountOut, impactBps, reasons: [`${entry.name} quoted by the venue's own on-chain quoter at block ${head}; fee tier${route.fees.length > 1 ? 's' : ''} ${route.fees.map((f) => f / 10_000 + '%').join(' then ')}.`] }];
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
    if (!entry || entry.chain !== chain || !entry.router) throw new SwingsError('invalid', 'The venue for this quote is no longer available.');
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
      raw.kind === 'v3'
        ? buildV3Swap(entry, { tokens: raw.path, fees: raw.fees, amountIn: quote.inAmount, minOut: quote.minOut, recipient: taker, deadline, nativeIn: raw.nativeIn }, Math.floor(this.now() / 1000))
        : buildV2Swap(entry, { path: raw.path, amountIn: quote.inAmount, minOut: quote.minOut, recipient: taker, deadline, nativeIn: raw.nativeIn, nativeOut: raw.nativeOut }, Math.floor(this.now() / 1000));

    // 1. Ask the venue itself what it would pay right now. This is the check that Aretia's numbers and the chain agree.
    let venueOut: bigint | null;
    try {
      if (raw.kind === 'v3') venueOut = (await new EvmV3Adapter(entry, read).quotePath(raw.path, raw.fees, quote.inAmount))?.amountOut ?? null;
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
        const allowance = wordToBigInt(words((await read('eth_call', [{ to: token, data: encodeCall('allowance(address,address)', [address(taker), address(entry.router)]) }, 'latest'])) as string)[0] ?? '0');
        if (allowance < quote.inAmount) {
          needsApproval = true;
          approval = { tx: { from: taker, to: token, data: encodeApprove(entry.router, quote.inAmount) }, token, spender: entry.router, amount: quote.inAmount };
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
      if (raw.kind === 'v3') {
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
