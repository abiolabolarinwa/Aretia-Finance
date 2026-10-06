/**
 * Aretia's own Solana swap provider. Pools are read from the venues' programs (Raydium CPMM, Meteora DAMM v2), the
 * transaction is built by Aretia, and it is run through the real program on the RPC before the user is asked to
 * sign. No aggregator is involved. Coverage is exactly the venues integrated so far; the registry says which.
 *
 *  - Raydium CPMM: priced by Aretia's own exact maths (constant-product pools; Token-2022 and creator-fee pools excluded).
 *  - Meteora DAMM v2: priced by the program itself, by simulating the user's swap and reading the amount delivered.
 *    That needs the user's account (it is the account the swap would run from), which every swap request carries.
 */
import type * as Web3 from '@solana/web3.js';
import { ataAddress, TOKEN_PROGRAM_ID } from '../../scripts/walletTools.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type DexProvider, type PreparedSwap, type Quote, type SwapRequest, type TokenRef } from '../core/types.js';
import type { ProviderHealth } from '../engine/health.js';
import { LiquidityStore } from '../engine/liquidity.js';
import type { AretiaDexRegistry, DexEntry } from '../engine/registry.js';
import { RoutingEngine } from '../engine/routing.js';
import type { LiquidityPool } from '../engine/types.js';
import { quoteConstantProduct } from '../engine/amm.js';
import { buildCpmmSwapTransaction, buildSwapTransaction, WSOL_MINT, type BuiltSwap } from './builder.js';
import { dammSwapInstruction, MeteoraDammAdapter } from './meteoraDamm.js';
import { RaydiumCpmmAdapter, type SolRpc } from './raydiumCpmm.js';
import { simulateSolanaSwap, type SolanaSimResult } from './simulate.js';

export const SOLANA_QUOTE_TTL_MS = 12_000;
/** SOL a swap may use beyond the amount: fees, priority fee and rent for up to two new accounts. */
const OVERHEAD_LAMPORTS = 6_000_000n;

export interface DirectSolanaDeps {
  web3: () => Promise<typeof Web3>;
  rpc: SolRpc;
  registry: AretiaDexRegistry;
  health?: ProviderHealth;
  now?: () => number;
}

interface SolanaRaw {
  kind: 'cpmm' | 'damm';
  entryId: string;
  poolAddress: string;
  nativeIn: boolean;
  nativeOut: boolean;
  reasons: string[];
}

interface Candidate {
  kind: 'cpmm' | 'damm';
  pool: LiquidityPool;
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
}

const isWsol = (t: TokenRef): boolean => t.address === WSOL_MINT;

export class DirectSolanaProvider implements DexProvider {
  readonly id = 'aretia-sol';
  readonly name = 'Aretia Router';
  private readonly now: () => number;

  constructor(private readonly deps: DirectSolanaDeps) {
    this.now = deps.now ?? Date.now;
  }

  supports(chain: SwapRequest['chain']): boolean {
    return chain === 'solana' && this.venues().length > 0;
  }

  private venues(): DexEntry[] {
    return this.deps.registry.routable('solana').filter((e) => e.mechanism === 'solana-program');
  }

  private track<T>(id: string, work: () => Promise<T>): Promise<T> {
    return this.deps.health ? this.deps.health.track(id, work) : work();
  }

  private dammAdapter(web3: typeof Web3): MeteoraDammAdapter | null {
    const entry = this.venues().find((e) => e.id === 'meteora-damm-v2');
    return entry ? new MeteoraDammAdapter(web3, this.deps.rpc, entry.knownPools ?? [], this.now) : null;
  }

