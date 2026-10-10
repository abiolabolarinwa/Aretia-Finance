/**
 * Direct integration with Uniswap V4, where a growing share of Uniswap's liquidity now lives. All V4 pools sit inside one
 * contract (the PoolManager) and are known by a "pool key" (the two currencies, the fee, the tick spacing and a hooks
 * contract), so a pool cannot be found by a factory call as in V2 and V3: the pool id is computed from the key and then asked
 * about.
 *
 * Which pools are used:
 *  - pools with NO hooks contract, at the four standard fee tiers (found by computing their ids);
 *  - pools WITH a hooks contract, found through DexScreener's list of a token's V4 pools. A pool id alone does not say what
 *    its key is, so each id is turned back into a key by the V4 PositionManager (`poolKeys`), the key's own id must equal the
 *    one asked for, and the pool must be live. A hook is custom code Aretia has not reviewed: such a route is quoted by the
 *    V4 quoter (which runs the hook), the real transaction is simulated before the user signs, the minimum output is enforced
 *    by the router, and the user is told the route goes through a hook. It is never presented as vetted.
 *
 * Routes: one hop, or two hops through a hub currency (the native coin, the wrapped coin, USDC, USDT...), priced as a whole
 * by the V4 quoter. The native coin is a currency in its own right (address zero) and is NOT the wrapped coin: a pool that
 * holds the wrapped coin is a different pool. A user selling or buying the native coin can still reach such a pool: the router
 * wraps the coin before the swap (or unwraps it after), one for one, in the same transaction.
 *
 * Selling a token needs two approvals in V4: the token to Permit2, then Permit2's allowance to the router. Both are built here
 * and sent in order by the executor; the swap itself is `execute` on the Universal Router with one V4 swap command.
 */
import type { EvmRead } from '../chains/evmSession.js';
import { DEXSCREENER_CHAIN } from '../charts/pool.js';
import { keccak256 } from '../core/keccak.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError } from '../core/types.js';
import { decodeParams, encodeFunction, encodeParams } from '../engine/abiGeneric.js';
import type { DexEntry } from '../engine/registry.js';
import type { EvmTxPlan } from '../execution/evmV2Builder.js';
import { HUB_TOKENS } from './hubs.js';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** Permit2 is deployed at this address on every chain Aretia supports. */
export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
/** (fee in hundredths of a basis point, tick spacing) of the standard tiers. */
export const V4_TIERS: readonly [number, number][] = [[100, 1], [500, 10], [3000, 60], [10000, 200]];

const COMMAND_V4_SWAP = '10';
const ACTION_SWAP_EXACT_IN_SINGLE = '06';
const ACTION_SWAP_EXACT_IN = '07';
const ACTION_SETTLE_ALL = '0c';
const ACTION_SETTLE = '0b';
const ACTION_TAKE_ALL = '0f';
const ACTION_TAKE = '0e';
const COMMAND_WRAP_ETH = '0b';
const COMMAND_UNWRAP_WETH = '0c';
/** The Universal Router's own names for "this contract" and "the caller", used as recipients. */
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
const MSG_SENDER = '0x0000000000000000000000000000000000000001';
const POOL_KEY = '(address,address,uint24,int24,address)';
const PATH_KEY = '(address,uint24,int24,address,bytes)';
const MAX_U128 = (1n << 128n) - 1n;
const MAX_U160 = (1n << 160n) - 1n;
const MAX_U48 = (1n << 48n) - 1n;
/** How many hinted pools of a token are turned back into keys, and how many hubs a two-hop route is tried through. */
const MAX_HINTED = 12;
const MAX_HUBS = 4;

const isAddr = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const strip = (calldata: string): string => '0x' + calldata.slice(10);

export interface V4PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

/** The two currencies in the order V4 requires (lower address first). */
export function sortedCurrencies(a: string, b: string): [string, string] {
  return BigInt(a) < BigInt(b) ? [a.toLowerCase(), b.toLowerCase()] : [b.toLowerCase(), a.toLowerCase()];
}

