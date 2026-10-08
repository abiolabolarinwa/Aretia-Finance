import { describe, expect, it } from 'vitest';
import { cleanRecord, handleRecords, type RecordsEnv } from './_swingsRecords.js';

const ORIGIN = 'https://aretiafinance.org';
const ENV: RecordsEnv = { SUPABASE_URL: 'https://db.example.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key-VALUE' };
const ID = 'x_' + 'a1b2c3d4'.repeat(3);
const rec = (over: Record<string, unknown> = {}) => ({ id: ID, version: 1, state: 'QUOTED', quote: { sourceAmount: { $bigint: '5' } }, steps: {}, history: [], ...over });

interface Call { url: string; method: string; body: string | null; headers: Record<string, string> }
const db = (reply: (c: Call) => Response) => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const c: Call = { url: String(url), method: init?.method ?? 'GET', body: (init?.body as string | undefined) ?? null, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(c);
    return reply(c);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};
let n = 0;
const call = (x: { method: string; query?: Record<string, string>; body?: unknown; origin?: string | null; env?: RecordsEnv; fetchImpl: typeof fetch; contentType?: string | null }) =>
  handleRecords({ method: x.method, origin: x.origin === undefined ? ORIGIN : x.origin, ip: `10.0.0.${++n}`, contentType: x.contentType === undefined ? 'application/json' : x.contentType, query: x.query ?? {}, body: x.body === undefined ? '' : JSON.stringify(x.body), env: x.env ?? ENV, fetchImpl: x.fetchImpl, now: 1000 });

describe('cleanRecord', () => {
  it('accepts a well-formed record and refuses anything else', () => {
    expect(cleanRecord('settlement', rec())).toMatchObject({ ok: true, value: { id: ID, version: 1, state: 'QUOTED' } });
    expect(cleanRecord('plan', rec({ state: 'RUNNING' })).ok).toBe(true);
    expect(cleanRecord('nope', rec())).toEqual({ ok: false, reason: 'kind' });
    expect(cleanRecord('settlement', rec({ id: 'short' }))).toEqual({ ok: false, reason: 'id' });
    expect(cleanRecord('settlement', rec({ id: ID.toUpperCase() }))).toEqual({ ok: false, reason: 'id' });
    expect(cleanRecord('settlement', rec({ version: 0 }))).toEqual({ ok: false, reason: 'version' });
    expect(cleanRecord('settlement', rec({ state: 'RUNNING' }))).toEqual({ ok: false, reason: 'state' }); // a plan state on an execution
    expect(cleanRecord('plan', rec({ state: 'QUOTED' }))).toEqual({ ok: false, reason: 'state' });
    expect(cleanRecord('settlement', [1])).toEqual({ ok: false, reason: 'shape' });
  });

  it('refuses secret-looking fields at any depth, over-deep nesting and huge strings, so keys cannot be stored by accident', () => {
    for (const bad of [{ privateKey: 'x' }, { nested: { deeper: { mnemonic: 'x' } } }, { list: [{ apiKey: 'k' }] }, { cardNumber: '4242' }]) expect(cleanRecord('settlement', rec(bad)), JSON.stringify(bad)).toEqual({ ok: false, reason: 'content' });
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 30; i++) deep = (deep.a = {}) as Record<string, unknown>;
    expect(cleanRecord('settlement', rec({ root }))).toEqual({ ok: false, reason: 'content' });
    expect(cleanRecord('settlement', rec({ blob: 'x'.repeat(5000) }))).toEqual({ ok: false, reason: 'content' });
  });
});

describe('GET', () => {
  it('returns a record by id and 404 when there is none; never lists', async () => {
    const hit = db(() => new Response(JSON.stringify([{ body: rec() }])));
    const ok = await call({ method: 'GET', query: { id: ID }, fetchImpl: hit.fetchImpl });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).record.id).toBe(ID);
    expect(hit.calls[0]!.url).toContain(`id=eq.${ID}`);
    expect((await call({ method: 'GET', query: { id: ID }, fetchImpl: db(() => new Response('[]')).fetchImpl })).status).toBe(404);
    const noId = db(() => new Response('[]'));
    expect((await call({ method: 'GET', fetchImpl: noId.fetchImpl })).status).toBe(400);
    expect(noId.calls).toEqual([]); // no id, no database call: there is no list-everything request
    expect((await call({ method: 'GET', query: { id: 'x" or 1=1' }, fetchImpl: noId.fetchImpl })).status).toBe(400);
  });
});

