/**
 * Routes that need a middle token: a launchpad token (a Virtuals agent token, an Arena token) trades against the launchpad's own
 * token (VIRTUAL, ARENA), not against ETH or AVAX. So buying one with ETH is two swaps, ETH for VIRTUAL and then VIRTUAL for the
 * token, and selling one for ETH is the same two in the other order.
 *
 * The two swaps cannot be one transaction (no contract Aretia can trust sits between a DEX and a launchpad), so this is two,
 * presented as one quote and one review:
 *  - the first is built and checked like any swap, and carries the whole Aretia fee (it is taken from the amount entered);
 *  - the second is built only after the first is confirmed, from what actually arrived, so it never guesses an amount, and it
 *    carries no second fee;
 *  - the minimum the user is shown covers both steps (each step gets half of the slippage the user chose, so together they never
 *    accept more than the user did), and the second step is refused if the price has moved so far that it could not honour it;
 *  - if the second step cannot go ahead, the user is told plainly that they now hold the middle token, which is theirs.
 * The executor (EvmChainAdapter) runs the steps in order and waits for the first to be confirmed before asking for the second.
 */
import { isEvmPayload, type EvmSwapPayload } from '../chains/evm.js';
import type { EvmRead } from '../chains/evmSession.js';
import { CHAINS, SwingsError, type ChainId, type DexProvider, type PreparedSwap, type Quote, type RouteLeg, type SwapRequest, type TokenRef } from '../core/types.js';
import { address, encodeCall, wordToBigInt, words } from '../engine/abi.js';
import type { AretiaDexRegistry, DexEntry } from '../engine/registry.js';
import { launchpadAdapter } from './evmLaunchpad.js';

export const CHAIN_QUOTE_TTL_MS = 12_000;
/** How much more than the first step was expected to deliver the second step may use, to allow for drift in the balance read. */
const RECEIVED_CAP_NUM = 105n;

export interface ChainedEvmDeps {
  /** The provider for the first step. It collects the Aretia fee. */
  first: DexProvider;
  /** The provider for the second step. It must NOT collect the fee: the first step already did. */
  second: DexProvider;
  registry: AretiaDexRegistry;
  read: (chain: ChainId) => EvmRead;
  now?: () => number;
}