export const poolKeyOf = (a: string, b: string, fee: number, tickSpacing: number, hooks: string = ZERO_ADDRESS): V4PoolKey => {
  const [currency0, currency1] = sortedCurrencies(a, b);
  return { currency0, currency1, fee, tickSpacing, hooks: hooks.toLowerCase() };
};

/** `keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))`. */
export function poolId(key: V4PoolKey): string {
  const body = encodeParams(['address', 'address', 'uint24', 'int24', 'address'], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]);
  return '0x' + hex(keccak256(Uint8Array.from(body.slice(2).match(/../g)!.map((b) => parseInt(b, 16)))));
}

const keyTuple = (k: V4PoolKey): unknown[] => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];
const hasHook = (k: V4PoolKey): boolean => k.hooks.toLowerCase() !== ZERO_ADDRESS;

/** One swap through one pool, and which way it goes. */
export interface V4Hop {
  key: V4PoolKey;
  zeroForOne: boolean;
}

export const hopIn = (h: V4Hop): string => (h.zeroForOne ? h.key.currency0 : h.key.currency1);
export const hopOut = (h: V4Hop): string => (h.zeroForOne ? h.key.currency1 : h.key.currency0);

export interface V4Route {
  hops: V4Hop[];
  amountOut: bigint;
  /** The user sells the native coin but the first pool holds the wrapped coin: the router wraps it first. */
  wrapIn?: boolean;
  /** The user buys the native coin but the last pool pays the wrapped coin: the router unwraps it after. */
  unwrapOut?: boolean;
}

/** True when any pool on the route has a hooks contract. */
export const routeHasHook = (hops: readonly V4Hop[]): boolean => hops.some((h) => hasHook(h.key));

/** Candidate pool ids (bytes32) a token trades in, from an index. They are only hints: each is verified on-chain before use. */
export type V4PoolHints = (token: string) => Promise<string[]>;

export function dexScreenerV4Hints(entry: DexEntry, fetchImpl: typeof fetch = (...a) => fetch(...a)): V4PoolHints {
  const cache = new Map<string, { at: number; ids: string[] }>();
  return async (token) => {
    const slug = DEXSCREENER_CHAIN[entry.chain];
    const hit = cache.get(token);
    if (hit && Date.now() - hit.at < 60_000) return hit.ids;
    try {
      const res = await fetchImpl(`https://api.dexscreener.com/tokens/v1/${slug}/${encodeURIComponent(token)}`, { headers: { accept: 'application/json' } });
      if (!res.ok) return [];
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return [];
      const ids: string[] = [];
      for (const p of body) {
        const pair = (p as { pairAddress?: unknown; labels?: unknown }).pairAddress;
        const labels = (p as { labels?: unknown }).labels;
        if (typeof pair === 'string' && /^0x[0-9a-fA-F]{64}$/.test(pair) && Array.isArray(labels) && labels.includes('v4') && !ids.includes(pair.toLowerCase())) ids.push(pair.toLowerCase());
        if (ids.length >= MAX_HINTED) break;
      }
      cache.set(token, { at: Date.now(), ids });
      return ids;
    } catch {
      return [];
    }
  };
}

export class EvmV4Adapter {
  constructor(
    readonly entry: DexEntry,
    private readonly read: EvmRead,
    private readonly hints: V4PoolHints = dexScreenerV4Hints(entry),
  ) {
    if (entry.mechanism !== 'evm-v4-router' || !entry.router || !entry.quoter || !entry.stateView) throw new SwingsError('invalid', `${entry.id} is not a Uniswap V4 entry.`);
  }

  private async call(to: string, data: string, block?: bigint): Promise<string> {
    const out = await this.read('eth_call', [{ to, data }, block === undefined ? 'latest' : '0x' + block.toString(16)]);
    if (typeof out !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(out)) throw new SwingsError('invalid', 'The node returned malformed data.');
    return out;
  }

