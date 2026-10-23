import { describe, expect, it } from 'vitest';
import { classifyNodeError, makeRead, RpcError } from './rpc.js';
import { v3PriceScaled } from './evmReads.js';
import { scaledToString } from './math.js';

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const noSleep = async () => undefined;

describe('JSON-RPC reader', () => {
  it('fails over to the next node when one is down or refuses, and returns the first good answer', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url === 'https://a') throw new Error('network down');
      if (url === 'https://b') return reply({}, 429);
      return reply({ jsonrpc: '2.0', id: 1, result: '0x10' });
    }) as unknown as typeof fetch;
    const read = makeRead(['https://a', 'https://b', 'https://c'], { fetchImpl, sleep: noSleep });
    expect(await read('eth_blockNumber', [])).toBe('0x10');
    expect(calls).toEqual(['https://a', 'https://b', 'https://c']);
  });

  it('retries with growing waits when every node is rate limited, then gives up as a transport failure', async () => {
    const waits: number[] = [];
    let n = 0;
    const fetchImpl = (async () => (++n, reply({ error: { code: -32005, message: 'limit exceeded' } }))) as unknown as typeof fetch;
    const read = makeRead(['https://a'], { fetchImpl, attempts: 4, baseDelayMs: 100, sleep: async (ms) => void waits.push(ms) });
    await expect(read('eth_blockNumber', [])).rejects.toMatchObject({ kind: 'transport' });
    expect(n).toBe(4);
    expect(waits.map((w) => Math.floor(w / 100) * 100)).toEqual([100, 200, 400]);
  });

  it('does not retry a node that answered the request with its own error, but moves on when a node cannot serve a method', async () => {
    let n = 0;
    const revert = (async () => (++n, reply({ error: { code: 3, message: 'execution reverted' } }))) as unknown as typeof fetch;
    await expect(makeRead(['https://a', 'https://b'], { fetchImpl: revert, sleep: noSleep })('eth_call', [])).rejects.toMatchObject({ kind: 'node-error' });
    expect(n).toBe(1);
    const urls: string[] = [];
    const mixed = (async (url: string) => (urls.push(url), url === 'https://a' ? reply({ error: { message: 'The method eth_getLogs is not supported.' } }) : reply({ result: [] }))) as unknown as typeof fetch;
    expect(await makeRead(['https://a', 'https://b'], { fetchImpl: mixed, sleep: noSleep })('eth_getLogs', [])).toEqual([]);
    expect(urls).toEqual(['https://a', 'https://b']);
  });

  it('classifies node messages', () => {
    expect(classifyNodeError('limit exceeded')).toBe('transport');
    expect(classifyNodeError('query returned more than 10000 results')).toBe('node-error');
    expect(classifyNodeError('block range is too wide')).toBe('node-error');
    expect(classifyNodeError('execution reverted')).toBe('node-error');
    expect(new RpcError('x', 'transport').kind).toBe('transport');
  });

  it('keeps no more requests in flight than its concurrency', async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = (async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return reply({ result: '0x1' });
    }) as unknown as typeof fetch;
    const read = makeRead(['https://a'], { fetchImpl, concurrency: 3, sleep: noSleep });
    await Promise.all(Array.from({ length: 12 }, () => read('eth_blockNumber', [])));
    expect(peak).toBe(3);
  });
});

describe('V3 price from sqrtPriceX96', () => {
  it('is exact for round numbers and applies decimals', () => {
    const q96 = 1n << 96n;
    expect(scaledToString(v3PriceScaled(q96, 18, 18)!)).toBe('1');
    // sqrt(4) = 2: token0 is worth 4 token1
    expect(scaledToString(v3PriceScaled(2n * q96, 18, 18)!)).toBe('4');
    // token0 has 18 decimals and token1 has 6: raw ratio 1 means 1e12 whole token1 per whole token0... a price of 1e12
    expect(scaledToString(v3PriceScaled(q96, 18, 6)!)).toBe('1000000000000');
    expect(v3PriceScaled(0n, 18, 18)).toBeNull();
  });
});
