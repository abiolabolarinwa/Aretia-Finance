import { describe, expect, it, vi } from 'vitest';
import { EVM_V4 } from './entries.js';
import { buildV4Swap, dexScreenerV4Hints, EvmV4Adapter, hopIn, hopOut, permit2Allowance, permit2ApproveCall, PERMIT2, poolId, poolKeyOf, routeHasHook, sortedCurrencies, V4_TIERS, ZERO_ADDRESS, type V4Hop, type V4PoolKey } from './evmV4.js';
import { selector } from '../engine/abi.js';
import { decodeParams, encodeParams } from '../engine/abiGeneric.js';

const entry = EVM_V4.find((e) => e.chain === 'ethereum')!;
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const TOKEN = '0x1111111111111111111111111111111111111111';
const HOOK = '0x2222222222222222222222222222222222222222';
const word = (v: bigint | string): string => (typeof v === 'bigint' ? v.toString(16) : v.replace(/^0x/, '')).padStart(64, '0');
const join = (...ws: string[]): string => '0x' + ws.join('');
const POOL_KEY = '(address,address,uint24,int24,address)';

describe('Uniswap V4 pool keys', () => {
  it('orders the two currencies by address, with the native coin (zero) first', () => {
    expect(sortedCurrencies(USDC, ZERO_ADDRESS)).toEqual([ZERO_ADDRESS, USDC]);
    expect(sortedCurrencies(ZERO_ADDRESS, USDC)).toEqual([ZERO_ADDRESS, USDC]);
    expect(sortedCurrencies(TOKEN, USDC)).toEqual([TOKEN, USDC]);
    expect(poolKeyOf(USDC, ZERO_ADDRESS, 500, 10)).toEqual({ currency0: ZERO_ADDRESS, currency1: USDC, fee: 500, tickSpacing: 10, hooks: ZERO_ADDRESS });
  });

  it('gives each key its own id, the same for either order of the pair, and a hook changes the id', () => {
    const a = poolId(poolKeyOf(ZERO_ADDRESS, USDC, 500, 10));
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(poolId(poolKeyOf(USDC, ZERO_ADDRESS, 500, 10))).toBe(a);
    expect(poolId(poolKeyOf(ZERO_ADDRESS, USDC, 3000, 60))).not.toBe(a);
    expect(poolId(poolKeyOf(ZERO_ADDRESS, USDC, 500, 10, HOOK))).not.toBe(a);
  });

  it('matches the id of the real Ethereum ETH/USDC 0.05% pool', () => {
    // The id of the hookless native ETH / USDC pool with fee 500 and spacing 10 on Ethereum. StateView holds liquidity for exactly this id on the live chain (checked when this was written).
    expect(poolId(poolKeyOf(ZERO_ADDRESS, USDC, 500, 10))).toBe('0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27');
  });
});

/** A fake node holding a set of live V4 pools, a PositionManager that knows some of them, and a quoter. */
function node(o: { live: V4PoolKey[]; known?: V4PoolKey[]; withCode?: string[]; multi?: bigint; out?: (k: V4PoolKey) => bigint }) {
  const liveIds = new Set(o.live.map(poolId));
  const known = new Map((o.known ?? []).map((k) => [poolId(k).slice(2, 52), k]));
  const code = new Set((o.withCode ?? []).map((a) => a.toLowerCase()));
  return vi.fn(async (method: string, params: unknown[]) => {
    if (method === 'eth_getCode') return code.has(String(params[0]).toLowerCase()) ? '0x6080' : '0x';
    const { to, data } = params[0] as { to: string; data: string };
    const is = (sig: string): boolean => data.startsWith('0x' + selector(sig));
    if (to === entry.stateView) {
      const live = [...liveIds].some((id) => data.includes(id.slice(2)));
      if (is('getSlot0(bytes32)')) return join(word(live ? 79228162514264337593543950336n : 0n), word(0n), word(0n), word(500n));
      if (is('getLiquidity(bytes32)')) return join(word(live ? 10n ** 18n : 0n));
    }
    if (to === entry.positionManager && is('poolKeys(bytes25)')) {
      const k = known.get(data.slice(10, 60));
      return k ? join(word(k.currency0), word(k.currency1), word(BigInt(k.fee)), word(BigInt(k.tickSpacing)), word(k.hooks)) : join(word(0n), word(0n), word(0n), word(0n), word(0n));
    }
    if (to === entry.quoter && is(`quoteExactInputSingle((${POOL_KEY},bool,uint128,bytes))`)) {
      const [[key]] = decodeParams([`(${POOL_KEY},bool,uint128,bytes)`], '0x' + data.slice(10)) as [[[string, string, bigint, bigint, string]]];
      const k: V4PoolKey = { currency0: key[0].toLowerCase(), currency1: key[1].toLowerCase(), fee: Number(key[2]), tickSpacing: Number(key[3]), hooks: key[4].toLowerCase() };
      if (!liveIds.has(poolId(k))) throw new Error('revert');
      return join(word(o.out ? o.out(k) : 2500n), word(100000n));
    }
    if (to === entry.quoter && is('quoteExactInput((address,(address,uint24,int24,address,bytes)[],uint128))')) return join(word(o.multi ?? 7777n), word(100000n));
    throw new Error('revert');
  });
}
const noHints = async (): Promise<string[]> => [];

