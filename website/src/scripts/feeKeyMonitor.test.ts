/* The fee-key monitor (scripts/fee-key-monitor.mjs, audit M-2), loaded by a computed path like the other operator scripts. */
import { readFileSync } from 'node:fs';
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

describe('the fee-key monitor, re-audit', () => {
  const KEYED = 'https://my-endpoint.quiknode.pro/0123456789abcdef/';
  it('never prints a node URL: only the provider domain', async () => {
    expect(m.redactUrl('https://eth-mainnet.g.alchemy.com/v2/SECRETKEY')).toBe('https://…alchemy.com/…');
    expect(m.redactUrl('https://bsc-rpc.publicnode.com')).toBe('https://…publicnode.com/…');
    expect(m.redactUrl('not a url')).toBe('(a node URL)');
    const msg = m.redactIn(`request to ${KEYED} failed (my-endpoint.quiknode.pro, /0123456789abcdef/)`, KEYED);
    expect(msg).not.toMatch(/0123456789abcdef|my-endpoint/);
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => { throw new Error(`fetch failed: ${KEYED}`); }) as never;
      expect(JSON.stringify(await m.checkChain(m.CHAINS[0], APP_FEE_ADDRESS, KEYED))).not.toMatch(/0123456789abcdef|my-endpoint/);
      globalThis.fetch = reply({ eth_chainId: '0x38', eth_getCode: '0x' });
      expect((await m.checkChain(m.CHAINS[0], APP_FEE_ADDRESS, KEYED)).detail).toBe('the node at https://…quiknode.pro/… is chain 56, not 1');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  it('fails (exit 3) after three unreadable runs in a row, and any good or alerting run resets the count', () => {
    expect(m.UNREADABLE_LIMIT).toBe(3);
    let count = 0;
    const codes: number[] = [];
    for (const code of [2, 2, 2, 2, 0, 2]) {
      const next = m.nextUnreadable(count, code);
      count = next.count;
      codes.push(next.code);
    }
    expect(codes).toEqual([2, 2, 3, 3, 0, 2]);
    expect(m.nextUnreadable(5, 1)).toEqual({ count: 0, code: 1 });
    expect(m.nextUnreadable(Number.NaN, 2)).toEqual({ count: 1, code: 2 });
  });
  it('writes a report for the issue with no node URL in it', () => {
    const text = m.reportOf(APP_FEE_ADDRESS, [{ chain: m.CHAINS[0], state: 'alert', detail: 'EIP-7702 delegation to 0x11' }, { chain: m.CHAINS[1], state: 'unreadable', detail: 'a | b' }], 1, 0);
    expect(text).toMatch(/\*\*ALERT\*\*/);
    expect(text).toMatch(/\| Ethereum \| alert \| EIP-7702 delegation to 0x11 \|/);
    expect(text).toMatch(/\| BNB Chain \| unreadable \| a \/ b \|/);
    expect(m.reportOf(APP_FEE_ADDRESS, [], 3, 3)).toMatch(/blind.*3 runs in a row/);
  });
});

describe('the fee-key monitor workflow', () => {
  const yml = readFileSync(new URL('../../../.github/workflows/fee-key-monitor.yml', import.meta.url), 'utf8');
  it('reads node URLs from secrets, may write issues, and opens a security issue and fails on an alert or a blind monitor', () => {
    expect(yml).not.toMatch(/\bvars\./);
    for (const name of ['ETHEREUM_RPC_URL', 'BNB_RPC_URL', 'POLYGON_RPC_URL']) expect(yml).toContain(`${name}: \${{ secrets.${name} }}`);
    expect(yml).toMatch(/permissions:\n {2}contents: read\n {2}issues: write/);
    expect(yml).toMatch(/if: steps\.monitor\.outputs\.code == '1' \|\| steps\.monitor\.outputs\.code == '3'/);
    expect(yml).toMatch(/gh issue create [^\n]*--label security/);
    expect(yml).toMatch(/1\) echo "::error::ALERT[^\n]*exit 1 ;;/);
    expect(yml).toMatch(/3\) echo "::error::[^\n]*exit 1 ;;/);
    expect(yml).toMatch(/FEE_MONITOR_STATE:/);
  });
});
