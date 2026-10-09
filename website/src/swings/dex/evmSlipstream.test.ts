import { describe, expect, it } from 'vitest';
import { selector } from '../engine/abi.js';
import { EVM_SLIPSTREAM } from './entries.js';
import { buildSlipstreamSwap } from './evmSlipstream.js';
import { EvmV3Adapter } from './evmV3.js';

const entry = EVM_SLIPSTREAM[0]!;
const WETH = entry.wrappedNative!;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const AERO = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';
const ME = '0x' + '1'.repeat(40);
const NOW = 1_800_000_000;

describe('Slipstream swaps', () => {
  it('builds exactInputSingle with the tick spacing and the deadline inside the call', () => {
    const plan = buildSlipstreamSwap(entry, { tokens: [WETH, USDC], fees: [100], amountIn: 5n, minOut: 3n, recipient: ME, deadline: NOW + 60, nativeIn: true }, NOW);
    expect(plan.to).toBe(entry.router);
    expect(plan.data.slice(2, 10)).toBe(selector('exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))'));
    const body = plan.data.slice(10);
    expect(body.length).toBe(64 * 8);
    const w = (i: number): string => body.slice(i * 64, i * 64 + 64);
    expect(w(2)).toBe((100).toString(16).padStart(64, '0'));
    expect(w(3).slice(24)).toBe(ME.slice(2));
    expect(BigInt('0x' + w(4))).toBe(BigInt(NOW + 60));
    expect(BigInt('0x' + w(5))).toBe(5n);
    expect(BigInt('0x' + w(6))).toBe(3n);
    expect(plan.value).toBe(5n);
    expect(plan.approval).toBeNull();
  });

  it('asks for an approval of exactly the amount when selling a token, and builds a two-pool path', () => {
    const one = buildSlipstreamSwap(entry, { tokens: [USDC, WETH], fees: [100], amountIn: 9n, minOut: 1n, recipient: ME, deadline: NOW + 60 }, NOW);
    expect(one.approval).toEqual({ token: USDC, spender: entry.router, amount: 9n });
    expect(one.value).toBe(0n);
    const two = buildSlipstreamSwap(entry, { tokens: [USDC, WETH, AERO], fees: [100, 200], amountIn: 9n, minOut: 1n, recipient: ME, deadline: NOW + 60 }, NOW);
    expect(two.data.slice(2, 10)).toBe(selector('exactInput((bytes,address,uint256,uint256,uint256))'));
    expect(two.data.toLowerCase()).toContain(USDC.slice(2) + '000064' + WETH.slice(2).toLowerCase() + '0000c8' + AERO.slice(2));
  });

  it('refuses bad input', () => {
    const ok = { tokens: [USDC, WETH], fees: [100], amountIn: 9n, minOut: 1n, recipient: ME, deadline: NOW + 60 };
    expect(() => buildSlipstreamSwap(entry, { ...ok, minOut: 0n }, NOW)).toThrow();
    expect(() => buildSlipstreamSwap(entry, { ...ok, amountIn: 0n }, NOW)).toThrow();
    expect(() => buildSlipstreamSwap(entry, { ...ok, deadline: NOW - 1 }, NOW)).toThrow();
    expect(() => buildSlipstreamSwap(entry, { ...ok, tokens: [USDC, USDC] }, NOW)).toThrow();
    expect(() => buildSlipstreamSwap(entry, { ...ok, nativeIn: true }, NOW)).toThrow();
  });

  it('the pool lookup uses the int24 form of getPool, and the quoter the int24 tuple', async () => {
    const calls: string[] = [];
    const read = (async (_m: string, params: unknown[]) => {
      calls.push(((params[0] as { data: string }).data ?? '').slice(2, 10));
      return '0x' + '0'.repeat(64);
    }) as never;
    await new EvmV3Adapter(entry, read).hasPool(WETH, USDC, 100);
    expect(calls[0]).toBe(selector('getPool(address,address,int24)'));
  });
});
