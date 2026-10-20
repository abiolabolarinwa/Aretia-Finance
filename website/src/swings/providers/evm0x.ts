/**
 * 0x as one DexProvider for the EVM chains.
 *
 * NON-CORE: this is an aggregator integration kept for benchmarking, comparison and migration only.
 * Aretia's production routing is the engine in src/swings/engine (own pools, own maths, own transactions).
 * Nothing in engine/, dex/ or execution/ imports this file, and removing it must not break them. It talks only to Aretia's own server endpoint
 * (/api/swings-0x), which holds the API key; nothing here has a credential. The router and UI know it
 * only as a DexProvider, so 1inch, ParaSwap, OpenOcean or KyberSwap can sit beside it later.
 *
 * Everything 0x returns is untrusted. The transaction is accepted only when it is an AllowanceHolder `exec` that hands the
 * transient allowance to, and calls, a genuine 0x Settler, and the Settler call itself pays at least the user's minimum of the
 * token they asked for to the user's own wallet. Anything else is refused before it can reach the wallet.
 */
import { encodeApprove, type EvmSwapPayload } from '../chains/evm.js';
import { evmFeeTransfer } from '../chains/evmFee.js';
import { DEFAULT_FEE_CONFIG, FEE_PERCENT, planAretiaFee } from '../core/fee.js';
import { normalizeTokenRef, sameToken } from '../core/token.js';
import { CHAINS, EVM_NATIVE_ADDRESS, SwingsError, type AretiaFeeConfig, type ChainId, type Cost, type DexProvider, type PreparedSwap, type Quote, type RouteLeg, type SwapRequest } from '../core/types.js';

export const ZEROX_QUOTE_TTL_MS = 15_000;

export interface ZeroXTrustedContracts {
  /** Contracts a swap transaction may be sent to (the 0x settlement/AllowanceHolder entry points). */
  swapTargets: readonly string[];
  /** Contracts allowed to be approved to spend the user's token. */
  spenders: readonly string[];
  /**
   * The Settler instances `exec` may hand the allowance to and call. 'registry' asks 0x's on-chain Settler registry at build
   * time (see ZEROX_SETTLER_REGISTRY); a list pins exact addresses instead.
   */
  settlers: readonly string[] | 'registry';
}

/**
 * 0x AllowanceHolder, the only contract the AllowanceHolder flow sends transactions to and asks approvals for.
 * Source: https://docs.0x.org/docs/core-concepts/contracts.md (read 2026-10-06), "Cancun hardfork chains",
 * which lists Ethereum, BNB Chain, Polygon and Base. The operator must still confirm the address on each chain's block
 * explorer before enabling that chain; anything else 0x returns is refused.
 */
export const ZEROX_ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734';

/**
 * 0x's Settler deployer/registry, an ERC-721 whose token N is owned by the current Settler for feature N; `prev(N)` is the one
 * before it, which 0x's API may still target while a new deployment dwells. Settler is redeployed every few weeks and its
 * address differs per chain, so 0x says never to hard-code it and to ask this registry instead.
 * Source: https://github.com/0xProject/0x-settler/blob/master/README.md, "How do I find the most recent deployment?" (read
 * 2026-10-19): the registry is at this address on every chain, and the taker-submitted (AllowanceHolder) feature is 2.
 * `ownerOf` reverts while a feature is paused, which this code treats as "do not swap".
 */
export const ZEROX_SETTLER_REGISTRY = '0x00000000000004533Fe15556B1E086BB1A72cEae';
export const ZEROX_SETTLER_TAKER_SUBMITTED_FEATURE = 2n;

const ALLOWANCE_HOLDER_ONLY: ZeroXTrustedContracts = { swapTargets: [ZEROX_ALLOWANCE_HOLDER], spenders: [ZEROX_ALLOWANCE_HOLDER], settlers: 'registry' };
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

/** keccak256("exec(address,address,uint256,address,bytes)")[0:4], AllowanceHolder's only entry point. */
const EXEC_SELECTOR = '0x2213bc0b';
/** keccak256("execute((address,address,uint256),bytes[],bytes32)")[0:4]: Settler's taker-submitted entry point. */
const SETTLER_EXECUTE_SELECTOR = '0x1fff991f';
/** Settler actions a sane route needs; a longer list is refused rather than walked. */
const MAX_SETTLER_ACTIONS = 64;

export interface AllowanceHolderExec {
  /** Who gets the transient allowance (must be the Settler). */
  operator: string;
  token: string;
  amount: bigint;
  /** Who is called (must be the same Settler). */
  target: string;
  /** The calldata `target` is called with, as 0x-prefixed hex. */
  data: string;
}

