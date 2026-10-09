/**
 * Direct integration with Uniswap V3 (concentrated liquidity). Quotes come from the venue's own on-chain
 * QuoterV2 contract, which runs the exact swap maths inside the venue; Aretia builds the SwapRouter02
 * transaction itself. No aggregator is involved. (Aretia's own local concentrated-liquidity maths is a later
 * step; until then the venue's quoter is the source of truth, and pools are never split-simulated.)
 *
 * The same adapter prices Slipstream (Aerodrome's and Velodrome's concentrated-liquidity pools, mechanism
 * `evm-slipstream-router`): their pools are told apart by tick spacing instead of fee, the quoter and factory take that
 * spacing as an `int24`, and the router has its own call layout (see evmSlipstream.ts). The numbers in `fees` are then
 * tick spacings.
 *
 * V3 limits in this version, stated plainly: the output of a swap cannot be the native coin (it would be the
 * wrapped token), and BNB Chain (PancakeSwap V3) is not integrated.
 */
import type { EvmRead } from '../chains/evmSession.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type ChainId } from '../core/types.js';
import { address, bytesArray, encodeBytes, encodeCall, selector, uint, word, wordToAddress, wordToBigInt, words } from '../engine/abi.js';
import type { DexEntry } from '../engine/registry.js';
import type { EvmTxPlan } from '../execution/evmV2Builder.js';

export const V3_FEE_TIERS = [100, 500, 3000, 10_000] as const;
const ZERO = '0x' + '0'.repeat(40);

const SIG = {
  getPool: 'getPool(address,address,uint24)',
  quoteSingle: 'quoteExactInputSingle((address,address,uint256,uint24,uint160))',
  quotePath: 'quoteExactInput(bytes,uint256)',
  exactSingle: 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
  exactPath: 'exactInput((bytes,address,uint256,uint256))',
  multicall: 'multicall(uint256,bytes[])',
} as const;

const SLIP_SIG = {
  ...SIG,
  getPool: 'getPool(address,address,int24)',
  quoteSingle: 'quoteExactInputSingle((address,address,uint256,int24,uint160))',
} as const;

export interface V3Route {
  tokens: string[];
  fees: number[];
  amountOut: bigint;
  gasEstimate: bigint;
}

/** `token(20) fee(3) token(20) ...` as hex, the path format V3 uses. */
export function encodeV3Path(tokens: string[], fees: number[]): string {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) throw new SwingsError('invalid', 'A V3 path needs one fee per hop.');
  let out = tokens[0]!.slice(2).toLowerCase();
  for (let i = 0; i < fees.length; i++) {
    const fee = fees[i]!;
    if (!Number.isInteger(fee) || fee <= 0 || fee >= 1 << 24) throw new SwingsError('invalid', 'Invalid V3 fee tier.');
    out += fee.toString(16).padStart(6, '0') + tokens[i + 1]!.slice(2).toLowerCase();
  }
  return out;
}

export class EvmV3Adapter {
  private readonly poolCache = new Map<string, boolean>();

  constructor(
    readonly entry: DexEntry,
    private readonly read: EvmRead,
  ) {
    if ((entry.mechanism !== 'evm-v3-router' && entry.mechanism !== 'evm-slipstream-router') || !entry.factory || !entry.quoter || !entry.router) throw new SwingsError('invalid', `${entry.id} is not a complete V3 venue entry.`);
  }

  private get sig(): typeof SIG | typeof SLIP_SIG {
    return this.entry.mechanism === 'evm-slipstream-router' ? SLIP_SIG : SIG;
  }

  private async call(to: string, data: string, block?: bigint): Promise<string> {
    const out = await this.read('eth_call', [{ to, data }, block === undefined ? 'latest' : '0x' + block.toString(16)]);
    if (typeof out !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(out)) throw new SwingsError('invalid', 'The node returned malformed data.');
    return out;
  }

