import { beforeEach, describe, expect, it } from 'vitest';
import { fetchMarketIntel, intelNow, resetIntelClient, validIntel } from './client.js';
import { computeIntel } from './compute.js';
import { NO_HISTORY } from './ammi.js';

const good = computeIntel([], 'all', 1_000, { history: NO_HISTORY, venuesPrev: null });
const answer = (body: unknown, ok = true) => (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;

describe('the page read of the market intelligence endpoint', () => {
  beforeEach(resetIntelClient);
  it('accepts the shape the cards draw and nothing else', () => {
    expect(validIntel(JSON.parse(JSON.stringify(good)))).not.toBeNull();
    expect(validIntel({ error: 'index' })).toBeNull();
    expect(validIntel(null)).toBeNull();
    expect(validIntel({ asOf: 1, ammi: {}, arf: { h24: {} }, adv: { venues: [] }, confidence: {} })).toBeNull(); // a window is missing
  });
  it('keeps an answer for a minute per network and asks for the network chosen', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => (urls.push(String(u)), new Response(JSON.stringify(good)))) as unknown as typeof fetch;
    expect(await fetchMarketIntel('bnb', 0, f)).not.toBeNull();
    expect(urls[0]).toBe('/api/swings-market?src=intel&chain=bnb');
    await fetchMarketIntel('bnb', 30_000, f);
    expect(urls).toHaveLength(1);
    await fetchMarketIntel('bnb', 61_000, f);
    expect(urls).toHaveLength(2);
    await fetchMarketIntel('', 61_000, f);
    expect(urls[2]).toBe('/api/swings-market?src=intel');
    expect(intelNow('bnb')).not.toBeNull();
    expect(intelNow('polygon')).toBeNull();
  });
  it('keeps what it had when a read fails, and gives nothing (not a made-up figure) when it never had anything', async () => {
    expect(await fetchMarketIntel('bnb', 0, answer({ error: 'index' }))).toBeNull();
    expect(await fetchMarketIntel('bnb', 100_000, answer(good))).not.toBeNull();
    expect(await fetchMarketIntel('bnb', 200_000, answer({}, false))).not.toBeNull();
    expect(await fetchMarketIntel('solana', 0, (async () => { throw new Error('down'); }) as unknown as typeof fetch)).toBeNull();
  });
});
