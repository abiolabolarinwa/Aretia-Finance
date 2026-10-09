import { describe, expect, it, vi } from 'vitest';
import { EvmChainAdapter } from './evm.js';
import { encodeTransfer, evmFeeTransfer } from './evmFee.js';
import type { EvmWalletAdapter } from './evmWallet.js';
import { DirectEvmProvider } from '../dex/directEvm.js';
import { EVM_V2_DEXES } from '../dex/entries.js';
import { Evm0xProvider } from '../providers/evm0x.js';
import { DEFAULT_FEE_CONFIG, liveFeeConfig } from '../core/fee.js';
import { AretiaDexRegistry } from '../engine/registry.js';
import { selector, decodeUintArray } from '../engine/abi.js';
import { inspectV2Swap } from '../execution/evmV2Builder.js';
import { getAmountOut } from '../engine/amm.js';
import { EVM_NATIVE_ADDRESS, type PreparedSwap, type SwapRequest } from '../core/types.js';

const USER = '0x' + '1'.repeat(40);
const FEE_ADDRESS = '0x' + '9'.repeat(40);
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const HASH = '0x' + 'ab'.repeat(32);

describe('the EVM fee transfer', () => {
  it('encodes an ERC-20 transfer exactly', () => {
    const data = encodeTransfer(FEE_ADDRESS, 2_900n);
    expect(data).toBe('0xa9059cbb' + '0'.repeat(24) + '9'.repeat(40) + (2_900).toString(16).padStart(64, '0'));
    expect(() => encodeTransfer('0x12', 1n)).toThrow(/recipient/);
    expect(() => encodeTransfer(FEE_ADDRESS, 0n)).toThrow(/amount/);
  });

  it('sends the native coin as a plain value transfer and a token as a transfer call to the token, in the asset being sold', () => {
    const native = evmFeeTransfer(USER, EVM_NATIVE_ADDRESS, 29n, FEE_ADDRESS)!;
    expect(native).toMatchObject({ token: EVM_NATIVE_ADDRESS, amount: 29n, recipient: FEE_ADDRESS, tx: { from: USER, to: FEE_ADDRESS, value: '0x1d' } });
    expect(native.tx.data).toBeUndefined();
    const token = evmFeeTransfer(USER, USDC.toUpperCase().replace('0X', '0x'), 29n, FEE_ADDRESS)!;
    expect(token).toMatchObject({ token: USDC, amount: 29n, tx: { from: USER, to: USDC } });
    expect(token.tx.data!.startsWith('0xa9059cbb')).toBe(true);
    expect(token.tx.value).toBeUndefined();
  });

  it('is nothing at all when the fee is zero, and refuses bad addresses', () => {
    expect(evmFeeTransfer(USER, USDC, 0n, FEE_ADDRESS)).toBeNull();
    expect(() => evmFeeTransfer('0x12', USDC, 1n, FEE_ADDRESS)).toThrow(/Invalid address/);
    expect(() => evmFeeTransfer(USER, USDC, 1n, 'nope')).toThrow(/Invalid address/);
  });
});

describe('sending the fee before the swap', () => {
  const wallet = (over: Partial<EvmWalletAdapter> = {}): EvmWalletAdapter & { sends: { to: string; data?: string }[] } => {
    const w = {
      sends: [] as { to: string; data?: string }[],
      connect: async () => [USER],
      disconnect: async () => {},
      getAccounts: async () => [USER],
      getChainId: async () => 1,
      switchChain: vi.fn(async () => {}),
      signTransaction: async () => '0x',
      sendTransaction: async (tx: { to: string; data?: string }) => {
        w.sends.push(tx);
        return HASH;
      },
      signMessage: async () => '0x',
      request: async (m: string) => (m === 'eth_getTransactionReceipt' ? { status: '0x1' } : '0x'),
      ...over,
    };
    return w as never;
  };
  const prepared = (quoteId = 'q'): PreparedSwap => ({
    quoteId,
    chain: 'ethereum',
    simulation: { ok: true, blockers: [], warnings: [] },
    preparedAt: 0,
    payload: {
      chainId: 1,
      taker: USER,
      approval: { tx: { from: USER, to: USDC, data: '0xapprove' }, token: USDC, spender: '0x' + '2'.repeat(40), amount: 1n },
      fee: evmFeeTransfer(USER, USDC, 29n, FEE_ADDRESS),
      swap: { from: USER, to: '0x' + '3'.repeat(40), data: '0xswap', value: '0x0' },
    },
  });

  it('sends the approval, then the fee, then the swap, each confirmed before the next', async () => {
    const w = wallet();
    await new EvmChainAdapter('ethereum', w, { pollMs: 1 }).signAndSubmit(prepared());
    expect(w.sends.map((s) => s.data?.slice(0, 10))).toEqual(['0xapprove', '0xa9059cbb', '0xswap']);
  });

  it('does not send the swap if the fee transaction fails or stays pending', async () => {
    let n = 0;
    const failsOnFee = wallet({ request: async () => ({ status: ++n >= 2 ? '0x0' : '0x1' }) });
    await expect(new EvmChainAdapter('ethereum', failsOnFee, { pollMs: 1 }).signAndSubmit(prepared())).rejects.toMatchObject({ code: 'failed' });
    expect(failsOnFee.sends.map((s) => s.data?.slice(0, 10))).toEqual(['0xapprove', '0xa9059cbb']);
  });

  it('never pays the fee twice for one quote, even when the swap was declined and tried again', async () => {
    let declined = true;
    const w = wallet();
    const send = w.sendTransaction.bind(w);
    w.sendTransaction = async (tx) => {
      if (tx.data === '0xswap' && declined) {
        declined = false;
        throw Object.assign(new Error('rejected'), { code: 'rejected' });
      }
      return send(tx);
    };
    const a = new EvmChainAdapter('ethereum', w, { pollMs: 1 });
    await a.signAndSubmit(prepared()).catch(() => undefined);
    await a.signAndSubmit(prepared()).catch(() => undefined);
    expect(w.sends.filter((s) => s.data?.startsWith('0xa9059cbb'))).toHaveLength(1);
  });
});

