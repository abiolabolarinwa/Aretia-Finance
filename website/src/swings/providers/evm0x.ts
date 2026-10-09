/**
 * 0x as one DexProvider for the EVM chains.
 *
 * NON-CORE: this is an aggregator integration kept for benchmarking, comparison and migration only.
 * Aretia's production routing is the engine in src/swings/engine (own pools, own maths, own transactions).
 * Nothing in engine/, dex/ or execution/ imports this file, and removing it must not break them. It talks only to Aretia's own server endpoint
 * (/api/swings-0x), which holds the API key; nothing here has a credential. The router and UI know it
 * only as a DexProvider, so 1inch, ParaSwap, OpenOcean or KyberSwap can sit beside it later.
 *
 * Everything 0x returns is untrusted. The transaction is accepted only if its target and spender are on
 * a per-chain allow-list that the owner fills in after verifying the addresses. The list ships EMPTY,
 * so until then buildTransaction refuses with 'config-missing' rather than trusting an API response.
 */
import { encodeApprove, type EvmSwapPayload } from '../chains/evm.js';
import { evmFeeTransfer } from '../chains/evmFee.js';
import { DEFAULT_FEE_CONFIG, planAretiaFee } from '../core/fee.js';
import { normalizeTokenRef, sameToken } from '../core/token.js';
import { CHAINS, EVM_NATIVE_ADDRESS, SwingsError, type AretiaFeeConfig, type ChainId, type Cost, type DexProvider, type PreparedSwap, type Quote, type RouteLeg, type SwapRequest } from '../core/types.js';

export const ZEROX_QUOTE_TTL_MS = 15_000;

export interface ZeroXTrustedContracts {
  /** Contracts a swap transaction may be sent to (the 0x settlement/AllowanceHolder entry points). */
  swapTargets: readonly string[];
  /** Contracts allowed to be approved to spend the user's token. */
  spenders: readonly string[];
}

/**
 * 0x AllowanceHolder, the only contract the AllowanceHolder flow sends transactions to and asks approvals for.
 * Source: https://docs.0x.org/docs/core-concepts/contracts.md (read 2026-10-06), "Cancun hardfork chains",
 * which lists Ethereum, BNB Chain, Polygon and Base. Settler addresses change and are deliberately not listed:
 * they sit behind this contract. The operator must still confirm the address on each chain's block explorer
 * before enabling that chain; anything else 0x returns is refused.
 */
export const ZEROX_ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734';
const ALLOWANCE_HOLDER_ONLY: ZeroXTrustedContracts = { swapTargets: [ZEROX_ALLOWANCE_HOLDER], spenders: [ZEROX_ALLOWANCE_HOLDER] };
export const ZEROX_TRUSTED_CONTRACTS: Partial<Record<ChainId, ZeroXTrustedContracts>> = {
  ethereum: ALLOWANCE_HOLDER_ONLY,
  bnb: ALLOWANCE_HOLDER_ONLY,
  polygon: ALLOWANCE_HOLDER_ONLY,
  base: ALLOWANCE_HOLDER_ONLY,
};

export interface Evm0xDeps {
  /** POSTs the validated request to Aretia's /api/swings-0x and returns the parsed JSON. */
  quote(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  /** Read-only eth_call / eth_estimateGas on the quote's chain; used for simulation. */
  rpc(chain: ChainId, method: string, params: unknown[]): Promise<unknown>;
  trusted?: Partial<Record<ChainId, ZeroXTrustedContracts>>;
  /** The Aretia fee policy. Defaults to the shipped neutral one, which is off. */
  fee?: AretiaFeeConfig;
  now?: () => number;
}

interface ZeroXQuoteRaw {
  buyAmount: string;
  minBuyAmount: string;
  totalNetworkFee: string | null;
  fills: { source: string; from: string; to: string; proportionBps: string }[];
  allowance: { actual: string; spender: string } | null;
  balanceShort: boolean;
  /** Tax data 0x reports for the token being bought, in basis points. Absent when 0x says nothing. */
  buyTokenTax: { buyBps: number | null; sellBps: number | null } | null;
  tx: { to: string; data: string; value: string; gas: string | null };
}

const isAddr = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const isUint = (v: unknown): v is string => typeof v === 'string' && /^[0-9]{1,78}$/.test(v);
const isHexData = (v: unknown): v is string => typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v);
const rec = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const hexQty = (n: bigint): string => '0x' + n.toString(16);