describe('the Uniswap V4 venue', () => {
  const eth500 = poolKeyOf(ZERO_ADDRESS, USDC, 500, 10);

  it('finds the one live hookless pool across the tiers and prices it, in either direction', async () => {
    const a = new EvmV4Adapter(entry, node({ live: [eth500], out: () => 2500n }), noHints);
    const buy = await a.bestRoute(ZERO_ADDRESS, USDC, 10n ** 15n);
    expect(buy).toMatchObject({ amountOut: 2500n });
    expect(buy!.hops).toEqual([{ key: eth500, zeroForOne: true }]);
    expect((await a.bestRoute(USDC, ZERO_ADDRESS, 5n))!.hops[0]!.zeroForOne).toBe(false);
  });

  it('offers nothing when no pool is live or the quoter refuses', async () => {
    expect(await new EvmV4Adapter(entry, node({ live: [] }), noHints).bestRoute(ZERO_ADDRESS, USDC, 5n)).toBeNull();
    expect(await new EvmV4Adapter(entry, node({ live: [eth500], out: () => 0n }), noHints).bestRoute(ZERO_ADDRESS, USDC, 5n)).toBeNull();
    const failing = vi.fn(async () => {
      throw new Error('rpc down');
    });
    expect(await new EvmV4Adapter(entry, failing, noHints).bestRoute(ZERO_ADDRESS, USDC, 5n)).toBeNull();
  });

  it('refuses a malformed pair or amount, and an entry that is not a V4 one', async () => {
    const a = new EvmV4Adapter(entry, node({ live: [] }), noHints);
    await expect(a.bestRoute(USDC, USDC, 5n)).rejects.toThrow(/Invalid token pair/);
    await expect(a.bestRoute(ZERO_ADDRESS, USDC, 0n)).rejects.toThrow(/above zero/);
    expect(() => new EvmV4Adapter({ ...entry, mechanism: 'evm-v2-router' }, node({ live: [] }), noHints)).toThrow(/not a Uniswap V4 entry/);
  });

  describe('pools with a hooks contract', () => {
    const hooked = poolKeyOf(ZERO_ADDRESS, TOKEN, 8_388_608, 200, HOOK);
    const hint = async (): Promise<string[]> => [poolId(hooked)];

    it('uses a hinted pool once the PositionManager gives back a key whose own id is the one asked for, and the hook is code', async () => {
      const a = new EvmV4Adapter(entry, node({ live: [hooked], known: [hooked], withCode: [HOOK], out: () => 4242n }), hint);
      const r = await a.bestRoute(ZERO_ADDRESS, TOKEN, 10n ** 15n);
      expect(r).toMatchObject({ amountOut: 4242n });
      expect(r!.hops[0]!.key).toEqual(hooked);
      expect(routeHasHook(r!.hops)).toBe(true);
    });

    it('ignores a hinted pool whose hook is not a contract, whose key does not hash to the id, or that the PositionManager does not know', async () => {
      expect(await new EvmV4Adapter(entry, node({ live: [hooked], known: [hooked], withCode: [] }), hint).bestRoute(ZERO_ADDRESS, TOKEN, 5n)).toBeNull();
      const liar = { ...hooked, fee: 3000 };
      const lie = vi.fn(node({ live: [hooked], known: [hooked], withCode: [HOOK] }));
      const wrong = async (m: string, p: unknown[]): Promise<unknown> => {
        const c = p[0] as { to?: string };
        if (c?.to === entry.positionManager) return join(word(liar.currency0), word(liar.currency1), word(BigInt(liar.fee)), word(BigInt(liar.tickSpacing)), word(liar.hooks));
        return lie(m, p);
      };
      expect(await new EvmV4Adapter(entry, wrong, hint).bestRoute(ZERO_ADDRESS, TOKEN, 5n)).toBeNull();
      expect(await new EvmV4Adapter(entry, node({ live: [hooked], known: [], withCode: [HOOK] }), hint).bestRoute(ZERO_ADDRESS, TOKEN, 5n)).toBeNull();
    });

    it('reads a token\'s V4 pool ids from DexScreener, keeping only valid ids of V4 pools', async () => {
      const id = poolId(hooked);
      const f = (async () => new Response(JSON.stringify([{ pairAddress: id, labels: ['v4'] }, { pairAddress: id.toUpperCase().replace('0X', '0x'), labels: ['v4'] }, { pairAddress: '0x' + 'ab'.repeat(32), labels: ['v3'] }, { pairAddress: USDC, labels: ['v4'] }, { labels: ['v4'] }]))) as unknown as typeof fetch;
      expect(await dexScreenerV4Hints(entry, f)(TOKEN)).toEqual([id]);
      expect(await dexScreenerV4Hints(entry, (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch)(USDC)).toEqual([]);
      expect(await dexScreenerV4Hints(entry, (async () => { throw new Error('offline'); }) as unknown as typeof fetch)(USDC)).toEqual([]);
    });
  });

  describe('two hops', () => {
    const ethUsdc = poolKeyOf(ZERO_ADDRESS, USDC, 500, 10);
    const usdcToken = poolKeyOf(USDC, TOKEN, 3000, 60);

    it('goes through a hub when there is no direct pool, and prices the whole path with the quoter', async () => {
      const a = new EvmV4Adapter(entry, node({ live: [ethUsdc, usdcToken], multi: 9001n }), noHints);
      const r = await a.bestRoute(ZERO_ADDRESS, TOKEN, 10n ** 15n);
      expect(r).toMatchObject({ amountOut: 9001n });
      expect(r!.hops).toHaveLength(2);
      expect(hopIn(r!.hops[0]!)).toBe(ZERO_ADDRESS);
      expect(hopOut(r!.hops[0]!)).toBe(USDC);
      expect(hopIn(r!.hops[1]!)).toBe(USDC);
      expect(hopOut(r!.hops[1]!)).toBe(TOKEN);
    });

    it('prefers the direct pool when it pays more, and the two-hop route when that pays more', async () => {
      const direct = poolKeyOf(ZERO_ADDRESS, TOKEN, 10000, 200);
      const rich = await new EvmV4Adapter(entry, node({ live: [ethUsdc, usdcToken, direct], multi: 5_000n, out: (k) => (poolId(k) === poolId(direct) ? 8_000n : 2500n) }), noHints).bestRoute(ZERO_ADDRESS, TOKEN, 10n ** 15n);
      expect(rich!.hops).toHaveLength(1);
      const poor = await new EvmV4Adapter(entry, node({ live: [ethUsdc, usdcToken, direct], multi: 20_000n, out: (k) => (poolId(k) === poolId(direct) ? 1_000n : 2500n) }), noHints).bestRoute(ZERO_ADDRESS, TOKEN, 10n ** 15n);
      expect(poor!.hops).toHaveLength(2);
    });

    it('offers nothing when only one of the two legs exists', async () => {
      expect(await new EvmV4Adapter(entry, node({ live: [ethUsdc] }), noHints).bestRoute(ZERO_ADDRESS, TOKEN, 5n)).toBeNull();
    });
  });
});

describe('the native coin and the wrapped coin', () => {
  const WETH = entry.wrappedNative!;
  const wethToken = poolKeyOf(WETH, TOKEN, 8_388_608, 200, HOOK);

  it('lets a user selling the native coin use a pool that holds the wrapped coin, and says so', async () => {
    const a = new EvmV4Adapter(entry, node({ live: [wethToken], known: [], out: () => 3000n }), async () => [poolId(wethToken)]);
    const withKnown = new EvmV4Adapter(entry, node({ live: [wethToken], known: [wethToken], withCode: [HOOK], out: () => 3000n }), async () => [poolId(wethToken)]);
    expect(await a.bestRoute(ZERO_ADDRESS, TOKEN, 10n ** 15n)).toBeNull(); // the pool is unknown to the PositionManager, so not usable
    const r = await withKnown.bestRoute(ZERO_ADDRESS, TOKEN, 10n ** 15n);
    expect(r).toMatchObject({ wrapIn: true, amountOut: 3000n });
    expect(r!.unwrapOut).toBeUndefined();
    expect(routeHasHook(r!.hops)).toBe(true);
  });

  it('lets a user buying the native coin use a pool that pays the wrapped coin', async () => {
    const a = new EvmV4Adapter(entry, node({ live: [wethToken], known: [wethToken], withCode: [HOOK], out: () => 3000n }), async () => [poolId(wethToken)]);
    const r = await a.bestRoute(TOKEN, ZERO_ADDRESS, 10n ** 15n);
    expect(r).toMatchObject({ unwrapOut: true, amountOut: 3000n });
    expect(r!.wrapIn).toBeUndefined();
  });

  it('prefers a pool that holds the native coin itself when it pays more, with no wrapping', async () => {
    const plain = poolKeyOf(ZERO_ADDRESS, TOKEN, 3000, 60);
    const a = new EvmV4Adapter(entry, node({ live: [wethToken, plain], known: [wethToken], withCode: [HOOK], out: (k) => (poolId(k) === poolId(plain) ? 5000n : 3000n) }), async () => [poolId(wethToken)]);
    const r = await a.bestRoute(ZERO_ADDRESS, TOKEN, 10n ** 15n);
    expect(r!.amountOut).toBe(5000n);
    expect(r!.wrapIn).toBeUndefined();
  });

  it('builds a swap that wraps first: the coin is attached, the wrap command comes first, and the pool is paid from the router', () => {
    // The token sorts before the wrapped coin, so selling the wrapped coin goes from currency1 to currency0.
    const hop: V4Hop = { key: wethToken, zeroForOne: false };
    const plan = buildV4Swap(entry, { hops: [hop], amountIn: 10n ** 16n, minOut: 5n, deadline: 4_000_000_000, wrapIn: true });
    expect(plan).toMatchObject({ value: 10n ** 16n, approval: null });
    expect(plan.summary).toMatch(/wrapping the coin first/);
    // Commands: wrap (0b) then the V4 swap (10). Actions: swap, settle from the router's own balance (0b), take all (0f).
    expect(plan.data).toContain('0b10' + '0'.repeat(60));
    expect(plan.data).toContain('060b0f');
  });

  it('builds a swap that unwraps last: the pool pays the router, which unwraps to the caller', () => {
    const hop: V4Hop = { key: wethToken, zeroForOne: true };
    const plan = buildV4Swap(entry, { hops: [hop], amountIn: 7n, minOut: 5n, deadline: 4_000_000_000, unwrapOut: true });
    expect(plan.approval).toEqual({ token: TOKEN, spender: PERMIT2, amount: 7n });
    expect(plan.value).toBe(0n);
    expect(plan.data).toContain('100c' + '0'.repeat(60));
    expect(plan.data).toContain('060c0e');
  });

  it('refuses to wrap into, or unwrap out of, a pool that does not hold the wrapped coin', () => {
    const plain: V4Hop = { key: poolKeyOf(ZERO_ADDRESS, USDC, 500, 10), zeroForOne: true };
    expect(() => buildV4Swap(entry, { hops: [plain], amountIn: 5n, minOut: 1n, deadline: 4_000_000_000, wrapIn: true })).toThrow(/nothing to wrap/);
    expect(() => buildV4Swap(entry, { hops: [{ ...plain, zeroForOne: false }], amountIn: 5n, minOut: 1n, deadline: 4_000_000_000, unwrapOut: true })).toThrow(/nothing to unwrap/);
  });
});

describe('building a Uniswap V4 swap', () => {
  const key = poolKeyOf(ZERO_ADDRESS, USDC, 500, 10);
  const hop: V4Hop = { key, zeroForOne: true };
  const deadline = 4_000_000_000;

  it('builds a native-coin swap with the coin attached and no approval', () => {
    const plan = buildV4Swap(entry, { hops: [hop], amountIn: 10n ** 16n, minOut: 24n, deadline });
    expect(plan).toMatchObject({ to: entry.router, value: 10n ** 16n, approval: null });
    expect(plan.data.startsWith('0x' + selector('execute(bytes,bytes[],uint256)'))).toBe(true);
    // One command, 0x10 (V4 swap), and the deadline is the third head word of the call, after the offsets of the two dynamic arguments.
    expect(plan.data).toContain('10' + '0'.repeat(62));
    expect(plan.data.slice(10 + 64 * 2, 10 + 64 * 3)).toBe(word(BigInt(deadline)));
  });

  it('builds a token sale with the token approved to Permit2, and no coin attached', () => {
    const plan = buildV4Swap(entry, { hops: [{ key, zeroForOne: false }], amountIn: 5_000_000n, minOut: 1n, deadline });
    expect(plan).toMatchObject({ value: 0n, approval: { token: USDC, spender: PERMIT2, amount: 5_000_000n } });
  });

  it('uses the multi-pool action for two hops, and the single-pool action for one', () => {
    const second: V4Hop = { key: poolKeyOf(USDC, TOKEN, 3000, 60), zeroForOne: BigInt(USDC) < BigInt(TOKEN) };
    const two = buildV4Swap(entry, { hops: [hop, second], amountIn: 10n ** 16n, minOut: 24n, deadline });
    const one = buildV4Swap(entry, { hops: [hop], amountIn: 10n ** 16n, minOut: 24n, deadline });
    // The actions byte string is `swap, settle all, take all`; the first action tells the two apart.
    expect(two.data).toContain('070c0f');
    expect(one.data).toContain('060c0f');
    expect(two.summary).toMatch(/through 2 pools/);
    expect(two.approval).toBeNull();
    expect(two.value).toBe(10n ** 16n);
  });

  it('builds a swap through a pool with a hooks contract (the caller is told about the hook separately)', () => {
    const hooked = poolKeyOf(ZERO_ADDRESS, TOKEN, 8_388_608, 200, HOOK);
    const plan = buildV4Swap(entry, { hops: [{ key: hooked, zeroForOne: true }], amountIn: 5n, minOut: 1n, deadline });
    expect(plan.data).toContain(word(HOOK));
  });

  it('refuses pools that do not connect, out-of-order currencies, bad amounts, no deadline, and a route of the wrong length', () => {
    const p = { hops: [hop], amountIn: 5n, minOut: 1n, deadline };
    const wrongSecond: V4Hop = { key: poolKeyOf(TOKEN, '0x3333333333333333333333333333333333333333', 3000, 60), zeroForOne: true };
    expect(() => buildV4Swap(entry, { ...p, hops: [hop, wrongSecond] })).toThrow(/do not connect/);
    expect(() => buildV4Swap(entry, { ...p, hops: [{ key: { ...key, currency0: USDC, currency1: ZERO_ADDRESS }, zeroForOne: true }] })).toThrow(/out of order/);
    expect(() => buildV4Swap(entry, { ...p, hops: [] })).toThrow(/one to three pools/);
    expect(() => buildV4Swap(entry, { ...p, amountIn: 0n })).toThrow(/above zero/);
    expect(() => buildV4Swap(entry, { ...p, minOut: 0n })).toThrow(/minimum/);
    expect(() => buildV4Swap(entry, { ...p, deadline: 0 })).toThrow(/deadline/);
    expect(() => buildV4Swap({ ...entry, mechanism: 'evm-v2-router' }, p)).toThrow(/cannot build Uniswap V4/);
  });

  it('encodes the standard tiers it searches', () => {
    expect(V4_TIERS.map(([fee]) => fee)).toEqual([100, 500, 3000, 10000]);
    expect(encodeParams(['uint24'], [500])).toHaveLength(66);
  });
});

describe('Permit2', () => {
  it('builds its approve call for exactly one token, spender, amount and expiry', () => {
    const data = permit2ApproveCall(USDC, entry.router!, 7n, 1_900_000_000);
    expect(data.startsWith('0x' + selector('approve(address,address,uint160,uint48)'))).toBe(true);
    expect(data.endsWith(word(7n) + word(1_900_000_000n))).toBe(true);
    expect(() => permit2ApproveCall('0x12', entry.router!, 7n, 5)).toThrow(/Invalid address/);
    expect(() => permit2ApproveCall(USDC, entry.router!, 0n, 5)).toThrow(/approval amount/);
    expect(() => permit2ApproveCall(USDC, entry.router!, 7n, 0)).toThrow(/expiry/);
  });

  it('reads what the router may take', async () => {
    const read = vi.fn(async (...args: unknown[]) => (args.length >= 0 ? join(word(42n), word(1_900_000_000n), word(3n)) : ''));
    expect(await permit2Allowance(read, TOKEN, USDC, entry.router!)).toEqual({ amount: 42n, expiration: 1_900_000_000n });
    expect((read.mock.calls[0]![1] as { to: string }[])[0]!.to).toBe(PERMIT2);
  });
});