  /** True when the pool exists and holds liquidity. */
  private async live(key: V4PoolKey, block?: bigint): Promise<boolean> {
    try {
      const id = poolId(key);
      const [price] = decodeParams(['uint160', 'int24', 'uint24', 'uint24'], await this.call(this.entry.stateView!, encodeFunction('getSlot0(bytes32)', [id]), block)) as [bigint];
      if (price === 0n) return false;
      const [liquidity] = decodeParams(['uint128'], await this.call(this.entry.stateView!, encodeFunction('getLiquidity(bytes32)', [id]), block)) as [bigint];
      return liquidity > 0n;
    } catch {
      return false;
    }
  }

  /**
   * Turns pool ids a token is known to trade in back into pool keys, through the V4 PositionManager. A key is accepted only if
   * its own id is the one asked for (so a wrong answer cannot pass) and it uses a hooks contract that really is code.
   */
  async hintedKeys(token: string, block?: bigint): Promise<V4PoolKey[]> {
    if (!this.entry.positionManager) return [];
    const ids = await this.hints(token);
    const keys = await Promise.all(
      ids.map(async (id): Promise<V4PoolKey | null> => {
        try {
          const out = await this.call(this.entry.positionManager!, encodeFunction('poolKeys(bytes25)', ['0x' + id.slice(2, 52)]), block);
          const [c0, c1, fee, spacing, hooks] = decodeParams(['address', 'address', 'uint24', 'int24', 'address'], out) as [string, string, bigint, bigint, string];
          const key: V4PoolKey = { currency0: c0.toLowerCase(), currency1: c1.toLowerCase(), fee: Number(fee), tickSpacing: Number(spacing), hooks: hooks.toLowerCase() };
          if (poolId(key) !== id.toLowerCase() || BigInt(key.currency0) >= BigInt(key.currency1)) return null;
          if (hasHook(key)) {
            const code = (await this.read('eth_getCode', [key.hooks, block === undefined ? 'latest' : '0x' + block.toString(16)])) as string;
            if (typeof code !== 'string' || code.length <= 2) return null;
          }
          return key;
        } catch {
          return null;
        }
      }),
    );
    return keys.filter((k): k is V4PoolKey => k !== null);
  }

  /** What the V4 quoter says `amountIn` of the first currency gets in the second, through one pool; null if it refuses. */
  async quote(key: V4PoolKey, zeroForOne: boolean, amountIn: bigint, block?: bigint): Promise<bigint | null> {
    return this.quoteRoute([{ key, zeroForOne }], amountIn, block);
  }

  /** What the V4 quoter says a whole route (one or more hops) pays for `amountIn`; null if it refuses. */
  async quoteRoute(hops: readonly V4Hop[], amountIn: bigint, block?: bigint): Promise<bigint | null> {
    if (hops.length === 0 || hops.length > 3 || amountIn <= 0n || amountIn > MAX_U128) return null;
    try {
      let data: string;
      if (hops.length === 1) {
        data = encodeFunction(`quoteExactInputSingle((${POOL_KEY},bool,uint128,bytes))`, [[keyTuple(hops[0]!.key), hops[0]!.zeroForOne, amountIn, '0x']]);
      } else {
        data = encodeFunction(`quoteExactInput((address,${PATH_KEY}[],uint128))`, [[hopIn(hops[0]!), pathOf(hops), amountIn]]);
      }
      const [out] = decodeParams(['uint256', 'uint256'], await this.call(this.entry.quoter!, data, block)) as [bigint];
      return out > 0n ? out : null;
    } catch {
      return null;
    }
  }

