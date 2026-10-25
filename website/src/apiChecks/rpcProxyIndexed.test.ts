import { beforeEach, describe, expect, it } from 'vitest';
import { PUBLIC_FALLBACK_RPC, PUBLIC_INDEXED_RPC, proxyRpc, resetRateLimit } from '../../api/_rpcProxy';

const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [] });
const call = (env: { SOLANA_RPC_URL?: string }, fetchImpl: typeof fetch) =>
  proxyRpc({ method: 'POST', origin: 'https://aretiafinance.org', ip: '1.1.1.1', contentType: 'application/json', body, env, fetchImpl, now: 1 });

describe('the RPC proxy and indexed reads', () => {
  beforeEach(() => resetRateLimit());

  it('retries on the second public node when the first refuses with 403', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return url === PUBLIC_FALLBACK_RPC ? new Response('no', { status: 403 }) : new Response('{"jsonrpc":"2.0","id":1,"result":[]}', { status: 200 });
    }) as unknown as typeof fetch;
    const out = await call({}, fetchImpl);
    expect(out.status).toBe(200);
    expect(urls).toEqual([PUBLIC_FALLBACK_RPC, PUBLIC_INDEXED_RPC]);
  });

  it('does not retry elsewhere when a keyed provider is configured', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response('no', { status: 403 });
    }) as unknown as typeof fetch;
    const out = await call({ SOLANA_RPC_URL: 'https://keyed.example/abc' }, fetchImpl);
    expect(out.status).toBe(502);
    expect(urls).toEqual(['https://keyed.example/abc']);
  });
});
