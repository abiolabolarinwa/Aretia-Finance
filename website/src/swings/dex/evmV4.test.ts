import { describe, expect, it, vi } from 'vitest';
import { EVM_V4 } from './entries.js';
import { buildV4Swap, EvmV4Adapter, permit2Allowance, permit2ApproveCall, PERMIT2, poolId, poolKeyOf, sortedCurrencies, V4_TIERS, ZERO_ADDRESS } from './evmV4.js';
import { selector } from '../engine/abi.js';

const entry = EVM_V4.find((e) => e.chain === 'ethereum')!;
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const TOKEN = '0x1111111111111111111111111111111111111111';
const word = (v: bigint | string): string => (typeof v === 'bigint' ? v.toString(16) : v.replace(/^0x/, '')).padStart(64, '0');
const join = (...ws: string[]): string => '0x' + ws.join('');

describe('Uniswap V4 pool keys', () => {
  it('orders the two currencies by address, with the native coin (zero) first', () => {
    expect(sortedCurrencies(USDC, ZERO_ADDRESS)).toEqual([ZERO_ADDRESS, USDC]);
    expect(sortedCurrencies(ZERO_ADDRESS, USDC)).toEqual([ZERO_ADDRESS, USDC]);
    expect(sortedCurrencies(TOKEN, USDC)).toEqual([TOKEN, USDC]);
    expect(poolKeyOf(USDC, ZERO_ADDRESS, 500, 10)).toEqual({ currency0: ZERO_ADDRESS, currency1: USDC, fee: 500, tickSpacing: 10, hooks: ZERO_ADDRESS });
  });

  it('gives each key its own id, the same for either order of the pair', () => {
    const a = poolId(poolKeyOf(ZERO_ADDRESS, USDC, 500, 10));
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(poolId(poolKeyOf(USDC, ZERO_ADDRESS, 500, 10))).toBe(a);
    expect(poolId(poolKeyOf(ZERO_ADDRESS, USDC, 3000, 60))).not.toBe(a);
  });

  it('matches the id of the real Ethereum ETH/USDC 0.05% pool', () => {
    // The id of the hookless native ETH / USDC pool with fee 500 and spacing 10 on Ethereum. StateView holds liquidity for exactly this id on the live chain (checked when this was written).
    expect(poolId(poolKeyOf(ZERO_ADDRESS, USDC, 500, 10))).toBe('0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27');
  });
});

