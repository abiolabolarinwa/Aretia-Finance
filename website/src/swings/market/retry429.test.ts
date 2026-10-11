import { describe, expect, it, vi } from 'vitest';
import { fetchRetrying429, RETRY_MAX, RETRY_WAIT_MAX_MS } from './retry429.js';

const answer = (status: number, headers: Record<string, string> = {}) => new Response('{}', { status, headers });

describe('fetchRetrying429', () => {
  it('returns a good answer at once', async () => {
    const f = vi.fn(async () => answer(200)) as unknown as typeof fetch;
    const sleep = vi.fn(async () => undefined);
    expect((await fetchRetrying429(f, 'u', undefined, sleep)).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it('asks again after a 429 and returns the answer that follows', async () => {
    const f = vi.fn().mockResolvedValueOnce(answer(429)).mockResolvedValueOnce(answer(200)) as unknown as typeof fetch;
    const sleep = vi.fn(async () => undefined);
    expect((await fetchRetrying429(f, 'u', undefined, sleep)).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_500);
  });
  it('waits as long as it is told, up to a limit, and gives up after a few tries', async () => {
    const f = vi.fn(async () => answer(429, { 'retry-after': '60' })) as unknown as typeof fetch;
    const sleep = vi.fn(async () => undefined);
    expect((await fetchRetrying429(f, 'u', undefined, sleep)).status).toBe(429);
    expect(f).toHaveBeenCalledTimes(RETRY_MAX + 1);
    expect(sleep).toHaveBeenCalledWith(RETRY_WAIT_MAX_MS);
  });
  it('does not retry other errors', async () => {
    const f = vi.fn(async () => answer(500)) as unknown as typeof fetch;
    expect((await fetchRetrying429(f, 'u', undefined, async () => undefined)).status).toBe(500);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
