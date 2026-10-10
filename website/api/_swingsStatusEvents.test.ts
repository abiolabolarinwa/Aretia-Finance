import { describe, expect, it, vi } from 'vitest';
import { handleStatus } from './_swingsStatus';
import { cleanEvent, handleEvents } from './_swingsEvents';

const ORIGIN = 'https://aretiafinance.org';

describe('status endpoint', () => {
  it('reports yes/no and chain ids only, never a secret', () => {
    const out = handleStatus({ method: 'GET', origin: ORIGIN, env: { ZEROX_API_KEY: 'secret-key-value', SWINGS_EVM_CHAINS: 'Base, polygon, solana, nonsense', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'srv-secret' } });
    expect(JSON.parse(out.body)).toEqual({ evm: { configured: true, chains: ['base', 'polygon'] }, tokens: true, records: true, analytics: false, aggregators: true, canary: null, protectedSubmit: false });
    expect(out.body).not.toContain('secret');
    expect(out.body).not.toContain('supabase.co');
  });
  it('lets the operator switch the non-core aggregators off', () => {
    expect(JSON.parse(handleStatus({ method: 'GET', origin: ORIGIN, env: { SWINGS_AGGREGATORS: 'off' } }).body).aggregators).toBe(false);
    expect(JSON.parse(handleStatus({ method: 'GET', origin: ORIGIN, env: { SWINGS_AGGREGATORS: 'on' } }).body).aggregators).toBe(true);
  });
  it('lists operator-enabled chains with or without the 0x key, and is closed to other origins', () => {
    expect(JSON.parse(handleStatus({ method: 'GET', origin: ORIGIN, env: { SWINGS_EVM_CHAINS: 'base' } }).body).evm).toEqual({ configured: false, chains: ['base'] });
    // Unset means every EVM network is on; a set value is an allow-list; "none" switches them all off.
    expect(JSON.parse(handleStatus({ method: 'GET', origin: ORIGIN, env: {} }).body).evm).toEqual({ configured: false, chains: ['ethereum', 'bnb', 'polygon', 'base', 'arbitrum', 'optimism', 'avalanche', 'robinhood'] });
    expect(JSON.parse(handleStatus({ method: 'GET', origin: ORIGIN, env: { SWINGS_EVM_CHAINS: '  ' } }).body).evm.chains).toHaveLength(8);
    expect(JSON.parse(handleStatus({ method: 'GET', origin: ORIGIN, env: { SWINGS_EVM_CHAINS: 'none' } }).body).evm.chains).toEqual([]);
    expect(JSON.parse(handleStatus({ method: 'GET', origin: ORIGIN, env: { SWINGS_EVM_CHAINS: 'base, ARBITRUM, solana' } }).body).evm.chains).toEqual(['base', 'arbitrum']);
    expect(handleStatus({ method: 'GET', origin: 'https://evil.example', env: {} }).status).toBe(403);
    expect(handleStatus({ method: 'POST', origin: ORIGIN, env: {} }).status).toBe(405);
  });
});

describe('analytics events endpoint', () => {
  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'srv', PUBLIC_SWINGS_ANALYTICS: '1' };
  const input = (body: unknown, over: Record<string, unknown> = {}) => ({
    method: 'POST', origin: ORIGIN, ip: '5.5.5.5', contentType: 'text/plain', body: JSON.stringify(body), env, now: 1_000,
    fetchImpl: vi.fn(async () => new Response('', { status: 201 })) as unknown as typeof fetch, ...over,
  });

  it('keeps only allow-listed fields and drops anything personal', () => {
    const e = cleanEvent({ name: 'swap', chain: 'base', provider: '0x', status: 'confirmed', ms: 5, account: '0xabc', txId: 'sig', amount: '5', note: 'hi' }, 7);
    expect(e).toEqual({ at: 7, name: 'swap', chain: 'base', provider: '0x', status: 'confirmed', ms: 5, count: null, rival: null, diff_bps: null });
    expect(JSON.stringify(e)).not.toMatch(/0xabc|sig|amount|hi/);
    expect(cleanEvent({ name: 'drop_tables' }, 1)).toBeNull();
    expect(cleanEvent({ name: 'swap', chain: 'moon', provider: 'bad provider!', status: 'x', ms: -5 }, 1)).toEqual({ at: 1, name: 'swap', chain: null, provider: null, status: null, ms: null, count: null, rival: null, diff_bps: null });
  });
  it('writes the cleaned rows with the server clock and no IP', async () => {
    const i = input({ events: [{ name: 'swap', chain: 'solana', provider: 'jupiter', status: 'confirmed', ms: 900, account: 'leak' }] });
    const out = await handleEvents(i);
    expect(out.status).toBe(202);
    const sent = (i.fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1].body as string;
    expect(JSON.parse(sent)).toEqual([{ at: 1_000, name: 'swap', chain: 'solana', provider: 'jupiter', status: 'confirmed', ms: 900, count: null, rival: null, diff_bps: null }]);
    expect(sent).not.toMatch(/leak|5\.5\.5\.5/);
  });
  it('is off unless analytics and the database are configured, and rejects junk', async () => {
    expect((await handleEvents(input({ events: [{ name: 'swap' }] }, { env: { ...env, PUBLIC_SWINGS_ANALYTICS: '0' } }))).status).toBe(503);
    expect((await handleEvents(input({ events: [{ name: 'swap' }] }, { env: {} }))).status).toBe(503);
    expect((await handleEvents(input({ events: [{ name: 'nope' }] }))).status).toBe(400);
    expect((await handleEvents(input({ nothing: 1 }))).status).toBe(400);
    expect((await handleEvents(input({}, { body: '{' }))).status).toBe(400);
    expect((await handleEvents(input({}, { origin: 'https://evil.example' }))).status).toBe(403);
    expect((await handleEvents(input({}, { method: 'GET' }))).status).toBe(405);
    expect((await handleEvents(input({ events: [{ name: 'swap' }], pad: 'x'.repeat(5000) }))).status).toBe(413);
  });
  it('reports a database failure without details', async () => {
    const fetchImpl = vi.fn(async () => new Response('secret detail', { status: 500 })) as unknown as typeof fetch;
    const out = await handleEvents(input({ events: [{ name: 'swap', provider: 'x' }] }, { fetchImpl }));
    expect(out.status).toBe(502);
    expect(out.body).not.toContain('secret');
  });
});