  /**
   * The best route between two currencies (an ERC-20 address, or the zero address for the native coin): direct through any
   * live pool, or two hops through a hub currency. Pools are the standard hookless tiers plus the hinted pools of either token.
   */
  async bestRoute(tokenIn: string, tokenOut: string, amountIn: bigint, block?: bigint): Promise<V4Route | null> {
    const isNativeAddr = (a: string): boolean => a.toLowerCase() === ZERO_ADDRESS;
    const a = isNativeAddr(tokenIn) ? ZERO_ADDRESS : normalizeTokenRef(this.entry.chain, tokenIn)?.address;
    const b = isNativeAddr(tokenOut) ? ZERO_ADDRESS : normalizeTokenRef(this.entry.chain, tokenOut)?.address;
    if (!a || !b || a === b) throw new SwingsError('invalid', 'Invalid token pair for this network.');
    if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');

    const hinted = (await Promise.all([a, b].filter((t) => t !== ZERO_ADDRESS).map((t) => this.hintedKeys(t, block)))).flat();
    const liveCache = new Map<string, Promise<boolean>>();
    const isLive = (k: V4PoolKey): Promise<boolean> => {
      const id = poolId(k);
      if (!liveCache.has(id)) liveCache.set(id, this.live(k, block));
      return liveCache.get(id)!;
    };
    /** Every live pool between two currencies: the standard hookless tiers and any hinted pool of the pair. */
    const poolsBetween = async (x: string, y: string): Promise<V4PoolKey[]> => {
      const [c0, c1] = sortedCurrencies(x, y);
      const candidates = [...V4_TIERS.map(([fee, spacing]) => poolKeyOf(x, y, fee, spacing)), ...hinted.filter((k) => k.currency0 === c0 && k.currency1 === c1)];
      const unique = [...new Map(candidates.map((k) => [poolId(k), k])).values()];
      const lives = await Promise.all(unique.map((k) => isLive(k)));
      return unique.filter((_, i) => lives[i]);
    };
    const hopOf = (k: V4PoolKey, from: string): V4Hop => ({ key: k, zeroForOne: k.currency0 === from.toLowerCase() });
    /** The pool that pays most for `amount` of `from` into `to`. */
    const bestHop = async (from: string, to: string, amount: bigint): Promise<{ hop: V4Hop; out: bigint } | null> => {
      const pools = await poolsBetween(from, to);
      const quoted = await Promise.all(pools.map(async (k) => ({ hop: hopOf(k, from), out: await this.quote(k, k.currency0 === from.toLowerCase(), amount, block) })));
      return quoted.filter((q): q is { hop: V4Hop; out: bigint } => q.out !== null).sort((x, y) => (x.out > y.out ? -1 : x.out < y.out ? 1 : 0))[0] ?? null;
    };
    const hubsFor = (x: string, y: string): string[] => [ZERO_ADDRESS, ...(HUB_TOKENS[this.entry.chain] ?? []).filter((h) => !h.skipV4).map((h) => h.address)].filter((h) => h !== x && h !== y).slice(0, MAX_HUBS + 3);
    /** The best route from one currency to another, direct or through one hub. */
    const between = async (x: string, y: string): Promise<V4Route | null> => {
      const routes: V4Route[] = [];
      const direct = await bestHop(x, y, amountIn);
      if (direct) routes.push({ hops: [direct.hop], amountOut: direct.out });
      const viaHubs = await Promise.all(
        hubsFor(x, y).map(async (hub): Promise<V4Route | null> => {
          const first = await bestHop(x, hub, amountIn);
          if (!first) return null;
          const second = await bestHop(hub, y, first.out);
          if (!second) return null;
          const hops = [first.hop, second.hop];
          // The whole path is priced again by the quoter, which is the answer that counts.
          const out = await this.quoteRoute(hops, amountIn, block);
          return out === null ? null : { hops, amountOut: out };
        }),
      );
      for (const r of viaHubs) if (r) routes.push(r);
      return routes.sort((p, q) => (p.amountOut > q.amountOut ? -1 : p.amountOut < q.amountOut ? 1 : 0))[0] ?? null;
    };

    // The native coin and the wrapped coin are one-for-one through the router, so a user selling or buying the native coin can
    // use pools that hold either.
    const weth = this.entry.wrappedNative?.toLowerCase();
    const starts = a === ZERO_ADDRESS && weth ? [ZERO_ADDRESS, weth] : [a];
    const ends = b === ZERO_ADDRESS && weth ? [ZERO_ADDRESS, weth] : [b];
    const candidates: V4Route[] = [];
    for (const s of starts) {
      for (const e of ends) {
        if (s === e) continue;
        const r = await between(s, e);
        if (r) candidates.push({ ...r, ...(a === ZERO_ADDRESS && s !== ZERO_ADDRESS ? { wrapIn: true } : {}), ...(b === ZERO_ADDRESS && e !== ZERO_ADDRESS ? { unwrapOut: true } : {}) });
      }
    }
    return candidates.sort((p, q) => (p.amountOut > q.amountOut ? -1 : p.amountOut < q.amountOut ? 1 : 0))[0] ?? null;
  }
}