/** Settler `execute(AllowedSlippage{recipient, buyToken, minAmountOut}, actions, zid)`, the part Settler enforces at the end of the swap. */
export interface SettlerExecute {
  recipient: string;
  buyToken: string;
  minAmountOut: bigint;
  actions: string[];
}

/**
 * Strict ABI reader over 0x-prefixed calldata: every offset and length must stay inside the data, and addresses must have clean
 * upper bytes, so what is read here is exactly what the contract will decode. Null on anything else.
 */
function abiReader(data: string, selector: string): { word: (i: number) => string | null; addr: (i: number) => string | null; uint: (i: number) => bigint | null; bytesAt: (offset: bigint) => string | null; size: number } | null {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data) || data.slice(0, 10).toLowerCase() !== selector) return null;
  const body = data.slice(10);
  const size = body.length / 2;
  const at = (byte: number): string | null => (byte >= 0 && byte + 32 <= size ? body.slice(byte * 2, byte * 2 + 64) : null);
  const word = (i: number): string | null => at(i * 32);
  const addr = (i: number): string | null => {
    const w = word(i);
    return w !== null && /^0{24}[0-9a-fA-F]{40}$/.test(w) ? '0x' + w.slice(24).toLowerCase() : null;
  };
  const uint = (i: number): bigint | null => {
    const w = word(i);
    return w === null ? null : BigInt('0x' + w);
  };
  const bytesAt = (offset: bigint): string | null => {
    if (offset > BigInt(size)) return null;
    const lenWord = at(Number(offset));
    if (lenWord === null) return null;
    const len = BigInt('0x' + lenWord);
    const start = Number(offset) + 32;
    if (len > BigInt(size - start)) return null;
    return '0x' + body.slice(start * 2, start * 2 + Number(len) * 2);
  };
  return { word, addr, uint, bytesAt, size };
}

/** The AllowanceHolder `exec(operator, token, amount, target, data)` call, decoded in full, or null when the data is not exactly one. */
export function decodeAllowanceHolderExec(data: string): AllowanceHolderExec | null {
  const r = abiReader(data, EXEC_SELECTOR);
  if (!r) return null;
  const operator = r.addr(0);
  const token = r.addr(1);
  const amount = r.uint(2);
  const target = r.addr(3);
  const offset = r.uint(4);
  // The single dynamic argument sits right after the five head words, as every ABI encoder writes it.
  if (operator === null || token === null || amount === null || target === null || offset !== 0xa0n) return null;
  const inner = r.bytesAt(offset);
  if (inner === null) return null;
  return { operator, token, amount, target, data: inner };
}

/**
 * Settler's taker-submitted `execute` call, decoded: the slippage struct Settler checks after running the actions, and the
 * actions themselves (bounds-checked, kept opaque). Null when the data is not exactly that call.
 */
export function decodeSettlerExecute(data: string): SettlerExecute | null {
  const r = abiReader(data, SETTLER_EXECUTE_SELECTOR);
  if (!r) return null;
  // Head: recipient, buyToken, minAmountOut (the static struct, inline), offset of actions, zid.
  const recipient = r.addr(0);
  const buyToken = r.addr(1);
  const minAmountOut = r.uint(2);
  const offset = r.uint(3);
  if (recipient === null || buyToken === null || minAmountOut === null || offset === null || r.word(4) === null || offset !== 0xa0n) return null;
  const count = r.uint(5);
  if (count === null || count > BigInt(MAX_SETTLER_ACTIONS)) return null;
  const actions: string[] = [];
  // Element offsets are relative to the start of the array's contents (just after its length word).
  const base = 0xa0n + 32n;
  for (let i = 0; i < Number(count); i++) {
    const rel = r.uint(6 + i);
    if (rel === null) return null;
    const action = r.bytesAt(base + rel);
    if (action === null || action.length < 10) return null;
    actions.push(action);
  }
  return { recipient, buyToken, minAmountOut, actions };
}

export interface ZeroXSettlement {
  exec: AllowanceHolderExec;
  settle: SettlerExecute;
}

/**
 * What a 0x transaction will do, checked against what was asked. Throws a SwingsError naming the first thing that does not
 * match; the Settler address itself is checked separately (it needs the chain), see `Evm0xProvider.checkSettler`.
 */