describe('the Aretia fee in the Aretia EVM router', () => {
  const entry = EVM_V2_DEXES.find((e) => e.id === 'uniswap-v2-base')!;
  const WETH = entry.wrappedNative!;
  const PAIR = '0x' + 'cd'.repeat(20);
  const word = (v: bigint | string): string => (typeof v === 'bigint' ? v.toString(16) : v.replace('0x', '')).padStart(64, '0');
  const token0 = BigInt(USDC) < BigInt(WETH) ? USDC : WETH;
  const R_USDC = 2_000_000n * 10n ** 6n;
  const R_WETH = 1_000n * 10n ** 18n;
  const [r0, r1] = token0 === USDC ? [R_USDC, R_WETH] : [R_WETH, R_USDC];
  const node = (balance: bigint, nativeBalance: bigint) =>
    (async (method: string, params: unknown[]) => {
      const call = (params?.[0] ?? {}) as { to?: string; data?: string };
      const sel = call.data?.slice(2, 10);
      if (method === 'eth_blockNumber') return '0x64';
      if (method === 'eth_getBalance') return '0x' + nativeBalance.toString(16);
      if (call.to === entry.factory) return '0x' + word(PAIR);
      if (call.to === PAIR && sel === selector('token0()')) return '0x' + word(token0);
      if (call.to === PAIR && sel === selector('getReserves()')) return '0x' + word(r0) + word(r1) + word(1n);
      if (call.to === entry.router && sel === selector('getAmountsOut(uint256,address[])')) {
        const amountIn = BigInt('0x' + call.data!.slice(10, 74));
        return '0x' + word(32n) + word(2n) + word(amountIn) + word(getAmountOut(amountIn, token0 === USDC ? r0 : r1, token0 === USDC ? r1 : r0, 3000));
      }
      if (sel === selector('balanceOf(address)')) return '0x' + word(balance);
      if (sel === selector('allowance(address,address)')) return '0x' + word(10n ** 30n);
      if (call.to === entry.router && sel !== undefined && inspectV2Swap(call.data!)) return '0x' + word(32n) + word(2n) + word(1n) + word(1n);
      return '0x' + word(0n);
    }) as never;
  const provider = (fee = liveFeeConfig(FEE_ADDRESS), balance = 10n ** 12n, nativeBalance = 10n ** 20n) => new DirectEvmProvider({ registry: new AretiaDexRegistry([entry]), read: () => node(balance, nativeBalance), now: () => 1_000_000, fee });
  const req = (over: Partial<SwapRequest> = {}): SwapRequest => ({ chain: 'base', from: { chain: 'base', address: EVM_NATIVE_ADDRESS }, to: { chain: 'base', address: USDC }, amountIn: 10n ** 17n, slippageBps: 100, account: { chain: 'base', address: USER }, ...over });

  it('is off by default: the whole amount is swapped and nothing extra is sent', async () => {
    const p = provider(DEFAULT_FEE_CONFIG);
    const q = await p.getQuote(req());
    expect(q.inAmount).toBe(10n ** 17n);
    expect(q.costs.aretiaFee.amount).toBe(0n);
    expect((await p.buildTransaction(q)).payload).not.toHaveProperty('fee');
  });

  it('takes 0.29% out of a native-coin swap, swaps the rest, and sends the fee as its own value transfer', async () => {
    const p = provider();
    const q = await p.getQuote(req());
    const fee = (10n ** 17n * 29n) / 10_000n;
    expect(q.inAmount).toBe(10n ** 17n - fee);
    expect(q.request.amountIn).toBe(10n ** 17n);
    expect(q.expectedOut).toBe(getAmountOut(10n ** 17n - fee, R_WETH, R_USDC, 3000));
    expect(q.costs.aretiaFee).toMatchObject({ amount: fee, asset: { address: EVM_NATIVE_ADDRESS } });
    const prepared = await p.buildTransaction(q);
    expect(prepared.simulation.ok).toBe(true);
    const payload = prepared.payload as { fee: { tx: { to: string; value: string }; amount: bigint }; swap: { value: string } };
    expect(payload.fee).toMatchObject({ amount: fee, tx: { to: FEE_ADDRESS, value: '0x' + fee.toString(16) } });
    expect(payload.swap.value).toBe('0x' + (10n ** 17n - fee).toString(16));
    expect(prepared.simulation.warnings.join(' ')).toMatch(/0\.29%/);
  });

  it('takes it in the token being sold, so a USDC seller pays in USDC', async () => {
    const p = provider();
    const q = await p.getQuote(req({ from: { chain: 'base', address: USDC }, to: { chain: 'base', address: EVM_NATIVE_ADDRESS }, amountIn: 5_000_000n }));
    expect(q.inAmount).toBe(5_000_000n - 14_500n);
    const payload = (await p.buildTransaction(q)).payload as { fee: { token: string; amount: bigint; tx: { to: string; data: string } } };
    expect(payload.fee).toMatchObject({ token: USDC, amount: 14_500n, tx: { to: USDC } });
    expect(payload.fee.tx.data.startsWith('0xa9059cbb')).toBe(true);
  });

  it('blocks when the balance covers the swap but not the swap and the fee', async () => {
    const p = provider(liveFeeConfig(FEE_ADDRESS), 10n ** 12n, 10n ** 17n - 1n);
    const prepared = await p.buildTransaction(await p.getQuote(req()));
    expect(prepared.simulation.ok).toBe(false);
    expect(prepared.simulation.blockers.join(' ')).toMatch(/swap and the Aretia fee/);
  });

  it('pauses EVM swaps rather than skipping the fee when the EVM fee address is not set', async () => {
    await expect(provider(liveFeeConfig()).getQuote(req())).rejects.toMatchObject({ code: 'config-missing' });
  });
});