/** Strictly parses a 0x response; anything unexpected is an error, never a guess. */
export function parseZeroXQuote(json: unknown): ZeroXQuoteRaw {
  const o = rec(json);
  const bad = (): never => {
    throw new SwingsError('provider-failed', 'The routing provider returned an unexpected answer.');
  };
  if (!o) return bad();
  if (o.liquidityAvailable === false) throw new SwingsError('no-route', 'No liquidity is available for this swap.');
  const tx = rec(o.transaction);
  if (!tx || !isUint(o.buyAmount) || !isUint(o.minBuyAmount) || !isAddr(tx.to) || !isHexData(tx.data) || !isUint(tx.value ?? '0')) return bad();
  const fillsRaw = rec(o.route)?.fills;
  const fills = Array.isArray(fillsRaw) ? fillsRaw.map((f) => rec(f)).filter((f): f is Record<string, unknown> => f !== null) : [];
  const issues = rec(o.issues);
  const allowance = rec(issues?.allowance);
  const bps = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,5}$/.test(v) ? Number(v) : Number.NaN;
    return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : null;
  };
  const taxes = rec(rec(o.tokenMetadata)?.buyToken);
  return {
    buyAmount: o.buyAmount,
    minBuyAmount: o.minBuyAmount,
    totalNetworkFee: isUint(o.totalNetworkFee) ? o.totalNetworkFee : null,
    fills: fills.map((f) => ({ source: String(f.source ?? '').slice(0, 40), from: String(f.from ?? ''), to: String(f.to ?? ''), proportionBps: String(f.proportionBps ?? '') })),
    allowance: allowance && isAddr(allowance.spender) && isUint(allowance.actual) ? { actual: allowance.actual, spender: allowance.spender } : null,
    balanceShort: rec(issues?.balance) !== null,
    buyTokenTax: taxes ? { buyBps: bps(taxes.buyTaxBps), sellBps: bps(taxes.sellTaxBps) } : null,
    tx: { to: tx.to, data: tx.data, value: isUint(tx.value) ? tx.value : '0', gas: isUint(tx.gas) ? tx.gas : null },
  };
}

export class Evm0xProvider implements DexProvider {
  readonly id = '0x';
  readonly name = '0x';
  /** The fee is its own transaction before the swap, so this route can collect it. */
  readonly carriesAretiaFee = true;
  private readonly now: () => number;

  constructor(private readonly deps: Evm0xDeps) {
    this.now = deps.now ?? Date.now;
  }

  supports(chain: ChainId): boolean {
    return CHAINS[chain].kind === 'evm';
  }

  async getQuote(request: SwapRequest, signal?: AbortSignal): Promise<Quote> {
    const info = CHAINS[request.chain];
    if (info.kind !== 'evm' || info.evmChainId === null) throw new SwingsError('invalid', '0x only swaps on EVM chains.');
    const from = normalizeTokenRef(request.chain, request.from.address);
    const to = normalizeTokenRef(request.chain, request.to.address);
    const taker = normalizeTokenRef(request.chain, request.account.address);
    if (!from || !to || !taker || request.from.chain !== request.chain || request.to.chain !== request.chain) throw new SwingsError('invalid', 'Invalid token or wallet address for this network.');
    if (sameToken(from, to)) throw new SwingsError('invalid', 'Choose two different tokens.');
    if (request.amountIn <= 0n) throw new SwingsError('invalid', 'Enter an amount above zero.');
    // The Aretia fee comes out of the amount entered; the rest is what 0x is asked to swap.
    const feePlan = planAretiaFee(request.amountIn, request.chain, this.deps.fee ?? DEFAULT_FEE_CONFIG);
    if (feePlan.state === 'blocked') throw new SwingsError('config-missing', feePlan.reasons.join(' '));

    const json = await this.deps.quote({ chainId: info.evmChainId, sellToken: from.address, buyToken: to.address, sellAmount: feePlan.net.toString(), taker: taker.address, slippageBps: request.slippageBps }, signal);
    const raw = parseZeroXQuote(json);
    const fetchedAt = this.now();
    const legs: RouteLeg[] = raw.fills.map((f) => ({
      venue: f.source || '0x',
      from: normalizeTokenRef(request.chain, f.from) ?? from,
      to: normalizeTokenRef(request.chain, f.to) ?? to,
      shareBps: Math.min(10_000, Math.max(0, Number.parseInt(f.proportionBps, 10) || 0)),
    }));
    const network: Cost | null = raw.totalNetworkFee === null ? null : { amount: BigInt(raw.totalNetworkFee), asset: { chain: request.chain, address: EVM_NATIVE_ADDRESS } };
    return {
      id: `0x:${request.chain}:${fetchedAt}:${from.address.slice(2, 8)}:${to.address.slice(2, 8)}`,
      providerId: this.id,
      request: { ...request, from, to, account: { chain: request.chain, address: taker.address } },
      inAmount: feePlan.net,
      expectedOut: BigInt(raw.buyAmount),
      minOut: BigInt(raw.minBuyAmount),
      priceImpactBps: null,
      route: { legs: legs.length > 0 ? legs : [{ venue: '0x', from, to, shareBps: 10_000 }] },
      costs: { network, provider: null, aretiaFee: feePlan.fee > 0n ? { amount: feePlan.fee, asset: from } : { amount: 0n, asset: null } },
      fetchedAt,
      expiresAt: fetchedAt + ZEROX_QUOTE_TTL_MS,
      raw,
    };
  }