export function verifyZeroXSettlement(tx: { data: string }, request: SwapRequest, sellAmount: bigint): ZeroXSettlement {
  const blocked = (why: string): never => {
    throw new SwingsError('invalid', `${why} It was blocked.`);
  };
  const exec = decodeAllowanceHolderExec(tx.data);
  if (!exec) return blocked('The swap is not the kind of call Aretia expects for this contract.');
  // AllowanceHolder lets `operator` pull `amount` of `token` from the wallet for the length of the call to `target`. Both must
  // be the one Settler, or the allowance goes to someone who is not the swap.
  if (exec.operator !== exec.target) return blocked('The swap would let a different contract spend your tokens than the one that runs it.');
  const sellNative = request.from.address === EVM_NATIVE_ADDRESS;
  // Any allowance the wallet has ever given AllowanceHolder (for another app, possibly unlimited) can be spent through it, so the
  // call may pull only the token being sold, and no more than the amount entered. Selling the native coin pulls no token.
  if (sellNative ? exec.token !== EVM_NATIVE_ADDRESS && exec.token !== '0x' + '0'.repeat(40) : exec.token !== request.from.address.toLowerCase()) return blocked('The swap would take a different token from your wallet than the one you are selling.');
  if (exec.amount > sellAmount) return blocked('The swap would take more from your wallet than you entered.');
  const settle = decodeSettlerExecute(exec.data);
  if (!settle) return blocked('The swap does not run the 0x settlement Aretia can check.');
  if (settle.recipient !== request.account.address.toLowerCase()) return blocked('The swap would pay what you buy to a different wallet than yours.');
  if (settle.buyToken !== request.to.address.toLowerCase()) return blocked('The swap would pay you a different token than the one you are buying.');
  if (settle.minAmountOut <= 0n) return blocked('The swap does not guarantee any minimum.');
  return { exec, settle };
}

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
    const feePlan = planAretiaFee(request.amountIn, request.chain, this.deps.fee ?? DEFAULT_FEE_CONFIG, from.address);
    if (feePlan.state === 'blocked') throw new SwingsError('config-missing', feePlan.reasons.join(' '));

    const json = await this.deps.quote({ chainId: info.evmChainId, sellToken: from.address, buyToken: to.address, sellAmount: feePlan.net.toString(), taker: taker.address, slippageBps: request.slippageBps }, signal);
    const raw = parseZeroXQuote(json);
    const normalized: SwapRequest = { ...request, from, to, account: { chain: request.chain, address: taker.address } };
    // The minimum is the one in the calldata, which Settler enforces, never the JSON field next to it: the router's slippage
    // check must judge what will actually run. A route whose calldata cannot be read is not offered at all.
    const { settle } = verifyZeroXSettlement(raw.tx, normalized, feePlan.net);
    if (settle.minAmountOut !== BigInt(raw.minBuyAmount)) throw new SwingsError('provider-failed', 'The routing provider returned an inconsistent minimum. The route was dropped.');
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
      request: normalized,
      inAmount: feePlan.net,
      expectedOut: BigInt(raw.buyAmount),
      minOut: settle.minAmountOut,
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
    // Checked again here, against the quote the person saw: who may spend, who is paid, which token, and the minimum.
    const { exec, settle } = verifyZeroXSettlement(raw.tx, request, quote.inAmount);
    const floor = (quote.expectedOut * BigInt(10_000 - request.slippageBps)) / 10_000n;
    if (settle.minAmountOut !== quote.minOut || settle.minAmountOut < floor) throw new SwingsError('invalid', 'The swap would accept less than the minimum you agreed to. It was blocked.');
    const settlerProblem = await this.checkSettler(request.chain, exec.target, trusted);
    const value = BigInt(raw.tx.value);
    // A swap may attach native coin only when selling it, and then exactly the amount entered.
    if (sellNative ? value !== quote.inAmount : value !== 0n) throw new SwingsError('invalid', 'The swap would move a different amount of native coin than you entered. It was blocked.');

    const blockers: string[] = [];
    const warnings: string[] = [];
    let approval: EvmSwapPayload['approval'] = null;
    if (settlerProblem) blockers.push(settlerProblem);
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
    if (!raw.balanceShort && !settlerProblem) {
      const sim = await this.simulate(request, swap, approval, settle, tax?.buyBps ?? 0);
      if (sim.blocker) blockers.push(sim.blocker);
      if (sim.warning) warnings.push(sim.warning);
    }

    // The Aretia fee: its own transaction, in the asset being sold, sent just before the swap. The balance must cover both.
    const feePlan = planAretiaFee(request.amountIn, request.chain, this.deps.fee ?? DEFAULT_FEE_CONFIG, request.from.address);
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
    if (fee) warnings.push(`The Aretia fee of ${FEE_PERCENT} travels with the swap. A wallet that can batch asks you once; otherwise it asks for each step, and the fee is then a separate transaction sent before the swap: it is not refunded if you decline the swap or the swap fails.`);

    const payload: EvmSwapPayload = { chainId: info.evmChainId, taker: request.account.address, approval, ...(fee ? { fee } : {}), swap };
    return { quoteId: quote.id, chain: request.chain, payload, simulation: { ok: blockers.length === 0, blockers, warnings }, preparedAt: this.now() };
  }

  /**
   * Whether `settler` is a genuine 0x Settler for AllowanceHolder swaps on this chain: either on the pinned list, or the registry's
   * current or previous taker-submitted Settler. Returns why not, or null. A registry that cannot be read, or that reports the
   * feature paused, blocks the swap.
   */
  private async checkSettler(chain: ChainId, settler: string, trusted: ZeroXTrustedContracts): Promise<string | null> {
    const refused = 'The swap runs through a contract that is not a genuine 0x Settler. It was blocked.';
    if (trusted.settlers !== 'registry') return trusted.settlers.some((x) => x.toLowerCase() === settler) ? null : refused;
    const feature = ZEROX_SETTLER_TAKER_SUBMITTED_FEATURE.toString(16).padStart(64, '0');
    const read = async (selector: string): Promise<string | null> => {
      const out = await this.deps.rpc(chain, 'eth_call', [{ to: ZEROX_SETTLER_REGISTRY, data: selector + feature }, 'latest']);
      return typeof out === 'string' && /^0x0{24}[0-9a-fA-F]{40}$/.test(out) ? '0x' + out.slice(26).toLowerCase() : null;
    };
    try {
      // ownerOf(uint256), then prev(uint128): 0x's API can still target the previous Settler while a new one dwells.
      if ((await read('0x6352211e')) === settler) return null;
      if ((await read('0xe2603dc2')) === settler) return null;
      return refused;
    } catch {
      return 'The 0x Settler could not be confirmed on the network (it may be paused), so the swap was not offered.';
    }
  }

  /**
   * Runs the swap on the node and measures what arrives in the wallet. With eth_simulateV1 the approval (if any) is replayed first in
   * the same block, and the buy token's balance is read before and after, so a swap that pays someone else, or pays less than the
   * minimum, is caught. A node without it falls back to a plain eth_call, which only shows the swap does not revert. The native
   * coin's balance cannot be read inside a simulation, so for a native buy only success is checked; Settler still enforces the minimum.
   */
  private async simulate(request: SwapRequest, swap: { from: string; to: string; data: string; value: string; gas?: string }, approval: EvmSwapPayload['approval'], settle: SettlerExecute, buyTaxBps: number): Promise<{ blocker?: string; warning?: string }> {
    const taker = request.account.address;
    const buyNative = settle.buyToken === EVM_NATIVE_ADDRESS;
    const balanceOf = { to: settle.buyToken, data: '0x70a08231' + taker.slice(2).toLowerCase().padStart(64, '0') };
    const calls: Record<string, string>[] = [...(approval ? [approval.tx as unknown as Record<string, string>] : []), ...(buyNative ? [] : [balanceOf]), swap, ...(buyNative ? [] : [balanceOf])];
    const swapAt = (approval ? 1 : 0) + (buyNative ? 0 : 1);
    let results: { status?: string; returnData?: string; error?: { message?: string } }[] | undefined;
    try {
      const res = (await this.deps.rpc(request.chain, 'eth_simulateV1', [{ blockStateCalls: [{ calls }], validation: false }, 'latest'])) as { calls?: typeof results }[] | null;
      results = Array.isArray(res) && Array.isArray(res[0]?.calls) && res[0]!.calls!.length === calls.length ? res[0]!.calls : undefined;
    } catch {
      results = undefined;
    }
    if (results) {
      if (approval && results[0]?.status !== '0x1') return { blocker: 'The network would reject the approval for this swap.' };
      const sw = results[swapAt];
      if (sw?.status !== '0x1') return { blocker: `The network would reject this swap: ${(sw?.error?.message ?? 'simulation failed').slice(0, 160)}` };
      if (buyNative) return {};
      const before = results[swapAt - 1]?.returnData;
      const after = results[swapAt + 1]?.returnData;
      if (typeof before !== 'string' || typeof after !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(before) || !/^0x[0-9a-fA-F]{1,64}$/.test(after)) return { warning: 'What the swap pays into your wallet could not be measured in the simulation.' };
      const arrived = BigInt(after) - BigInt(before);
      // A token that takes a tax on transfer delivers less than Settler checked; allow only what 0x itself reported as tax.
      if (arrived * 10_000n < settle.minAmountOut * BigInt(10_000 - buyTaxBps)) return { blocker: 'The simulation shows this swap paying your wallet less than your minimum. It was blocked.' };
      return {};
    }
    if (approval) return { warning: 'The swap itself can only be simulated after the approval is mined.' };
    try {
      await this.deps.rpc(request.chain, 'eth_call', [swap, 'latest']);
    } catch (e) {
      return { blocker: `The network would reject this swap: ${e instanceof Error ? e.message.slice(0, 160) : 'simulation failed'}` };
    }
    return { warning: 'The node could not measure what this swap pays into your wallet; the 0x contract still enforces your minimum.' };
  }
}