  /** Builds the transaction for a pool of either venue. `minOut` is enforced by the program, and by the judge below. */
  private async build(web3: typeof Web3, kind: 'cpmm' | 'damm', pool: LiquidityPool, request: SwapRequest, amountIn: bigint, minOut: bigint, o: { nativeIn: boolean; nativeOut: boolean; closeWsol: boolean }): Promise<BuiltSwap> {
    const user = request.account.address;
    const { blockhash } = (await this.deps.rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
    if (kind === 'cpmm') {
      return buildCpmmSwapTransaction(web3, { user, step: { pool, tokenIn: request.from, tokenOut: request.to, amountIn, minOut }, nativeIn: o.nativeIn, nativeOut: o.nativeOut, closeWsol: o.closeWsol, recentBlockhash: blockhash });
    }
    const x = pool.extra!;
    const programOf = (mint: string): string => (mint === pool.token0.address ? x.programA! : x.programB!);
    return buildSwapTransaction(web3, {
      user,
      tokenIn: request.from,
      tokenOut: request.to,
      programIn: programOf(request.from.address),
      programOut: programOf(request.to.address),
      amountIn,
      nativeIn: o.nativeIn,
      nativeOut: o.nativeOut,
      closeWsol: o.closeWsol,
      recentBlockhash: blockhash,
      swapLabel: `Meteora DAMM v2 pool ${pool.ref.address.slice(0, 8)}…: swap exactly ${amountIn} (raw) for at least ${minOut} (raw), or the whole transaction fails.`,
      swapInstruction: (inAcct, outAcct) => dammSwapInstruction(web3, user, pool, inAcct, outAcct, amountIn, minOut),
    });
  }

  private simulate(built: BuiltSwap, request: SwapRequest, amountIn: bigint, minOut: bigint, nativeIn: boolean, outputIsNative: boolean): Promise<SolanaSimResult> {
    return simulateSolanaSwap(this.deps.rpc, built.transaction, {
      user: request.account.address,
      inAccount: built.inAccount,
      outAccount: built.outAccount,
      inputIsSol: nativeIn,
      outputIsSol: outputIsNative,
      amountIn,
      minOut,
      overheadLamports: OVERHEAD_LAMPORTS,
    });
  }

  /** Asks the DAMM v2 program what this swap would deliver, by simulating it from the user's own accounts. */
  private async dammCandidates(web3: typeof Web3, request: SwapRequest): Promise<Candidate[]> {
    const adapter = this.dammAdapter(web3);
    if (!adapter) return [];
    const pools = (await this.track('meteora-damm-v2', () => adapter.getPools(request.from, request.to))).filter((p) => p.status === 'active');
    const nativeIn = isWsol(request.from);
    const out: Candidate[] = [];
    for (const pool of pools) {
      try {
        // minOut of 1 here is only the probe: the real floor is set from the answer, below, and enforced on the final build.
        const probe = async (amount: bigint): Promise<bigint | null> => {
          const built = await this.build(web3, 'damm', pool, request, amount, 1n, { nativeIn, nativeOut: false, closeWsol: false });
          const sim = await this.simulate(built, request, amount, 1n, nativeIn, false);
          return sim.blockers.length === 0 ? sim.verdict.received : null;
        };
        const received = await probe(request.amountIn);
        if (received === null || received <= 0n) continue;
        let impactBps: number | null = null;
        if (request.amountIn >= 100n) {
          const small = await probe(request.amountIn / 100n).catch(() => null);
          if (small && small > 0n) {
            const ideal = small * 100n;
            impactBps = ideal > received ? Number(((ideal - received) * 10_000n) / ideal) : 0;
          }
        }
        out.push({ kind: 'damm', pool, amountOut: received, impactBps, reasons: [`Meteora DAMM v2 pool ${pool.ref.address.slice(0, 8)}…: the program itself reported this output when the swap was simulated from your account (after its own fees and any token transfer fee).`] });
      } catch {
        // This pool cannot fill the trade from this account; other pools and venues still can.
      }
    }
    return out;
  }

  private async cpmmCandidate(web3: typeof Web3, request: SwapRequest): Promise<Candidate[]> {
    const entry = this.venues().find((e) => e.id === 'raydium-cpmm');
    if (!entry) return [];
    const adapter = new RaydiumCpmmAdapter(web3, this.deps.rpc, this.now);
    const found = (await this.track(entry.id, () => adapter.getPools(request.from, request.to))).filter((p) => p.status === 'active');
    if (found.length === 0) return [];
    const store = new LiquidityStore(this.now);
    found.forEach((p) => store.put(p));
    try {
      const route = new RoutingEngine({ store, registry: this.deps.registry, now: this.now }).routes({ tokenIn: request.from, tokenOut: request.to, amountIn: request.amountIn, maxHops: 1, maxRoutes: 5 })[0];
      if (!route) return [];
      const pool = route.hops[0]!.pool;
      return [{ kind: 'cpmm', pool, amountOut: route.amountOut, impactBps: route.priceImpactBps, reasons: [`${found.length} Raydium CPMM pool${found.length === 1 ? '' : 's'} read; this one pays most (fee ${(pool.feePpm / 10_000).toFixed(2)}%).`, ...route.reasons] }];
    } catch (e) {
      if (e instanceof SwingsError && e.code === 'no-route') return [];
      throw e;
    }
  }

  async getQuote(request: SwapRequest): Promise<Quote> {
    if (request.chain !== 'solana') throw new SwingsError('invalid', 'The Aretia Solana router only swaps on Solana.');
    const from = normalizeTokenRef('solana', request.from.address);
    const to = normalizeTokenRef('solana', request.to.address);
    if (!from || !to || from.address === to.address) throw new SwingsError('invalid', 'Choose two different, valid tokens.');
    if (request.amountIn <= 0n) throw new SwingsError('invalid', 'Enter an amount above zero.');
    if (!this.supports('solana')) throw new SwingsError('no-route', 'No Solana venue is available right now.');

    const web3 = await this.deps.web3();
    const req: SwapRequest = { ...request, from, to };
    const settled = await Promise.allSettled([this.cpmmCandidate(web3, req), this.dammCandidates(web3, req)]);
    const candidates = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (candidates.length === 0) {
      const failed = settled.find((r) => r.status === 'rejected');
      if (failed && failed.status === 'rejected' && failed.reason instanceof SwingsError && failed.reason.code !== 'no-route') throw failed.reason;
      throw new SwingsError('no-route', 'No pool Aretia reads directly can fill this trade.');
    }
    candidates.sort((a, b) => (a.amountOut !== b.amountOut ? (a.amountOut > b.amountOut ? -1 : 1) : a.pool.ref.address < b.pool.ref.address ? -1 : 1));
    const best = candidates[0]!;
    const comparison = candidates.map((c) => `${this.deps.registry.get(c.pool.ref.dex)?.name ?? c.pool.ref.dex} pays ${c.amountOut}`).join('; ');
    const minOut = (best.amountOut * BigInt(10_000 - request.slippageBps)) / 10_000n;
    if (minOut <= 0n) throw new SwingsError('no-route', 'The route pays too little to set a minimum.');
    const fetchedAt = this.now();
    const raw: SolanaRaw = { kind: best.kind, entryId: best.pool.ref.dex, poolAddress: best.pool.ref.address, nativeIn: isWsol(from), nativeOut: isWsol(to), reasons: [`Compared: ${comparison}.`, ...best.reasons] };
    return {
      id: `aretia-sol:${fetchedAt}:${from.address.slice(0, 6)}:${to.address.slice(0, 6)}`,
      providerId: this.id,
      request: req,
      inAmount: request.amountIn,
      expectedOut: best.amountOut,
      minOut,
      priceImpactBps: best.impactBps,
      route: { legs: [{ venue: this.deps.registry.get(best.pool.ref.dex)?.name ?? best.pool.ref.dex, from, to, shareBps: 10_000 }] },
      costs: { network: null, provider: null, aretiaBuyback: { amount: 0n, asset: null } },
      fetchedAt,
      expiresAt: fetchedAt + SOLANA_QUOTE_TTL_MS,
      raw,
    };
  }

  async buildTransaction(quote: Quote): Promise<PreparedSwap> {
    if (quote.providerId !== this.id) throw new SwingsError('invalid', 'This quote was not made by the Aretia router.');
    if (this.now() >= quote.expiresAt) throw new SwingsError('expired', 'This quote has expired. Get a new one.');
    const raw = quote.raw as SolanaRaw;
    const { request } = quote;
    const entry = this.deps.registry.get(raw.entryId);
    if (!entry) throw new SwingsError('invalid', 'The venue for this quote is no longer available.');
    const status = this.deps.registry.effectiveStatus(entry.id);
    if (status !== 'ACTIVE' && status !== 'DEGRADED') throw new SwingsError('not-enabled', `${entry.name} is not accepting swaps right now.`);

    const web3 = await this.deps.web3();
    const user = request.account.address;
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (status === 'DEGRADED') warnings.push(`${entry.name} has been unreliable recently.`);

    // 1. Read the same pool again, now. For Raydium the trade is priced locally against it; for DAMM v2 the program answers below.
    let fresh: LiquidityPool | undefined;
    if (raw.kind === 'cpmm') {
      fresh = (await this.track(entry.id, () => new RaydiumCpmmAdapter(web3, this.deps.rpc, this.now).getPools(request.from, request.to))).find((p) => p.ref.address === raw.poolAddress && p.status === 'active');
      if (fresh) {
        const nowOut = quoteConstantProduct(fresh, request.from, quote.inAmount);
        if (nowOut < quote.minOut) blockers.push('The price has moved since the quote: the pool would now pay less than your minimum. Get a new quote.');
      }
    } else {
      const adapter = this.dammAdapter(web3);
      fresh = adapter ? (await this.track(entry.id, () => adapter.getPools(request.from, request.to))).find((p) => p.ref.address === raw.poolAddress && p.status === 'active') : undefined;
    }
    if (!fresh) throw new SwingsError('no-route', 'The pool for this quote is no longer available. Get a new quote.');

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

    const built = await this.build(web3, raw.kind, fresh, request, quote.inAmount, quote.minOut, { nativeIn: raw.nativeIn, nativeOut: raw.nativeOut, closeWsol });

    // 3. Run the exact transaction through the real program and judge it by what it does to the wallet.
    if (blockers.length === 0) {
      const sim = await this.simulate(built, request, quote.inAmount, quote.minOut, raw.nativeIn, outputIsNativeNow);
      blockers.push(...sim.blockers);
      if (sim.opensOutputAccount) warnings.push('This swap opens a token account in your wallet, which costs a small amount of SOL.');
    }

    const payload: SolanaSwapPayload = { transaction: built.transaction, steps: built.steps, plannedAt: this.now() };
    warnings.push(...built.steps.map((s) => `Transaction step: ${s}`));
    return { quoteId: quote.id, chain: 'solana', payload, simulation: { ok: blockers.length === 0, blockers, warnings }, preparedAt: this.now() };
  }
}
