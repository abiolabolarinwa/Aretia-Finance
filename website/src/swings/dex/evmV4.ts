/**
 * Direct integration with Uniswap V4, where a growing share of Uniswap's liquidity now lives. All V4 pools sit inside one
 * contract (the PoolManager) and are known by a "pool key" (the two currencies, the fee, the tick spacing and a hooks
 * contract), so a pool cannot be found by a factory call as in V2 and V3: the pool id is computed from the key and then asked
 * about.
 *
 * Scope, stated plainly: single-hop swaps between two currencies (the native coin, address zero, counts as a currency) through
 * pools that have NO hooks contract. A hook is arbitrary code that can change a pool's price, fees or permissions, so a pool
 * with a hook is not touched. Standard fee tiers only. Each pool is read from the chain (`StateView`) and priced by the V4
 * quoter before it is used.
 *
 * Selling a token needs two approvals in V4: the token to Permit2, then Permit2's allowance to the router. Both are built here
 * and sent in order by the executor; the swap itself is `execute` on the Universal Router with one V4 swap command.
 */
import type { EvmRead } from '../chains/evmSession.js';
import { keccak256 } from '../core/keccak.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError } from '../core/types.js';
import { decodeParams, encodeFunction, encodeParams } from '../engine/abiGeneric.js';
import type { DexEntry } from '../engine/registry.js';
import type { EvmTxPlan } from '../execution/evmV2Builder.js';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** Permit2 is deployed at this address on every chain Aretia supports. */
export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
/** (fee in hundredths of a basis point, tick spacing) of the standard tiers. */
export const V4_TIERS: readonly [number, number][] = [[100, 1], [500, 10], [3000, 60], [10000, 200]];

const COMMAND_V4_SWAP = '10';
const ACTION_SWAP_EXACT_IN_SINGLE = '06';
const ACTION_SETTLE_ALL = '0c';
const ACTION_TAKE_ALL = '0f';
const POOL_KEY = '(address,address,uint24,int24,address)';
const MAX_U128 = (1n << 128n) - 1n;
const MAX_U160 = (1n << 160n) - 1n;
const MAX_U48 = (1n << 48n) - 1n;

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

export const poolKeyOf = (a: string, b: string, fee: number, tickSpacing: number): V4PoolKey => {
  const [currency0, currency1] = sortedCurrencies(a, b);
  return { currency0, currency1, fee, tickSpacing, hooks: ZERO_ADDRESS };
};

/** `keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))`. */
export function poolId(key: V4PoolKey): string {
  const body = encodeParams(['address', 'address', 'uint24', 'int24', 'address'], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]);
  return '0x' + hex(keccak256(Uint8Array.from(body.slice(2).match(/../g)!.map((b) => parseInt(b, 16)))));
}

const keyTuple = (k: V4PoolKey): unknown[] => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];

export interface V4Route {
  key: V4PoolKey;
  zeroForOne: boolean;
  amountOut: bigint;
}

