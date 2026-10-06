import { describe, expect, it, vi } from 'vitest';
import { handleZeroX, type ZeroXInput } from './_swings0x';

const body = { chainId: 8453, sellToken: '0x' + 'a'.repeat(40), buyToken: '0x' + 'b'.repeat(40), sellAmount: '1000', taker: '0x' + 'c'.repeat(40), slippageBps: 100 };
const input = (over: Partial<ZeroXInput> = {}): ZeroXInput => ({
  method: 'POST',
  origin: 'https://aretiafinance.org',
  ip: '1.2.3.4',
  contentType: 'application/json',
  body: JSON.stringify(body),
  env: { ZEROX_API_KEY: 'test-key-not-real' },
  fetchImpl: vi.fn(async () => new Response(JSON.stringify({ buyAmount: '1' }), { status: 200 })) as unknown as typeof fetch,
  now: 1,
  ...over,
});

describe('0x proxy', () => {
  it('forwards only validated fields and keeps the key server-side', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"buyAmount":"1"}', { status: 200 })) as unknown as typeof fetch;
    const out = await handleZeroX(input({ fetchImpl, body: JSON.stringify({ ...body, evil: 'x', path: '/other' }) }));
    expect(out.status).toBe(200);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url.startsWith('https://api.0x.org/swap/allowance-holder/quote?')).toBe(true);
    expect(url).not.toContain('evil');
    expect((init.headers as Record<string, string>)['0x-api-key']).toBe('test-key-not-real');
    expect(JSON.stringify(out)).not.toContain('test-key-not-real');
  });

  it('answers 503 without a key, and never calls upstream', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const out = await handleZeroX(input({ env: {}, fetchImpl }));
    expect(out.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects other origins, methods, chains, addresses and amounts', async () => {
    expect((await handleZeroX(input({ origin: 'https://evil.example' }))).status).toBe(403);
    expect((await handleZeroX(input({ method: 'GET' }))).status).toBe(405);
    expect((await handleZeroX(input({ body: JSON.stringify({ ...body, chainId: 10 }) }))).status).toBe(400);
    expect((await handleZeroX(input({ body: JSON.stringify({ ...body, taker: 'nope' }) }))).status).toBe(400);
    expect((await handleZeroX(input({ body: JSON.stringify({ ...body, sellAmount: '-1' }) }))).status).toBe(400);
    expect((await handleZeroX(input({ body: JSON.stringify({ ...body, slippageBps: 9999 }) }))).status).toBe(400);
    expect((await handleZeroX(input({ body: '{' }))).status).toBe(400);
  });

  it('never relays an upstream error body', async () => {
    const fetchImpl = vi.fn(async () => new Response('secret upstream detail', { status: 500 })) as unknown as typeof fetch;
    const out = await handleZeroX(input({ fetchImpl }));
    expect(out.status).toBe(502);
    expect(out.body).not.toContain('secret');
  });
});