  async buildTransaction(quote: Quote): Promise<PreparedSwap> {
    if (quote.providerId !== this.id) throw new SwingsError('invalid', 'This quote was not made by 0x.');
    if (this.now() >= quote.expiresAt) throw new SwingsError('expired', 'This quote has expired. Get a new one.');
    const { request } = quote;
    const info = CHAINS[request.chain];
    if (info.evmChainId === null) throw new SwingsError('invalid', 'Not an EVM chain.');
    const raw = quote.raw as ZeroXQuoteRaw;

    const trusted = (this.deps.trusted ?? ZEROX_TRUSTED_CONTRACTS)[request.chain];
    if (!trusted || trusted.swapTargets.length === 0) {
      throw new SwingsError('config-missing', `Verified 0x contract addresses are not configured for ${info.name} yet, so this swap cannot be sent.`);
    }
    const inList = (list: readonly string[], a: string): boolean => list.some((x) => x.toLowerCase() === a.toLowerCase());
    if (!inList(trusted.swapTargets, raw.tx.to)) throw new SwingsError('invalid', 'The swap targets a contract Aretia does not recognise. It was blocked.');

    const sellNative = request.from.address === EVM_NATIVE_ADDRESS;
    const value = BigInt(raw.tx.value);
    // A swap may attach native coin only when selling it, and then exactly the amount entered.
    if (sellNative ? value !== quote.inAmount : value !== 0n) throw new SwingsError('invalid', 'The swap would move a different amount of native coin than you entered. It was blocked.');

    const blockers: string[] = [];
    const warnings: string[] = [];
    let approval: EvmSwapPayload['approval'] = null;
    if (raw.balanceShort) blockers.push('Your balance is too low for this swap.');
    // Token-tax data is 0x's own report: used to protect, never to reassure.
    const tax = raw.buyTokenTax;
    if (tax?.sellBps != null && tax.sellBps >= 5_000) blockers.push(`0x reports a ${(tax.sellBps / 100).toFixed(1)}% sell tax on this token. You would likely not be able to sell it. The swap was blocked.`);
    else if (tax?.sellBps != null && tax.sellBps > 300) warnings.push(`0x reports a ${(tax.sellBps / 100).toFixed(1)}% tax when selling this token.`);
    if (tax?.buyBps != null && tax.buyBps > 300) warnings.push(`0x reports a ${(tax.buyBps / 100).toFixed(1)}% tax when buying this token, so you may receive less than quoted.`);
    if (!tax) warnings.push('Token taxes and transfer restrictions could not be checked for this token.');
    if (!sellNative && raw.allowance) {
      if (!inList(trusted.spenders, raw.allowance.spender)) throw new SwingsError('invalid', 'The swap asks to approve a contract Aretia does not recognise. It was blocked.');
      approval = {
        tx: { from: request.account.address, to: request.from.address, data: encodeApprove(raw.allowance.spender, quote.inAmount) },
        token: request.from.address,
        spender: raw.allowance.spender,
        amount: quote.inAmount,
      };
      warnings.push('This swap needs a one-time approval for exactly the amount you are selling. A wallet that can batch asks you once; otherwise it asks for the approval first, then the swap.');
    }

    const swap = { from: request.account.address, to: raw.tx.to, data: raw.tx.data, value: hexQty(value), ...(raw.tx.gas ? { gas: hexQty(BigInt(raw.tx.gas)) } : {}) };
    if (!approval && !raw.balanceShort) {
      try {
        await this.deps.rpc(request.chain, 'eth_call', [swap, 'latest']);
      } catch (e) {
        blockers.push(`The network would reject this swap: ${e instanceof Error ? e.message.slice(0, 160) : 'simulation failed'}`);
      }
    } else if (approval) {
      warnings.push('The swap itself can only be simulated after the approval is mined.');
    }

    // The Aretia fee: its own transaction, in the asset being sold, sent just before the swap. The balance must cover both.
    const feePlan = planAretiaFee(request.amountIn, request.chain, this.deps.fee ?? DEFAULT_FEE_CONFIG);
    if (feePlan.state === 'blocked') throw new SwingsError('config-missing', feePlan.reasons.join(' '));
    const fee = feePlan.state === 'ready' ? evmFeeTransfer(request.account.address, request.from.address, feePlan.fee, feePlan.treasury) : null;
    if (fee && !raw.balanceShort) {
      try {
        const holds = sellNative
          ? BigInt((await this.deps.rpc(request.chain, 'eth_getBalance', [request.account.address, 'latest'])) as string)
          : BigInt((await this.deps.rpc(request.chain, 'eth_call', [{ to: request.from.address, data: '0x70a08231' + request.account.address.slice(2).toLowerCase().padStart(64, '0') }, 'latest'])) as string);
        if (holds < request.amountIn) blockers.push('Your balance is too low to cover the swap and the Aretia fee.');
      } catch {
        blockers.push('Your balance could not be read, so the swap and the Aretia fee could not be checked.');
      }
    }
    if (fee) warnings.push('The Aretia fee of 0.29% travels with the swap. A wallet that can batch asks you once; otherwise it asks for each step.');

    const payload: EvmSwapPayload = { chainId: info.evmChainId, taker: request.account.address, approval, ...(fee ? { fee } : {}), swap };
    return { quoteId: quote.id, chain: request.chain, payload, simulation: { ok: blockers.length === 0, blockers, warnings }, preparedAt: this.now() };
  }
}
