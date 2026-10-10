import { describe, expect, it } from 'vitest';
import { MAX_CONCURRENT_PER_NODE, publicRead } from './evmSession.js';

/** A fetch that answers every request after a short wait, and remembers how many were in flight at once. */
function slowFetch() {
  const stats = { active: 0, peak: 0, calls: 0 };
  const impl = (async () => {
    stats.calls++;
    stats.active++;
    stats.peak = Math.max(stats.peak, stats.active);
    await new Promise((r) => setTimeout(r, 15));
    stats.active--;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, stats };
}

describe('reading a public node', () => {
  it('never has more than a few requests in flight to one node, however many are asked for at once', async () => {
    const { impl, stats } = slowFetch();
    // Two readers for the same chain, as two parts of the page would have: they share the limit.
    const a = publicRead('robinhood', impl);
    const b = publicRead('robinhood', impl);
    const answers = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b)('eth_chainId', [])));
    expect(answers.every((x) => x === '0x1')).toBe(true);
    expect(stats.calls).toBe(12);
    expect(stats.peak).toBe(MAX_CONCURRENT_PER_NODE);
  });

  it('keeps nodes apart: a busy node does not hold up another one', async () => {
    const { impl, stats } = slowFetch();
    const robinhood = publicRead('robinhood', impl);
    const base = publicRead('base', impl);
    await Promise.all([...Array.from({ length: 6 }, () => robinhood('eth_chainId', [])), ...Array.from({ length: 6 }, () => base('eth_chainId', []))]);
    expect(stats.peak).toBe(MAX_CONCURRENT_PER_NODE * 2);
  });

  it('still frees its place when a read fails, so later reads are not stuck', async () => {
    let n = 0;
    const flaky = (async () => {
      n++;
      if (n <= 4) return new Response('{}', { status: 500 });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2' }), { status: 200 });
    }) as unknown as typeof fetch;
    const read = publicRead('robinhood', flaky);
    const first = await Promise.allSettled(Array.from({ length: 4 }, () => read('eth_chainId', [])));
    expect(first.every((r) => r.status === 'rejected')).toBe(true);
    expect(await read('eth_chainId', [])).toBe('0x2');
  });
});