export class EvmV4Adapter {
  constructor(
    readonly entry: DexEntry,
    private readonly read: EvmRead,
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

  /** What the V4 quoter says `amountIn` of the first currency gets in the second, through one pool; null if it refuses. */
  async quote(key: V4PoolKey, zeroForOne: boolean, amountIn: bigint, block?: bigint): Promise<bigint | null> {
    if (amountIn <= 0n || amountIn > MAX_U128) return null;
    try {
      const data = encodeFunction(`quoteExactInputSingle((${POOL_KEY},bool,uint128,bytes))`, [[keyTuple(key), zeroForOne, amountIn, '0x']]);
      const [out] = decodeParams(['uint256', 'uint256'], await this.call(this.entry.quoter!, data, block)) as [bigint];
      return out > 0n ? out : null;
    } catch {
      return null;
    }
  }

  /** The best hookless pool of the pair across the standard tiers. `tokenIn` and `tokenOut` may be the zero address (the native coin). */
  async bestRoute(tokenIn: string, tokenOut: string, amountIn: bigint, block?: bigint): Promise<V4Route | null> {
    const isNativeAddr = (a: string): boolean => a.toLowerCase() === ZERO_ADDRESS;
    const a = isNativeAddr(tokenIn) ? ZERO_ADDRESS : normalizeTokenRef(this.entry.chain, tokenIn)?.address;
    const b = isNativeAddr(tokenOut) ? ZERO_ADDRESS : normalizeTokenRef(this.entry.chain, tokenOut)?.address;
    if (!a || !b || a === b) throw new SwingsError('invalid', 'Invalid token pair for this network.');
    if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
    const zeroForOne = BigInt(a) < BigInt(b);
    const routes = await Promise.all(
      V4_TIERS.map(async ([fee, spacing]): Promise<V4Route | null> => {
        const key = poolKeyOf(a, b, fee, spacing);
        if (!(await this.live(key, block))) return null;
        const out = await this.quote(key, zeroForOne, amountIn, block);
        return out === null ? null : { key, zeroForOne, amountOut: out };
      }),
    );
    return routes.filter((r): r is V4Route => r !== null).sort((x, y) => (x.amountOut > y.amountOut ? -1 : x.amountOut < y.amountOut ? 1 : 0))[0] ?? null;
  }
}

export interface V4SwapParams {
  key: V4PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  minOut: bigint;
  /** Unix seconds after which the router refuses the swap. */
  deadline: number;
}

/**
 * `execute` on the Universal Router with one V4 swap command: swap exactly `amountIn` through the pool, settle what is owed
 * (the native coin is attached to the call; a token is pulled through Permit2) and take at least `minOut` of the other currency.
 */
export function buildV4Swap(entry: DexEntry, p: V4SwapParams): EvmTxPlan {
  if (entry.mechanism !== 'evm-v4-router' || !entry.router) throw new SwingsError('invalid', `${entry.id} cannot build Uniswap V4 swaps.`);
  const k = p.key;
  if (!isAddr(k.currency0) || !isAddr(k.currency1) || !isAddr(k.hooks)) throw new SwingsError('invalid', 'Invalid pool.');
  if (k.hooks.toLowerCase() !== ZERO_ADDRESS) throw new SwingsError('invalid', 'Pools with a hooks contract are not supported.');
  if (BigInt(k.currency0) >= BigInt(k.currency1)) throw new SwingsError('invalid', 'The pool currencies are out of order.');
  if (p.amountIn <= 0n || p.amountIn > MAX_U128) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (p.minOut <= 0n || p.minOut > MAX_U128) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  if (!Number.isInteger(p.deadline) || p.deadline <= 0) throw new SwingsError('invalid', 'A swap needs a deadline.');
  const currencyIn = p.zeroForOne ? k.currency0 : k.currency1;
  const currencyOut = p.zeroForOne ? k.currency1 : k.currency0;
  const swap = strip(encodeFunction(`x((${POOL_KEY},bool,uint128,uint128,bytes))`, [[keyTuple(k), p.zeroForOne, p.amountIn, p.minOut, '0x']]));
  const settle = strip(encodeFunction('x(address,uint256)', [currencyIn, p.amountIn]));
  const take = strip(encodeFunction('x(address,uint256)', [currencyOut, p.minOut]));
  const actions = '0x' + ACTION_SWAP_EXACT_IN_SINGLE + ACTION_SETTLE_ALL + ACTION_TAKE_ALL;
  const input = strip(encodeFunction('x(bytes,bytes[])', [actions, [swap, settle, take]]));
  const native = currencyIn === ZERO_ADDRESS;
  return {
    chain: entry.chain,
    to: entry.router.toLowerCase(),
    data: encodeFunction('execute(bytes,bytes[],uint256)', ['0x' + COMMAND_V4_SWAP, ['0x' + input.slice(2)], BigInt(p.deadline)]),
    value: native ? p.amountIn : 0n,
    // Permit2 pulls the token, so the token is approved to Permit2 (and Permit2 to the router; see `permit2Approval`).
    approval: native ? null : { token: currencyIn, spender: PERMIT2, amount: p.amountIn },
    summary: `${entry.name}: swap exactly ${p.amountIn} (raw) of ${native ? 'the native coin' : currencyIn} for at least ${p.minOut} (raw) of ${currencyOut === ZERO_ADDRESS ? 'the native coin' : currencyOut}, or the whole transaction fails.`,
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
