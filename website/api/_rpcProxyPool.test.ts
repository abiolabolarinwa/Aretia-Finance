import { beforeEach, describe, expect, it, vi } from 'vitest';
import { proxyRpc, resetRateLimit } from './_rpcProxy.js';

const ORIGIN = 'https://aretiafinance.org';
const call = (body: unknown, fetchImpl: typeof fetch, env: Record<string, string> = {}) =>
  proxyRpc({ method: 'POST', origin: ORIGIN, ip: '1.2.3.4', contentType: 'application/json', body: JSON.stringify(body), env, fetchImpl, now: Date.now() });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('the Solana RPC proxy over the RPC Pool', () => {
  beforeEach(() => resetRateLimit());

  it('answers from a node, with the id the caller sent', async () => {
    const f = vi.fn(async () => reply({ jsonrpc: '2.0', id: 1, result: 123 })) as unknown as typeof fetch;
    const out = await call({ jsonrpc: '2.0', id: 77, method: 'getBalance', params: ['x'] }, f);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ jsonrpc: '2.0', id: 77, result: 123 });
  });

  it('moves on to another node when one refuses with 429, and the caller never sees it', async () => {
    const urls: string[] = [];
    const f = vi.fn(async (url: string) => {
      urls.push(url);
      return urls.length === 1 ? reply({}, 429) : reply({ result: 5 });
    }) as unknown as typeof fetch;
    const out = await call({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: ['y'] }, f);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body).result).toBe(5);
    expect(new Set(urls).size).toBe(2);
  });

  it("relays a node's own error (a failed preflight) instead of retrying it elsewhere", async () => {
    const f = vi.fn(async () => reply({ error: { code: -32002, message: 'Transaction simulation failed: Blockhash not found', data: { err: 'BlockhashNotFound' } } })) as unknown as typeof fetch;
    const out = await call({ jsonrpc: '2.0', id: 3, method: 'sendTransaction', params: ['tx'] }, f);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body).error).toMatchObject({ code: -32002, data: { err: 'BlockhashNotFound' } });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('uses a configured node as well as the free ones, and a failing configured node costs the caller nothing', async () => {
    const urls: string[] = [];
    const f = vi.fn(async (url: string) => {
      urls.push(url);
      return url.startsWith('https://paid.example') ? reply({}, 503) : reply({ result: 'ok' });
    }) as unknown as typeof fetch;
    for (let i = 0; i < 12; i++) {
      const out = await call({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: ['k' + i] }, f, { SOLANA_RPC_URL: 'https://paid.example/key123' });
      expect(JSON.parse(out.body).result).toBe('ok');
    }
    expect(urls.some((u) => u.startsWith('https://paid.example'))).toBe(true);
    expect(urls.some((u) => !u.startsWith('https://paid.example'))).toBe(true);
  });

  it('says it is busy, without naming a node, when every node is refusing', async () => {
    const f = vi.fn(async () => reply({}, 429)) as unknown as typeof fetch;
    const out = await call({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: ['z'] }, f);
    expect(out.status).toBe(429);
    expect(out.body).not.toMatch(/publicnode|solana\.com|pocket/);
  });
});
