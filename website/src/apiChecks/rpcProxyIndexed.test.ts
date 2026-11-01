import { beforeEach, describe, expect, it } from 'vitest';
import { PUBLIC_FALLBACK_RPC, PUBLIC_INDEXED_RPC, proxyRpc, resetRateLimit } from '../../api/_rpcProxy';

const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [] });
const call = (env: { SOLANA_RPC_URL?: string }, fetchImpl: typeof fetch) =>
  proxyRpc({ method: 'POST', origin: 'https://aretiafinance.org', ip: '1.1.1.1', contentType: 'application/json', body, env, fetchImpl, now: 1 });

describe('the RPC proxy and indexed reads', () => {
  beforeEach(() => resetRateLimit());

  it('goes to another public node when one refuses an indexed read with 403', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return url === PUBLIC_FALLBACK_RPC ? new Response('no', { status: 403 }) : new Response('{"jsonrpc":"2.0","id":1,"result":[]}', { status: 200 });
    }) as unknown as typeof fetch;
    const out = await call({}, fetchImpl);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body).result).toEqual([]);
    expect(urls.filter((u) => u === PUBLIC_FALLBACK_RPC).length).toBeLessThanOrEqual(1);
    expect(urls.some((u) => u === PUBLIC_INDEXED_RPC || (u !== PUBLIC_FALLBACK_RPC))).toBe(true);
  });

  it('tries the configured provider and then the free nodes, and answers 504 without naming any of them when all fail', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response('no', { status: 403 });
    }) as unknown as typeof fetch;
    const out = await call({ SOLANA_RPC_URL: 'https://keyed.example/abc' }, fetchImpl);
    expect(out.status).toBe(504);
    expect(urls).toContain('https://keyed.example/abc');
    expect(out.body).not.toContain('keyed.example');
    expect(out.body).not.toContain('abc');
  });
});