describe('the Aretia fee in the 0x route', () => {
  const quoteJson = (buy: string) => ({ buyAmount: buy, minBuyAmount: buy, transaction: { to: '0x0000000000001fF3684f28c67538d4D072C22734', data: '0xdead', value: '0', gas: '100000' }, route: { fills: [] }, issues: {} });
  const provider = (sold: { value?: bigint[] } = {}) => {
    const asked: Record<string, unknown>[] = [];
    const p = new Evm0xProvider({
      fee: liveFeeConfig(FEE_ADDRESS),
      quote: async (body) => {
        asked.push(body);
        return quoteJson('1000');
      },
      rpc: async (_c, method) => (method === 'eth_call' ? '0x' + (10n ** 30n).toString(16) : '0x'),
      now: () => 1_000_000,
    });
    void sold;
    return { p, asked };
  };
  const req: SwapRequest = { chain: 'base', from: { chain: 'base', address: USDC }, to: { chain: 'base', address: EVM_NATIVE_ADDRESS }, amountIn: 1_000_000n, slippageBps: 50, account: { chain: 'base', address: USER } };

  it('asks 0x to swap only what is left after the fee, and says it collects the fee itself', async () => {
    const { p, asked } = provider();
    expect(p.carriesAretiaFee).toBe(true);
    const q = await p.getQuote(req);
    expect(asked[0]!.sellAmount).toBe('997100');
    expect(q.inAmount).toBe(997_100n);
    expect(q.request.amountIn).toBe(1_000_000n);
    expect(q.costs.aretiaFee).toMatchObject({ amount: 2_900n, asset: { address: USDC } });
  });

  it('adds the fee as its own transaction before the swap', async () => {
    const { p } = provider();
    const prepared = await p.buildTransaction(await p.getQuote(req));
    const payload = prepared.payload as { fee: { amount: bigint; token: string; recipient: string } };
    expect(payload.fee).toMatchObject({ amount: 2_900n, token: USDC, recipient: FEE_ADDRESS });
    expect(prepared.simulation.warnings.join(' ')).toMatch(/0\.29%/);
  });

  it('pauses the swap when the fee address is not set', async () => {
    const p = new Evm0xProvider({ fee: liveFeeConfig(), quote: async () => quoteJson('1'), rpc: async () => '0x', now: () => 1_000_000 });
    await expect(p.getQuote(req)).rejects.toMatchObject({ code: 'config-missing' });
  });
});

describe('the decoded amounts used by the fake node', () => {
  it('keeps the helper honest', () => {
    expect(decodeUintArray('0x' + (32n).toString(16).padStart(64, '0') + (1n).toString(16).padStart(64, '0') + (7n).toString(16).padStart(64, '0'))).toEqual([7n]);
  });
});
