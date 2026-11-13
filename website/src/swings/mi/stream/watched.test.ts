import { describe, expect, it } from 'vitest';
import { watchedReader } from './watched';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

describe('the worker asking which pools are watched', () => {
  it('sends the secret, reads the list, and reuses the answer for a few seconds', async () => {
    let calls = 0;
    let secret: string | null = null;
    let t = 1000;
    const read = watchedReader({
      url: 'http://stream:8090/',
      secret: 's3cret',
      now: () => t,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls++;
        secret = (init.headers as Record<string, string>)['x-stream-secret']!;
        expect(url).toBe('http://stream:8090/watched');
        return json({ keys: ['solana:aaa', 7, 'bnb:0xbb'] });
      }) as unknown as typeof fetch,
    });
    expect(await read()).toEqual(['solana:aaa', 'bnb:0xbb']);
    expect(secret).toBe('s3cret');
    await read();
    expect(calls).toBe(1);
    t += 3_000;
    await read();
    expect(calls).toBe(2);
  });
  it('gives an empty list, never an error, when the service is down, refuses or answers nonsense', async () => {
    const make = (f: () => Promise<Response>) => watchedReader({ url: 'http://x', secret: 's', cacheMs: 0, fetchImpl: f as unknown as typeof fetch });
    expect(await make(async () => { throw new Error('down'); })()).toEqual([]);
    expect(await make(async () => json({}, 401))()).toEqual([]);
    expect(await make(async () => json({ keys: 'no' }))()).toEqual([]);
    expect(await make(async () => new Response('not json'))()).toEqual([]);
  });
});