/** The path of a multi-hop swap: after the input currency, each pool's output currency and the pool's own parameters. */
function pathOf(hops: readonly V4Hop[]): unknown[][] {
  return hops.map((h) => [hopOut(h), h.key.fee, h.key.tickSpacing, h.key.hooks, '0x']);
}

export interface V4SwapParams {
  hops: V4Hop[];
  amountIn: bigint;
  minOut: bigint;
  /** Unix seconds after which the router refuses the swap. */
  deadline: number;
  /** Wrap the native coin first (the first pool holds the wrapped coin). */
  wrapIn?: boolean;
  /** Unwrap the wrapped coin to the native coin at the end (the last pool pays the wrapped coin). */
  unwrapOut?: boolean;
}

/**
 * `execute` on the Universal Router with one V4 swap command: swap exactly `amountIn` through the route's pool or pools, settle
 * what is owed (the native coin is attached to the call; a token is pulled through Permit2) and take at least `minOut` of the
 * last currency.
 */
export function buildV4Swap(entry: DexEntry, p: V4SwapParams): EvmTxPlan {
  if (entry.mechanism !== 'evm-v4-router' || !entry.router) throw new SwingsError('invalid', `${entry.id} cannot build Uniswap V4 swaps.`);
  if (p.hops.length < 1 || p.hops.length > 3) throw new SwingsError('invalid', 'A route needs one to three pools.');
  for (const [i, h] of p.hops.entries()) {
    const k = h.key;
    if (!isAddr(k.currency0) || !isAddr(k.currency1) || !isAddr(k.hooks)) throw new SwingsError('invalid', 'Invalid pool.');
    if (BigInt(k.currency0) >= BigInt(k.currency1)) throw new SwingsError('invalid', 'The pool currencies are out of order.');
    if (!Number.isInteger(k.fee) || k.fee < 0 || k.fee > 16_777_215 || !Number.isInteger(k.tickSpacing) || k.tickSpacing <= 0) throw new SwingsError('invalid', 'Invalid pool fee or tick spacing.');
    if (i > 0 && hopIn(h) !== hopOut(p.hops[i - 1]!)) throw new SwingsError('invalid', 'The pools of this route do not connect.');
  }
  if (p.amountIn <= 0n || p.amountIn > MAX_U128) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (p.minOut <= 0n || p.minOut > MAX_U128) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  if (!Number.isInteger(p.deadline) || p.deadline <= 0) throw new SwingsError('invalid', 'A swap needs a deadline.');
  const currencyIn = hopIn(p.hops[0]!);
  const currencyOut = hopOut(p.hops[p.hops.length - 1]!);
  const wrapped = entry.wrappedNative?.toLowerCase();
  if (p.wrapIn && currencyIn !== wrapped) throw new SwingsError('invalid', 'The first pool does not hold the wrapped coin, so there is nothing to wrap into.');
  if (p.unwrapOut && currencyOut !== wrapped) throw new SwingsError('invalid', 'The last pool does not pay the wrapped coin, so there is nothing to unwrap.');
  let action: string;
  let swap: string;
  if (p.hops.length === 1) {
    action = ACTION_SWAP_EXACT_IN_SINGLE;
    swap = strip(encodeFunction(`x((${POOL_KEY},bool,uint128,uint128,bytes))`, [[keyTuple(p.hops[0]!.key), p.hops[0]!.zeroForOne, p.amountIn, p.minOut, '0x']]));
  } else {
    action = ACTION_SWAP_EXACT_IN;
    swap = strip(encodeFunction(`x((address,${PATH_KEY}[],uint128,uint128))`, [[currencyIn, pathOf(p.hops), p.amountIn, p.minOut]]));
  }
  // Wrapped first: the router holds the wrapped coin and pays the pool from its own balance. Unwrapped last: the router takes
  // the wrapped coin to itself, then unwraps it to the caller.
  const settle = p.wrapIn ? strip(encodeFunction('x(address,uint256,bool)', [currencyIn, p.amountIn, false])) : strip(encodeFunction('x(address,uint256)', [currencyIn, p.amountIn]));
  const take = p.unwrapOut ? strip(encodeFunction('x(address,address,uint256)', [currencyOut, ADDRESS_THIS, 0n])) : strip(encodeFunction('x(address,uint256)', [currencyOut, p.minOut]));
  const actions = '0x' + action + (p.wrapIn ? ACTION_SETTLE : ACTION_SETTLE_ALL) + (p.unwrapOut ? ACTION_TAKE : ACTION_TAKE_ALL);
  const v4Input = '0x' + strip(encodeFunction('x(bytes,bytes[])', [actions, [swap, settle, take]])).slice(2);
  const commands = '0x' + (p.wrapIn ? COMMAND_WRAP_ETH : '') + COMMAND_V4_SWAP + (p.unwrapOut ? COMMAND_UNWRAP_WETH : '');
  const inputs = [...(p.wrapIn ? [strip(encodeFunction('x(address,uint256)', [ADDRESS_THIS, p.amountIn]))] : []), v4Input, ...(p.unwrapOut ? [strip(encodeFunction('x(address,uint256)', [MSG_SENDER, p.minOut]))] : [])];
  const native = currencyIn === ZERO_ADDRESS || !!p.wrapIn;
  const via = (p.hops.length > 1 ? ` through ${p.hops.length} pools` : '') + (p.wrapIn ? ', wrapping the coin first' : '') + (p.unwrapOut ? ', unwrapping it after' : '');
  return {
    chain: entry.chain,
    to: entry.router.toLowerCase(),
    data: encodeFunction('execute(bytes,bytes[],uint256)', [commands, inputs, BigInt(p.deadline)]),
    value: native ? p.amountIn : 0n,
    // Permit2 pulls the token, so the token is approved to Permit2 (and Permit2 to the router; see `permit2ApproveCall`).
    approval: native ? null : { token: currencyIn, spender: PERMIT2, amount: p.amountIn },
    summary: `${entry.name}: swap exactly ${p.amountIn} (raw) of ${native ? 'the native coin' : currencyIn} for at least ${p.minOut} (raw) of ${currencyOut === ZERO_ADDRESS || p.unwrapOut ? 'the native coin' : currencyOut}${via}, or the whole transaction fails.`,
  };
}

/** Permit2's own `approve(token, spender, amount, expiration)`: lets the router take exactly this much of the token until the expiry. */
export function permit2ApproveCall(token: string, spender: string, amount: bigint, expiration: number): string {
  if (!isAddr(token) || !isAddr(spender)) throw new SwingsError('invalid', 'Invalid address.');
  if (amount <= 0n || amount > MAX_U160) throw new SwingsError('invalid', 'Invalid approval amount.');
  if (!Number.isInteger(expiration) || expiration <= 0 || BigInt(expiration) > MAX_U48) throw new SwingsError('invalid', 'Invalid approval expiry.');
  return encodeFunction('approve(address,address,uint160,uint48)', [token, spender, amount, BigInt(expiration)]);
}

/** Reads Permit2's record of what the router may take: (amount, expiration). */
export async function permit2Allowance(read: EvmRead, owner: string, token: string, spender: string): Promise<{ amount: bigint; expiration: bigint }> {
  const out = (await read('eth_call', [{ to: PERMIT2, data: encodeFunction('allowance(address,address,address)', [owner, token, spender]) }, 'latest'])) as string;
  const [amount, expiration] = decodeParams(['uint160', 'uint48', 'uint48'], out) as [bigint, bigint];
  return { amount, expiration };
}