  /** Whether the venue has a pool for this pair and fee, asked of its own factory. */
  async hasPool(a: string, b: string, fee: number): Promise<boolean> {
    const key = [a, b].sort().join('|') + ':' + fee;
    const cached = this.poolCache.get(key);
    if (cached !== undefined) return cached;
    const out = words(await this.call(this.entry.factory!, encodeCall(this.sig.getPool, [address(a), address(b), uint(BigInt(fee))])));
    const exists = out[0] !== undefined && wordToAddress(out[0]) !== ZERO;
    this.poolCache.set(key, exists);
    return exists;
  }

  private async quoteSingle(tokenIn: string, tokenOut: string, fee: number, amountIn: bigint, block?: bigint): Promise<V3Route | null> {
    try {
      const w = words(await this.call(this.entry.quoter!, encodeCall(this.sig.quoteSingle, [address(tokenIn), address(tokenOut), uint(amountIn), uint(BigInt(fee)), uint(0n)]), block));
      return { tokens: [tokenIn, tokenOut], fees: [fee], amountOut: wordToBigInt(w[0]!), gasEstimate: wordToBigInt(w[3] ?? '0') };
    } catch {
      return null; // a quoter revert means this pool cannot fill the trade
    }
  }

  /** What each existing fee tier of this one pair would pay for `amountIn` on its own, best first. */
  async tierQuotes(tokenIn: string, tokenOut: string, amountIn: bigint, block?: bigint): Promise<V3Route[]> {
    const tiers = this.entry.feeTiers ?? V3_FEE_TIERS;
    const quotes = await Promise.all(
      tiers.map(async (fee) => {
        try {
          return (await this.hasPool(tokenIn, tokenOut, fee)) ? await this.quoteSingle(tokenIn, tokenOut, fee, amountIn, block) : null;
        } catch {
          return null;
        }
      }),
    );
    return quotes.filter((q): q is V3Route => q !== null && q.amountOut > 0n).sort((x, y) => (x.amountOut > y.amountOut ? -1 : x.amountOut < y.amountOut ? 1 : 0));
  }

  /** The venue's own quote for an explicit multi-hop path. Null if any pool in it cannot fill the trade. */
  async quotePath(tokens: string[], fees: number[], amountIn: bigint, block?: bigint): Promise<V3Route | null> {
    try {
      const data = '0x' + selector(SIG.quotePath) + word('40') + word(amountIn.toString(16)) + encodeBytes(encodeV3Path(tokens, fees));
      const w = words(await this.call(this.entry.quoter!, data, block));
      return { tokens, fees, amountOut: wordToBigInt(w[0]!), gasEstimate: wordToBigInt(w[3] ?? '0') };
    } catch {
      return null;
    }
  }

  /**
   * The best one- or two-hop route the venue itself offers, by output. Two-hop routes go through the given
   * hub tokens only. Returns null when no pool can fill the trade.
   */
  async bestRoute(tokenIn: string, tokenOut: string, amountIn: bigint, hubs: string[], block?: bigint): Promise<V3Route | null> {
    const chain: ChainId = this.entry.chain;
    const a = normalizeTokenRef(chain, tokenIn);
    const b = normalizeTokenRef(chain, tokenOut);
    if (!a || !b || a.address === b.address) throw new SwingsError('invalid', 'Invalid token pair for this network.');
    if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');

    const jobs: Promise<V3Route | null>[] = [];
    const tiers = this.entry.feeTiers ?? V3_FEE_TIERS;
    for (const fee of tiers) {
      jobs.push(
        (async () => ((await this.hasPool(a.address, b.address, fee)) ? this.quoteSingle(a.address, b.address, fee, amountIn, block) : null))().catch(() => null),
      );
    }
    for (const hub of hubs) {
      if (hub === a.address || hub === b.address) continue;
      jobs.push(
        (async () => {
          const first: number[] = [];
          const second: number[] = [];
          for (const fee of tiers) {
            if (await this.hasPool(a.address, hub, fee)) first.push(fee);
            if (await this.hasPool(hub, b.address, fee)) second.push(fee);
          }
          const quotes = await Promise.all(first.flatMap((f1) => second.map((f2) => this.quotePath([a.address, hub, b.address], [f1, f2], amountIn, block))));
          return quotes.filter((q): q is V3Route => q !== null).sort((x, y) => (x.amountOut > y.amountOut ? -1 : 1))[0] ?? null;
        })().catch(() => null),
      );
    }
    const found = (await Promise.all(jobs)).filter((r): r is V3Route => r !== null && r.amountOut > 0n);
    return found.sort((x, y) => (x.amountOut !== y.amountOut ? (x.amountOut > y.amountOut ? -1 : 1) : x.tokens.length - y.tokens.length))[0] ?? null;
  }
}

