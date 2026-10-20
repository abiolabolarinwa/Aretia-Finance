/* The fee-key monitor (scripts/fee-key-monitor.mjs, audit M-2), loaded by a computed path like the other operator scripts. */
import { describe, expect, it } from 'vitest';
import { FEE_ADDRESS as APP_FEE_ADDRESS } from './walletLaunchEvmCore';

/* eslint-disable @typescript-eslint/no-explicit-any */
const spec = '../../scripts/fee-key-monitor.mjs';
const m: any = await import(/* @vite-ignore */ spec);

const reply = (results: Record<string, unknown>): typeof fetch => (async (_u: string, init: { body: string }) => {
  const { method } = JSON.parse(init.body) as { method: string };
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: results[method] }));
}) as never;

describe('the fee-key monitor', () => {
  it('watches the same fee address the app pays, on Ethereum, BNB Chain and Polygon', () => {
    expect(m.FEE_ADDRESS).toBe(APP_FEE_ADDRESS);
    expect(m.CHAINS.map((c: { chainId: number }) => c.chainId)).toEqual([1, 56, 137]);
  });
  it('alerts on an EIP-7702 delegation or any code, and is calm only on none', () => {
    expect(m.classifyCode('0x').state).toBe('clean');
    expect(m.classifyCode('0xef0100' + 'ab'.repeat(20))).toEqual({ state: 'alert', detail: `EIP-7702 delegation to 0x${'ab'.repeat(20)}` });
    expect(m.classifyCode('0x6080604052').state).toBe('alert');
    expect(m.classifyCode(null).state).toBe('unreadable');
  });
  it('exits 1 on any alert, 2 when a chain could not be read, 0 otherwise', async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = reply({ eth_chainId: '0x1', eth_getCode: '0xef0100' + '11'.repeat(20) });
      const r = await m.checkChain(m.CHAINS[0], APP_FEE_ADDRESS, 'https://node.example');
      expect(r.state).toBe('alert');
      globalThis.fetch = reply({ eth_chainId: '0x38', eth_getCode: '0x' });
      expect((await m.checkChain(m.CHAINS[0], APP_FEE_ADDRESS, 'https://node.example')).state).toBe('unreadable'); // wrong chain
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(m.exitCodeOf([{ state: 'clean' }, { state: 'alert' }, { state: 'unreadable' }])).toBe(1);
    expect(m.exitCodeOf([{ state: 'clean' }, { state: 'unreadable' }])).toBe(2);
    expect(m.exitCodeOf([{ state: 'clean' }, { state: 'clean' }])).toBe(0);
  });
});
