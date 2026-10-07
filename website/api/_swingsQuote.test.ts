import { beforeEach, describe, expect, it } from 'vitest';
import { handleQuote, type QuoteInput } from './_swingsQuote';
import { resetRateLimit } from './_rpcProxy';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TAKER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const noNetwork = (async () => {
  throw new Error('no network in unit tests');
}) as unknown as typeof fetch;
const input = (over: Partial<QuoteInput> = {}): QuoteInput => ({
  method: 'GET',
  query: { chain: 'solana', from: SOL, to: USDC, amount: '1000000000', taker: TAKER },
  ip: '1.2.3.4',
  env: { SWINGS_PUBLIC_API: 'on' },
  fetchImpl: noNetwork,
  now: 1_000,
  ...over,
});

describe('public quote API', () => {
  beforeEach(() => resetRateLimit());

  it('is off unless the operator switches it on, and answers cross-origin preflights without doing work', async () => {
    const off = await handleQuote(input({ env: {} }));
    expect(off.status).toBe(503);
    expect(JSON.parse(off.body).error).toBe('not-enabled');
    const pre = await handleQuote(input({ method: 'OPTIONS' }));
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('*');
    expect((await handleQuote(input({ method: 'POST' }))).status).toBe(405);
  });

  it('rejects bad input with a clear 400 and never reaches the network', async () => {
    const bad = async (query: Record<string, string | undefined>) => handleQuote(input({ query: { chain: 'solana', from: SOL, to: USDC, amount: '1000', taker: TAKER, ...query } }));
    for (const q of [{ chain: 'moon' }, { from: 'nope' }, { to: undefined }, { taker: 'x' }, { amount: '0' }, { amount: '-5' }, { amount: '1.5' }, { amount: '9'.repeat(41) }, { slippageBps: '5000' }, { slippageBps: 'x' }, { integrator: 'Bad Name!' }]) {
      const out = await bad(q as Record<string, string | undefined>);
      expect(out.status, JSON.stringify(q)).toBe(400);
      expect(JSON.parse(out.body).error).toBe('invalid');
    }
  });

  it('keeps EVM chains off until the operator lists them, like the wallet', async () => {
    const q = { chain: 'base', from: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '1000', taker: '0x' + '1'.repeat(40) };
    const out = await handleQuote(input({ query: q, env: { SWINGS_PUBLIC_API: 'on' } }));
    expect(out.status).toBe(403);
    expect(JSON.parse(out.body).error).toBe('not-enabled');
  });

  it('reports a provider that cannot answer as a 502 without leaking internals', async () => {
    const out = await handleQuote(input());
    expect(out.status).toBe(502);
    expect(out.body).not.toContain('no network');
  });

  it('is rate limited per caller', async () => {
    let last = 0;
    for (let i = 0; i < 125; i++) last = (await handleQuote(input())).status;
    expect(last).toBe(429);
    expect((await handleQuote(input({ ip: '9.9.9.9' }))).status).not.toBe(429);
  });
});
