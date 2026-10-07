/**
 * Direct integration with Aerodrome on Base: a Velodrome-style router over volatile (x*y=k) and stable
 * (x^3*y+y^3*x=k) pools. Prices come from the router's own `getAmountsOut` (exact for both pool kinds, and
 * includes each pool's own fee); Aretia builds the swap transaction itself. No aggregator is involved.
 *
 * Routes are sequences of (from, to, stable, factory) hops, one or two hops through the chain's hub tokens.
 */
import type { EvmRead } from '../chains/evmSession.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError } from '../core/types.js';
import { address, decodeUintArray, encodeCall, selector, tupleArray, uint, wordOfAddress, wordOfBool } from '../engine/abi.js';
import type { DexEntry } from '../engine/registry.js';
import type { EvmTxPlan } from '../execution/evmV2Builder.js';

export interface AeroHop {
  from: string;
  to: string;
  stable: boolean;
  factory: string;
}

export interface AeroRoute {
  hops: AeroHop[];
  amountOut: bigint;
}

const SIG = {
  getAmountsOut: 'getAmountsOut(uint256,(address,address,bool,address)[])',
  tokensForTokens: 'swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)',
  ethForTokens: 'swapExactETHForTokens(uint256,(address,address,bool,address)[],address,uint256)',
  tokensForEth: 'swapExactTokensForETH(uint256,uint256,(address,address,bool,address)[],address,uint256)',
} as const;

const wordsOfRoutes = (hops: AeroHop[]): string[][] => hops.map((h) => [wordOfAddress(h.from), wordOfAddress(h.to), wordOfBool(h.stable), wordOfAddress(h.factory)]);

export class EvmAerodromeAdapter {
  constructor(
    readonly entry: DexEntry,
    private readonly read: EvmRead,
  ) {
    if (entry.mechanism !== 'evm-aerodrome-router' || !entry.router || !entry.factory) throw new SwingsError('invalid', `${entry.id} is not a complete Aerodrome entry.`);
  }

  /** What the router itself says this route pays; null when a pool in it does not exist or cannot fill the trade. */
  async quote(hops: AeroHop[], amountIn: bigint, block?: bigint): Promise<bigint | null> {
    try {
      const data = encodeCall(SIG.getAmountsOut, [uint(amountIn), tupleArray(wordsOfRoutes(hops))]);
      const out = (await this.read('eth_call', [{ to: this.entry.router, data }, block === undefined ? 'latest' : '0x' + block.toString(16)])) as string;
      const amounts = decodeUintArray(out);
      const last = amounts[amounts.length - 1];
      return last !== undefined && last > 0n ? last : null;
    } catch {
      return null;
    }
  }

  /** The best direct or one-hub route the router offers, by output. */
  async bestRoute(tokenIn: string, tokenOut: string, amountIn: bigint, hubs: string[], block?: bigint): Promise<AeroRoute | null> {
    const a = normalizeTokenRef(this.entry.chain, tokenIn);
    const b = normalizeTokenRef(this.entry.chain, tokenOut);
    if (!a || !b || a.address === b.address) throw new SwingsError('invalid', 'Invalid token pair for this network.');
    if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
    const factory = this.entry.factory!;
    const hop = (from: string, to: string, stable: boolean): AeroHop => ({ from, to, stable, factory });
    const candidates: AeroHop[][] = [[hop(a.address, b.address, false)], [hop(a.address, b.address, true)]];
    for (const h of hubs) {
      if (h === a.address || h === b.address) continue;
      for (const s1 of [false, true]) for (const s2 of [false, true]) candidates.push([hop(a.address, h, s1), hop(h, b.address, s2)]);
    }
    const quoted = await Promise.all(candidates.map(async (hops) => ({ hops, amountOut: await this.quote(hops, amountIn, block) })));
    const found = quoted.filter((q): q is AeroRoute => q.amountOut !== null);
    return found.sort((x, y) => (x.amountOut !== y.amountOut ? (x.amountOut > y.amountOut ? -1 : 1) : x.hops.length - y.hops.length))[0] ?? null;
  }
}

export interface AeroSwapParams {
  hops: AeroHop[];
  amountIn: bigint;
  minOut: bigint;
  recipient: string;
  deadline: number;
  nativeIn?: boolean;
  nativeOut?: boolean;
}

const isAddr = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);

