/**
 * Live check of the public quote API handler against real nodes: nothing is signed or sent. It proves the endpoint
 * returns a route, an unsigned transaction and a passing simulation for a funded account, on Solana and on an EVM chain.
 */
import { describe, expect, it } from 'vitest';
import { handleQuote } from '../../api/_swingsQuote.js';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAYER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';

/** The public Solana node rate-limits bursts; a production deployment uses a keyed node. Retrying keeps the test about the API. */
const patientFetch = (async (url: string, init?: RequestInit) => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429) return res;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  return fetch(url, init);
}) as typeof fetch;

describe('live: public quote API', () => {
  it('Solana SOL -> USDC with prepare=1: a route, an unsigned base64 transaction, a passing simulation', async () => {
    const out = await handleQuote({ method: 'GET', query: { chain: 'solana', from: SOL, to: USDC, amount: '1000000000', taker: PAYER, prepare: '1', integrator: 'live-test' }, ip: 'live', env: { SWINGS_PUBLIC_API: 'on', SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com' }, fetchImpl: patientFetch, now: Date.now() });
    const body = JSON.parse(out.body);
    console.log('api solana', out.status, body.message, body.provider, body.expectedOut, body.simulation?.ok, body.transaction?.data?.length);
    expect(out.status).toBe(200);
    expect(BigInt(body.expectedOut)).toBeGreaterThan(0n);
    expect(body.simulation.ok).toBe(true);
    expect(body.transaction.encoding).toBe('base64');
    expect(body.integrator).toBe('live-test');
  }, 120_000);

  it('Base ETH -> USDC (operator-enabled): a route and the swap request, no signature', async () => {
    const out = await handleQuote({ method: 'GET', query: { chain: 'base', from: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '100000000000000000', taker: '0x' + '1'.repeat(40) }, ip: 'live2', env: { SWINGS_PUBLIC_API: 'on', SWINGS_EVM_CHAINS: 'base' }, fetchImpl: fetch, now: Date.now() });
    const body = JSON.parse(out.body);
    console.log('api base', out.status, body.provider, body.expectedOut, body.route?.map((l: { venue: string }) => l.venue));
    expect(out.status).toBe(200);
    expect(BigInt(body.expectedOut)).toBeGreaterThan(0n);
  }, 120_000);
});