describe('the Uniswap V4 venue', () => {
  function readWith(o: { liveFee?: number; out?: bigint; liquidity?: bigint; price?: bigint } = {}) {
    const wantId = poolId(poolKeyOf(ZERO_ADDRESS, USDC, o.liveFee ?? 500, V4_TIERS.find((t) => t[0] === (o.liveFee ?? 500))![1]));
    return vi.fn(async (_m: string, params: unknown[]) => {
      const { to, data } = params[0] as { to: string; data: string };
      const is = (sig: string): boolean => data.startsWith('0x' + selector(sig));
      if (to === entry.stateView) {
        const live = data.includes(wantId.slice(2));
        if (is('getSlot0(bytes32)')) return join(word(live ? (o.price ?? 79228162514264337593543950336n) : 0n), word(0n), word(0n), word(500n));
        if (is('getLiquidity(bytes32)')) return join(word(live ? (o.liquidity ?? 10n ** 18n) : 0n));
      }
      if (to === entry.quoter && is('quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))')) return join(word(o.out ?? 2500n), word(100000n));
      throw new Error('revert');
    });
  }

  it('finds the one live hookless pool across the tiers and prices it, in either direction', async () => {
    const a = new EvmV4Adapter(entry, readWith({ out: 2500n }));
    const buy = await a.bestRoute(ZERO_ADDRESS, USDC, 10n ** 15n);
    expect(buy).toMatchObject({ zeroForOne: true, amountOut: 2500n });
    expect(buy!.key).toEqual(poolKeyOf(ZERO_ADDRESS, USDC, 500, 10));
    expect((await a.bestRoute(USDC, ZERO_ADDRESS, 5n))!.zeroForOne).toBe(false);
  });

  it('offers nothing when no pool is live, has no liquidity or the quoter refuses', async () => {
    expect(await new EvmV4Adapter(entry, readWith({ liquidity: 0n })).bestRoute(ZERO_ADDRESS, USDC, 5n)).toBeNull();
    expect(await new EvmV4Adapter(entry, readWith({ price: 0n })).bestRoute(ZERO_ADDRESS, USDC, 5n)).toBeNull();
    expect(await new EvmV4Adapter(entry, readWith({ out: 0n })).bestRoute(ZERO_ADDRESS, USDC, 5n)).toBeNull();
    expect(await new EvmV4Adapter(entry, readWith()).bestRoute(ZERO_ADDRESS, TOKEN, 5n)).toBeNull();
    const failing = vi.fn(async () => {
      throw new Error('rpc down');
    });
    expect(await new EvmV4Adapter(entry, failing).bestRoute(ZERO_ADDRESS, USDC, 5n)).toBeNull();
  });

  it('refuses a malformed pair or amount, and an entry that is not a V4 one', async () => {
    const a = new EvmV4Adapter(entry, readWith());
    await expect(a.bestRoute(USDC, USDC, 5n)).rejects.toThrow(/Invalid token pair/);
    await expect(a.bestRoute(ZERO_ADDRESS, USDC, 0n)).rejects.toThrow(/above zero/);
    expect(() => new EvmV4Adapter({ ...entry, mechanism: 'evm-v2-router' }, readWith())).toThrow(/not a Uniswap V4 entry/);
  });
});

describe('building a Uniswap V4 swap', () => {
  const key = poolKeyOf(ZERO_ADDRESS, USDC, 500, 10);
  const deadline = 4_000_000_000;

  it('builds a native-coin swap with the coin attached and no approval', () => {
    const plan = buildV4Swap(entry, { key, zeroForOne: true, amountIn: 10n ** 16n, minOut: 24n, deadline });
    expect(plan).toMatchObject({ to: entry.router, value: 10n ** 16n, approval: null });
    expect(plan.data.startsWith('0x' + selector('execute(bytes,bytes[],uint256)'))).toBe(true);
    // One command, 0x10 (V4 swap), and the deadline is the last word.
    expect(plan.data).toContain('10' + '0'.repeat(62));
    // The deadline is the third head word of the call, after the offsets of the two dynamic arguments.
    expect(plan.data.slice(10 + 64 * 2, 10 + 64 * 3)).toBe(word(BigInt(deadline)));
  });

  it('builds a token sale with the token approved to Permit2, and no coin attached', () => {
    const plan = buildV4Swap(entry, { key, zeroForOne: false, amountIn: 5_000_000n, minOut: 1n, deadline });
    expect(plan).toMatchObject({ value: 0n, approval: { token: USDC, spender: PERMIT2, amount: 5_000_000n } });
  });

  it('refuses a pool with a hooks contract, out-of-order currencies, bad amounts or no deadline', () => {
    const p = { key, zeroForOne: true, amountIn: 5n, minOut: 1n, deadline };
    expect(() => buildV4Swap(entry, { ...p, key: { ...key, hooks: TOKEN } })).toThrow(/hooks contract/);
    expect(() => buildV4Swap(entry, { ...p, key: { ...key, currency0: USDC, currency1: ZERO_ADDRESS } })).toThrow(/out of order/);
    expect(() => buildV4Swap(entry, { ...p, amountIn: 0n })).toThrow(/above zero/);
    expect(() => buildV4Swap(entry, { ...p, minOut: 0n })).toThrow(/minimum/);
    expect(() => buildV4Swap(entry, { ...p, deadline: 0 })).toThrow(/deadline/);
    expect(() => buildV4Swap({ ...entry, mechanism: 'evm-v2-router' }, p)).toThrow(/cannot build Uniswap V4/);
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