interface ChainedRaw {
  first: Quote;
  hub: TokenRef;
  /** The second step as it looked when the quote was made, for the minimum the user was shown. */
  secondMin: Quote;
  reasons: string[];
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export class ChainedEvmProvider implements DexProvider {
  readonly id = 'aretia-chain';
  readonly name = 'Aretia Router (two steps)';
  readonly carriesAretiaFee: boolean;
  private readonly now: () => number;

  constructor(private readonly deps: ChainedEvmDeps) {
    this.now = deps.now ?? Date.now;
    this.carriesAretiaFee = deps.first.carriesAretiaFee === true;
  }

  supports(chain: ChainId): boolean {
    return CHAINS[chain].kind === 'evm' && this.launchpads(chain).length > 0;
  }

  /** The launchpads on a chain whose curves are priced in a token (so a trade against the native coin needs a middle step). */
  private launchpads(chain: ChainId): DexEntry[] {
    return this.deps.registry.routable(chain).filter((e) => e.mechanism === 'evm-launchpad-curve' && !!e.quoteAsset);
  }

  async getQuote(request: SwapRequest, signal?: AbortSignal): Promise<Quote> {
    const chain = request.chain;
    if (CHAINS[chain].kind !== 'evm') throw new SwingsError('invalid', 'This router only swaps on EVM chains.');
    if (request.amountIn <= 0n) throw new SwingsError('invalid', 'Enter an amount above zero.');
    const read = this.deps.read(chain);
    // Two steps compound their slippage, so each gets half of what the user chose: together they never accept more than the user did.
    const stepSlippage = Math.ceil(request.slippageBps / 2);
    const failures: string[] = [];
    for (const entry of this.launchpads(chain)) {
      const hub = entry.quoteAsset!.toLowerCase();
      // A route that already starts or ends in the middle token is a single swap, handled elsewhere.
      if (same(request.from.address, hub) || same(request.to.address, hub)) continue;
      const adapter = launchpadAdapter(entry, read);
      // Only when the launchpad really has the token on its curve: one cheap read each way.
      const buying = (await adapter.quoteBuy(request.to.address, 10n ** 18n).catch(() => null)) ?? (await adapter.quoteBuy(request.to.address, 10n ** 21n).catch(() => null));
      const selling = buying ? null : await adapter.quoteSell(request.from.address, 10n ** 18n).catch(() => null);
      if (!buying && !selling) continue;
      const hubRef: TokenRef = { chain, address: hub };
      try {
        const first = await this.deps.first.getQuote({ ...request, to: hubRef, slippageBps: stepSlippage }, signal);
        const secondExpected = await this.deps.second.getQuote({ ...request, from: hubRef, amountIn: first.expectedOut, slippageBps: stepSlippage }, signal);
        const secondMin = await this.deps.second.getQuote({ ...request, from: hubRef, amountIn: first.minOut, slippageBps: stepSlippage }, signal);
        const fetchedAt = this.now();
        const legs: RouteLeg[] = [...first.route.legs, ...secondExpected.route.legs];
        const raw: ChainedRaw = {
          first,
          hub: hubRef,
          secondMin,
          reasons: [`Two steps through ${entry.name}'s own token: the first swaps your coin for it, the second swaps it for the result. ${first.providerId === 'aretia' ? 'Both steps are Aretia routes.' : ''}`.trim(), ...((first.raw as { reasons?: string[] } | null)?.reasons ?? []).map((r) => `Step 1: ${r}`), ...((secondExpected.raw as { reasons?: string[] } | null)?.reasons ?? []).map((r) => `Step 2: ${r}`)],
        };
        return {
          id: `aretia-chain:${chain}:${fetchedAt}:${request.from.address.slice(2, 8)}:${request.to.address.slice(2, 8)}`,
          providerId: this.id,
          request,
          inAmount: first.inAmount,
          expectedOut: secondExpected.expectedOut,
          minOut: secondMin.minOut,
          priceImpactBps: first.priceImpactBps !== null && secondExpected.priceImpactBps !== null ? Math.max(first.priceImpactBps, secondExpected.priceImpactBps) : null,
          route: { legs },
          costs: { network: null, provider: null, aretiaFee: first.costs.aretiaFee },
          fetchedAt,
          expiresAt: Math.min(fetchedAt + CHAIN_QUOTE_TTL_MS, first.expiresAt),
          raw,
        };
      } catch (e) {
        failures.push(e instanceof Error ? e.message : 'A step could not be priced.');
      }
    }
    throw new SwingsError('no-route', failures[0] ?? 'No route through a launchpad token was found.');
  }

  async buildTransaction(quote: Quote): Promise<PreparedSwap> {
    if (quote.providerId !== this.id) throw new SwingsError('invalid', 'This quote was not made by the two-step router.');
    if (this.now() >= quote.expiresAt) throw new SwingsError('expired', 'This quote has expired. Get a new one.');
    const raw = quote.raw as ChainedRaw;
    const { request } = quote;
    const chain = request.chain;
    const prepared = await this.deps.first.buildTransaction(raw.first);
    if (!isEvmPayload(prepared.payload)) throw new SwingsError('invalid', 'The first step is not an EVM transaction.');
    const read = this.deps.read(chain);
    const taker = request.account.address.toLowerCase();
    const balanceOf = async (): Promise<bigint> => wordToBigInt(words((await read('eth_call', [{ to: raw.hub.address, data: encodeCall('balanceOf(address)', [address(taker)]) }, 'latest'])) as string)[0] ?? '0');
    // What is held before the first step, so what the first step delivers is measured, not assumed.
    const before = await balanceOf();
    const hubName = raw.hub.address.slice(0, 6);

    const nextStep = async (): Promise<EvmSwapPayload> => {
      const after = await balanceOf();
      let received = after - before;
      if (received <= 0n) throw new SwingsError('failed', 'Nothing arrived from the first step.');
      const cap = (raw.first.expectedOut * RECEIVED_CAP_NUM) / 100n;
      if (received > cap) received = cap;
      const second = await this.deps.second.getQuote({ ...request, from: raw.hub, amountIn: received, slippageBps: Math.ceil(request.slippageBps / 2) });
      // The minimum the user was shown covers both steps: refuse the second if it could no longer honour it.
      if (second.minOut < quote.minOut) throw new SwingsError('failed', 'The price moved against you between the two steps, so the second step could not keep the minimum you were shown.');
      const next = await this.deps.second.buildTransaction(second);
      if (!next.simulation.ok) throw new SwingsError('simulation-failed', next.simulation.blockers.join(' ') || 'The second step failed its checks.');
      if (!isEvmPayload(next.payload)) throw new SwingsError('invalid', 'The second step is not an EVM transaction.');
      return next.payload;
    };

    const payload: EvmSwapPayload = { ...prepared.payload, nextStep };
    const warnings = [
      `This swap is two steps through ${hubName}…: your wallet will ask you to confirm the first, and once it is confirmed Aretia prepares and asks for the second from what actually arrived.`,
      `The minimum shown covers both steps (${quote.minOut} raw). If the second step cannot go ahead you will keep the middle token (${raw.hub.address}), which you can swap again.`,
      ...prepared.simulation.warnings,
    ];
    return { quoteId: quote.id, chain, payload, simulation: { ok: prepared.simulation.ok, blockers: prepared.simulation.blockers, warnings }, preparedAt: this.now() };
  }
}