export interface V3SwapParams {
  tokens: string[];
  fees: number[];
  amountIn: bigint;
  minOut: bigint;
  recipient: string;
  /** Unix seconds. */
  deadline: number;
  nativeIn?: boolean;
}

const isAddr = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);

/** SwapRouter02 `exactInputSingle` / `exactInput`, wrapped in `multicall(deadline, ...)` so the swap carries a deadline. */
export function buildV3Swap(entry: DexEntry, p: V3SwapParams, nowSeconds: number = Math.floor(Date.now() / 1000)): EvmTxPlan {
  if (entry.mechanism !== 'evm-v3-router' || !entry.router || !entry.wrappedNative) throw new SwingsError('invalid', `${entry.id} cannot build V3 swaps.`);
  if (p.tokens.length < 2 || p.tokens.length > 3 || !p.tokens.every(isAddr)) throw new SwingsError('invalid', 'A route needs two or three valid token addresses.');
  if (p.fees.length !== p.tokens.length - 1) throw new SwingsError('invalid', 'A V3 route needs one fee per hop.');
  for (let i = 1; i < p.tokens.length; i++) if (p.tokens[i]!.toLowerCase() === p.tokens[i - 1]!.toLowerCase()) throw new SwingsError('invalid', 'A route cannot swap a token for itself.');
  if (p.amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (p.minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  if (!isAddr(p.recipient)) throw new SwingsError('invalid', 'Invalid recipient.');
  if (p.deadline <= nowSeconds) throw new SwingsError('expired', 'The deadline has already passed.');
  if (p.nativeIn && p.tokens[0]!.toLowerCase() !== entry.wrappedNative.toLowerCase()) throw new SwingsError('invalid', 'A native-coin swap must start at the wrapped native token.');

  const tokens = p.tokens.map((t) => t.toLowerCase());
  const recipient = p.recipient.toLowerCase();
  let inner: string;
  if (tokens.length === 2) {
    inner = encodeCall(SIG.exactSingle, [address(tokens[0]!), address(tokens[1]!), uint(BigInt(p.fees[0]!)), address(recipient), uint(p.amountIn), uint(p.minOut), uint(0n)]);
  } else {
    // A struct containing `bytes` is dynamic: one offset to the struct, then its fields, then the path.
    inner = '0x' + selector(SIG.exactPath) + word('20') + word('80') + word(recipient.slice(2)) + word(p.amountIn.toString(16)) + word(p.minOut.toString(16)) + encodeBytes(encodeV3Path(tokens, p.fees));
  }
  const data = encodeCall(SIG.multicall, [uint(BigInt(p.deadline)), bytesArray([inner])]);
  return {
    chain: entry.chain,
    to: entry.router.toLowerCase(),
    data,
    value: p.nativeIn ? p.amountIn : 0n,
    approval: p.nativeIn ? null : { token: tokens[0]!, spender: entry.router.toLowerCase(), amount: p.amountIn },
    summary: `${entry.name}: sell ${p.amountIn} (raw) of ${tokens[0]} for at least ${p.minOut} (raw) of ${tokens[tokens.length - 1]} through ${tokens.length - 1} pool${tokens.length === 2 ? '' : 's'} (fees ${p.fees.map((f) => f / 10_000 + '%').join(', ')}), to ${recipient}.`,
  };
}

export interface V3SplitLeg {
  fee: number;
  amountIn: bigint;
  minOut: bigint;
}

export interface V3SplitParams {
  tokenIn: string;
  tokenOut: string;
  legs: V3SplitLeg[];
  recipient: string;
  deadline: number;
  nativeIn?: boolean;
}

/**
 * One trade divided between pools of the same pair (different fee tiers) on the same router: one `multicall` holding
 * one `exactInputSingle` per pool, each with its own floor. A multicall is a single transaction, so every leg fills
 * or the whole thing reverts. The approval (or value) is the exact total.
 */
export function buildV3Split(entry: DexEntry, p: V3SplitParams, nowSeconds: number = Math.floor(Date.now() / 1000)): EvmTxPlan {
  if (entry.mechanism !== 'evm-v3-router' || !entry.router || !entry.wrappedNative) throw new SwingsError('invalid', `${entry.id} cannot build V3 swaps.`);
  if (!isAddr(p.tokenIn) || !isAddr(p.tokenOut) || p.tokenIn.toLowerCase() === p.tokenOut.toLowerCase()) throw new SwingsError('invalid', 'A split needs two different valid tokens.');
  if (p.legs.length < 2 || p.legs.length > 4) throw new SwingsError('invalid', 'A split needs two to four legs.');
  if (new Set(p.legs.map((l) => l.fee)).size !== p.legs.length) throw new SwingsError('invalid', 'Each leg of a split must use a different pool.');
  for (const l of p.legs) {
    if (!Number.isInteger(l.fee) || l.fee <= 0 || l.fee >= 1 << 24) throw new SwingsError('invalid', 'Invalid V3 fee tier.');
    if (l.amountIn <= 0n) throw new SwingsError('invalid', 'Every leg needs an amount above zero.');
    if (l.minOut <= 0n) throw new SwingsError('invalid', 'Every leg needs a minimum output above zero.');
  }
  if (!isAddr(p.recipient)) throw new SwingsError('invalid', 'Invalid recipient.');
  if (p.deadline <= nowSeconds) throw new SwingsError('expired', 'The deadline has already passed.');
  if (p.nativeIn && p.tokenIn.toLowerCase() !== entry.wrappedNative.toLowerCase()) throw new SwingsError('invalid', 'A native-coin swap must start at the wrapped native token.');
  const tokenIn = p.tokenIn.toLowerCase();
  const tokenOut = p.tokenOut.toLowerCase();
  const recipient = p.recipient.toLowerCase();
  const total = p.legs.reduce((n, l) => n + l.amountIn, 0n);
  const inner = p.legs.map((l) => encodeCall(SIG.exactSingle, [address(tokenIn), address(tokenOut), uint(BigInt(l.fee)), address(recipient), uint(l.amountIn), uint(l.minOut), uint(0n)]));
  return {
    chain: entry.chain,
    to: entry.router.toLowerCase(),
    data: encodeCall(SIG.multicall, [uint(BigInt(p.deadline)), bytesArray(inner)]),
    value: p.nativeIn ? total : 0n,
    approval: p.nativeIn ? null : { token: tokenIn, spender: entry.router.toLowerCase(), amount: total },
    summary: `${entry.name}: sell ${total} (raw) of ${tokenIn} for ${tokenOut}, split over ${p.legs.length} pools (fees ${p.legs.map((l) => l.fee / 10_000 + '%').join(', ')}) in one transaction, each with its own minimum, to ${recipient}.`,
  };
}

export interface InspectedV3Swap {
  function: 'exactInputSingle' | 'exactInput';
  deadline: number;
  tokens: string[];
  fees: number[];
  amountIn: bigint;
  minOut: bigint;
  recipient: string;
}

function inspectItem(bodyHex: string, deadline: number): InspectedV3Swap | null {
  const sel = bodyHex.slice(0, 8);
  const f = words('0x' + bodyHex.slice(8));
  if (sel === selector(SIG.exactSingle)) {
    return { function: 'exactInputSingle', deadline, tokens: [wordToAddress(f[0]!), wordToAddress(f[1]!)], fees: [Number(wordToBigInt(f[2]!))], recipient: wordToAddress(f[3]!), amountIn: wordToBigInt(f[4]!), minOut: wordToBigInt(f[5]!) };
  }
  if (sel === selector(SIG.exactPath)) {
    const base = Number(wordToBigInt(f[0]!)) / 32;
    const recipient = wordToAddress(f[base + 1]!);
    const amountIn = wordToBigInt(f[base + 2]!);
    const minOut = wordToBigInt(f[base + 3]!);
    const pathOffset = base + Number(wordToBigInt(f[base]!)) / 32;
    const pathLen = Number(wordToBigInt(f[pathOffset]!));
    const path = f.slice(pathOffset + 1, pathOffset + 1 + Math.ceil(pathLen / 32)).join('').slice(0, pathLen * 2);
    const tokens: string[] = ['0x' + path.slice(0, 40)];
    const fees: number[] = [];
    for (let i = 40; i < path.length; i += 46) {
      fees.push(Number.parseInt(path.slice(i, i + 6), 16));
      tokens.push('0x' + path.slice(i + 6, i + 46));
    }
    return { function: 'exactInput', deadline, tokens, fees, amountIn, minOut, recipient };
  }
  return null;
}

/** Reads every swap inside a V3 multicall back into its parts. Null if the call is anything else, or any item is not a swap. */
export function inspectV3Swaps(data: string): InspectedV3Swap[] | null {
  try {
    if (data.slice(2, 10).toLowerCase() !== selector(SIG.multicall)) return null;
    const w = words('0x' + data.slice(10));
    const deadline = Number(wordToBigInt(w[0]!));
    const arr = Number(wordToBigInt(w[1]!)) / 32;
    const count = Number(wordToBigInt(w[arr]!));
    if (count < 1 || count > 8) return null;
    const out: InspectedV3Swap[] = [];
    for (let k = 0; k < count; k++) {
      const item = arr + 1 + Number(wordToBigInt(w[arr + 1 + k]!)) / 32;
      const len = Number(wordToBigInt(w[item]!));
      const bodyHex = w.slice(item + 1, item + 1 + Math.ceil(len / 32)).join('').slice(0, len * 2);
      const one = inspectItem(bodyHex, deadline);
      if (!one) return null;
      out.push(one);
    }
    return out;
  } catch {
    return null;
  }
}

/** Reads a single-swap V3 call back into its parts, so what is signed can be compared to what was quoted. Null for a split. */
export function inspectV3Swap(data: string): InspectedV3Swap | null {
  const all = inspectV3Swaps(data);
  return all && all.length === 1 ? all[0]! : null;
}

export interface V3Simulation {
  ok: boolean;
  /** What the router says the swap would pay, read from its own return value. */
  amountOut: bigint | null;
  error: string | null;
}

/** Runs the exact transaction against the real router with `eth_call`, and reads the amount out of its return data. */
export async function simulateV3Swap(read: EvmRead, plan: EvmTxPlan, from: string, options: { balanceOverride?: bigint } = {}): Promise<V3Simulation> {
  try {
    const params: unknown[] = [{ from, to: plan.to, data: plan.data, value: '0x' + plan.value.toString(16) }, 'latest'];
    if (options.balanceOverride !== undefined) params.push({ [from]: { balance: '0x' + options.balanceOverride.toString(16) } });
    const out = await read('eth_call', params);
    if (typeof out !== 'string') return { ok: false, amountOut: null, error: 'The node returned no result.' };
    // multicall returns bytes[]: offset, count, one offset per item, then each item's length and the swap's own return value.
    const w = words(out);
    const arr = Number(wordToBigInt(w[0]!)) / 32;
    const count = Number(wordToBigInt(w[arr]!));
    let total = 0n;
    for (let k = 0; k < count; k++) {
      const item = arr + 1 + Number(wordToBigInt(w[arr + 1 + k]!)) / 32;
      total += wordToBigInt(w[item + 1]!);
    }
    return { ok: true, amountOut: total, error: null };
  } catch (e) {
    return { ok: false, amountOut: null, error: e instanceof Error ? e.message.slice(0, 200) : 'The simulation failed.' };
  }
}