export function buildAerodromeSwap(entry: DexEntry, p: AeroSwapParams, nowSeconds: number = Math.floor(Date.now() / 1000)): EvmTxPlan {
  if (entry.mechanism !== 'evm-aerodrome-router' || !entry.router || !entry.wrappedNative) throw new SwingsError('invalid', `${entry.id} cannot build Aerodrome swaps.`);
  if (p.hops.length < 1 || p.hops.length > 3) throw new SwingsError('invalid', 'A route needs one to three hops.');
  for (let i = 0; i < p.hops.length; i++) {
    const h = p.hops[i]!;
    if (!isAddr(h.from) || !isAddr(h.to) || !isAddr(h.factory)) throw new SwingsError('invalid', 'A hop has an invalid address.');
    if (h.from.toLowerCase() === h.to.toLowerCase()) throw new SwingsError('invalid', 'A hop cannot swap a token for itself.');
    if (i > 0 && p.hops[i - 1]!.to.toLowerCase() !== h.from.toLowerCase()) throw new SwingsError('invalid', 'The hops do not connect.');
    if (h.factory.toLowerCase() !== entry.factory?.toLowerCase()) throw new SwingsError('invalid', 'A hop uses a factory this venue does not recognise.');
  }
  if (p.amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (p.minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  if (!isAddr(p.recipient)) throw new SwingsError('invalid', 'Invalid recipient.');
  if (p.deadline <= nowSeconds) throw new SwingsError('expired', 'The deadline has already passed.');
  if (p.nativeIn && p.nativeOut) throw new SwingsError('invalid', 'A swap cannot start and end in the native coin.');
  const wrapped = entry.wrappedNative.toLowerCase();
  if (p.nativeIn && p.hops[0]!.from.toLowerCase() !== wrapped) throw new SwingsError('invalid', 'A native-coin swap must start at the wrapped native token.');
  if (p.nativeOut && p.hops[p.hops.length - 1]!.to.toLowerCase() !== wrapped) throw new SwingsError('invalid', 'A swap into the native coin must end at the wrapped native token.');

  const hops = p.hops.map((h) => ({ from: h.from.toLowerCase(), to: h.to.toLowerCase(), stable: h.stable, factory: h.factory.toLowerCase() }));
  const routes = tupleArray(wordsOfRoutes(hops));
  const to = address(p.recipient.toLowerCase());
  const deadline = uint(BigInt(p.deadline));
  let data: string;
  let value = 0n;
  if (p.nativeIn) {
    data = encodeCall(SIG.ethForTokens, [uint(p.minOut), routes, to, deadline]);
    value = p.amountIn;
  } else if (p.nativeOut) data = encodeCall(SIG.tokensForEth, [uint(p.amountIn), uint(p.minOut), routes, to, deadline]);
  else data = encodeCall(SIG.tokensForTokens, [uint(p.amountIn), uint(p.minOut), routes, to, deadline]);
  return {
    chain: entry.chain,
    to: entry.router.toLowerCase(),
    data,
    value,
    approval: p.nativeIn ? null : { token: hops[0]!.from, spender: entry.router.toLowerCase(), amount: p.amountIn },
    summary: `${entry.name}: sell ${p.amountIn} (raw) of ${hops[0]!.from} for at least ${p.minOut} (raw) of ${hops[hops.length - 1]!.to} through ${hops.length} pool${hops.length === 1 ? '' : 's'} (${hops.map((h) => (h.stable ? 'stable' : 'volatile')).join(', ')}), to ${p.recipient}.`,
  };
}

export interface InspectedAeroSwap {
  function: 'swapExactTokensForTokens' | 'swapExactETHForTokens' | 'swapExactTokensForETH';
  amountIn: bigint | null;
  minOut: bigint;
  hops: AeroHop[];
  recipient: string;
  deadline: number;
}

/** Reads an Aerodrome swap's calldata back into its parts. Null for anything that is not one of the three swap calls. */
export function inspectAerodromeSwap(data: string): InspectedAeroSwap | null {
  try {
    const sel = data.slice(2, 10).toLowerCase();
    const body = data.slice(10);
    const word = (i: number): string => body.slice(i * 64, i * 64 + 64);
    const num = (i: number): bigint => BigInt('0x' + word(i));
    const addr = (i: number): string => '0x' + word(i).slice(24);
    let fn: InspectedAeroSwap['function'];
    let layout: { amountInIdx: number | null; minIdx: number; routesIdx: number; toIdx: number; deadlineIdx: number };
    if (sel === selector(SIG.tokensForTokens)) {
      fn = 'swapExactTokensForTokens';
      layout = { amountInIdx: 0, minIdx: 1, routesIdx: 2, toIdx: 3, deadlineIdx: 4 };
    } else if (sel === selector(SIG.tokensForEth)) {
      fn = 'swapExactTokensForETH';
      layout = { amountInIdx: 0, minIdx: 1, routesIdx: 2, toIdx: 3, deadlineIdx: 4 };
    } else if (sel === selector(SIG.ethForTokens)) {
      fn = 'swapExactETHForTokens';
      layout = { amountInIdx: null, minIdx: 0, routesIdx: 1, toIdx: 2, deadlineIdx: 3 };
    } else return null;
    const arr = Number(num(layout.routesIdx)) / 32;
    const count = Number(num(arr));
    if (!Number.isInteger(arr) || count < 1 || count > 3) return null;
    const hops: AeroHop[] = [];
    for (let i = 0; i < count; i++) {
      const o = arr + 1 + i * 4;
      hops.push({ from: addr(o), to: addr(o + 1), stable: num(o + 2) === 1n, factory: addr(o + 3) });
    }
    return { function: fn, amountIn: layout.amountInIdx === null ? null : num(layout.amountInIdx), minOut: num(layout.minIdx), hops, recipient: addr(layout.toIdx), deadline: Number(num(layout.deadlineIdx)) };
  } catch {
    return null;
  }
}