describe('PUT', () => {
  it('creates with expectedVersion 0 and reports a duplicate id as a conflict', async () => {
    const d = db(() => new Response(null, { status: 201 }));
    const out = await call({ method: 'PUT', body: { kind: 'settlement', record: rec(), expectedVersion: 0 }, fetchImpl: d.fetchImpl });
    expect(out.status).toBe(201);
    expect(d.calls[0]!.method).toBe('POST');
    expect(JSON.parse(d.calls[0]!.body!)).toMatchObject({ id: ID, kind: 'settlement', version: 1, state: 'QUOTED', created_at: 1000, updated_at: 1000 });
    expect((await call({ method: 'PUT', body: { kind: 'settlement', record: rec(), expectedVersion: 0 }, fetchImpl: db(() => new Response('{}', { status: 409 })).fetchImpl })).status).toBe(409);
  });

  it('updates only when the database matches the version the caller last saw, and refuses a stale write', async () => {
    const ok = db(() => new Response(JSON.stringify([{ id: ID }])));
    const out = await call({ method: 'PUT', body: { kind: 'settlement', record: rec({ version: 3, state: 'SETTLEMENT_PENDING' }), expectedVersion: 2 }, fetchImpl: ok.fetchImpl });
    expect(out.status).toBe(200);
    expect(ok.calls[0]!.method).toBe('PATCH');
    expect(ok.calls[0]!.url).toContain(`id=eq.${ID}&version=eq.2&kind=eq.settlement`);
    const stale = await call({ method: 'PUT', body: { kind: 'settlement', record: rec({ version: 3 }), expectedVersion: 2 }, fetchImpl: db(() => new Response('[]')).fetchImpl });
    expect(stale.status).toBe(409);
  });

  it('refuses a version that skips ahead, a bad expectedVersion, a bad record, a wrong content type and an oversize body, with no database call', async () => {
    const d = db(() => new Response('[]'));
    expect((await call({ method: 'PUT', body: { kind: 'settlement', record: rec({ version: 9 }), expectedVersion: 2 }, fetchImpl: d.fetchImpl })).status).toBe(400);
    expect((await call({ method: 'PUT', body: { kind: 'settlement', record: rec(), expectedVersion: -1 }, fetchImpl: d.fetchImpl })).status).toBe(400);
    expect((await call({ method: 'PUT', body: { kind: 'settlement', record: rec({ secretKey: 's' }), expectedVersion: 0 }, fetchImpl: d.fetchImpl })).status).toBe(400);
    expect((await call({ method: 'PUT', body: { kind: 'settlement', record: rec(), expectedVersion: 0 }, contentType: 'text/plain', fetchImpl: d.fetchImpl })).status).toBe(415);
    expect((await call({ method: 'PUT', body: { kind: 'settlement', record: rec({ big: 'x'.repeat(200_000) }), expectedVersion: 0 }, fetchImpl: d.fetchImpl })).status).toBe(413);
    expect(d.calls).toEqual([]);
  });
});

describe('access', () => {
  it('is off without a database, refuses other sites and other methods, and never returns the service key', async () => {
    const d = db(() => new Response('[]'));
    expect((await call({ method: 'GET', query: { id: ID }, env: {}, fetchImpl: d.fetchImpl })).status).toBe(503);
    expect((await call({ method: 'GET', query: { id: ID }, origin: 'https://evil.example', fetchImpl: d.fetchImpl })).status).toBe(403);
    expect((await call({ method: 'DELETE', fetchImpl: d.fetchImpl })).status).toBe(405);
    const all = [await call({ method: 'GET', query: { id: ID }, fetchImpl: d.fetchImpl }), await call({ method: 'PUT', body: { kind: 'settlement', record: rec(), expectedVersion: 0 }, fetchImpl: db(() => new Response(null, { status: 500 })).fetchImpl })];
    for (const a of all) expect(a.body + JSON.stringify(a.headers)).not.toContain('service-key-VALUE');
  });

  it('answers a database failure with 502 and no detail', async () => {
    const out = await call({ method: 'GET', query: { id: ID }, fetchImpl: (async () => { throw new Error('connect ECONNREFUSED db.example.co'); }) as unknown as typeof fetch });
    expect(out).toMatchObject({ status: 502, body: '{"error":"database"}' });
  });

  it('rate-limits one caller', async () => {
    const d = db(() => new Response('[]'));
    const results: number[] = [];
    for (let i = 0; i < 400; i++) results.push((await handleRecords({ method: 'GET', origin: ORIGIN, ip: '99.9.9.9', contentType: null, query: { id: ID }, body: '', env: ENV, fetchImpl: d.fetchImpl, now: 5000 })).status);
    expect(results).toContain(429);
  });
});
