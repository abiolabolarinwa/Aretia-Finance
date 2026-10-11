import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimit } from './_rpcProxy.js';
import { handleRadar, radarAssetId, resetRadarProxy, type RadarEnv, type RadarInput } from './_radarProxy.js';

const ORIGIN = 'https://aretiafinance.org';
const PEPE = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
const MINT = 'So11111111111111111111111111111111111111112';
const KEY = 'not-a-real-key';
const env: RadarEnv = { RADAR_API_URL: 'https://radar.example.com', RADAR_API_KEY: KEY, VERCEL_ENV: 'production' };

interface Call {
  url: string;
  init: RequestInit;
}

function run(over: Partial<RadarInput> & { reply?: (c: Call) => Response } = {}) {
  const calls: Call[] = [];
  const { reply, ...rest } = over;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    calls.push(c);
    return reply ? reply(c) : new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;
  const input: RadarInput = { method: 'GET', origin: ORIGIN, ip: '1.2.3.4', query: { op: 'home' }, body: undefined, env, fetchImpl, now: 1_000_000, ...rest };
  return { calls, out: handleRadar(input), input };
}

const analyze = (over: Partial<RadarInput> = {}) => run({ method: 'POST', query: { op: 'analyze' }, body: { assetId: `solana:${MINT}` }, ...over });

beforeEach(() => {
  resetRadarProxy();
  resetRateLimit();
});

describe('radarAssetId', () => {
  it('accepts Solana mints and EVM addresses on the four supported chains, lower-casing EVM ones', () => {
    expect(radarAssetId(`solana:${MINT}`)).toBe(`solana:${MINT}`);
    expect(radarAssetId(` ethereum:${PEPE} `)).toBe(`ethereum:${PEPE.toLowerCase()}`);
    for (const c of ['base', 'bnb', 'polygon']) expect(radarAssetId(`${c}:${PEPE}`)).toBe(`${c}:${PEPE.toLowerCase()}`);
  });
  it('rejects anything else, so nothing odd ever reaches the upstream address', () => {
    for (const bad of [undefined, 5, '', 'ethereum:0x123', `arbitrum:${PEPE}`, `ethereum:${PEPE}/../x`, `ethereum:${PEPE}?a=1`, `solana:${MINT}x!`, '../etc/passwd', `solana:${'1'.repeat(45)}`]) expect(radarAssetId(bad)).toBeNull();
  });
});

describe('handleRadar: who may ask, and what', () => {
  it('refuses a page that is not an Aretia origin, and answers preflight for one that is', async () => {
    expect((await run({ origin: 'https://evil.example' }).out).status).toBe(403);
    expect((await run({ origin: null }).out).status).toBe(403);
    const pre = await run({ method: 'OPTIONS' }).out;
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(ORIGIN);
  });
  it('knows only the three operations, each with its own method', async () => {
    expect((await run({ query: { op: 'delete' } }).out).status).toBe(404);
    expect((await run({ query: {} }).out).status).toBe(404);
    expect((await run({ method: 'POST', query: { op: 'home' } }).out).status).toBe(405);
    expect((await run({ method: 'GET', query: { op: 'analyze' } }).out).status).toBe(405);
  });
  it('says it is not configured, rather than guessing, when the address or key is missing or unsafe', async () => {
    for (const e of [{ ...env, RADAR_API_URL: undefined }, { ...env, RADAR_API_KEY: ' ' }, { ...env, RADAR_API_URL: 'http://radar.example.com' }, { ...env, RADAR_API_URL: 'nonsense' }, { ...env, RADAR_API_URL: 'http://127.0.0.1:8787' }]) {
      const { calls, out } = run({ env: e });
      expect((await out).status).toBe(503);
      expect(calls).toHaveLength(0);
    }
  });
  it('allows a local http Radar server outside production only', async () => {
    const local = { ...env, RADAR_API_URL: 'http://127.0.0.1:8787', VERCEL_ENV: 'development' };
    const { calls, out } = run({ env: local, origin: 'http://localhost:4321' });
    expect((await out).status).toBe(200);
    expect(calls[0]!.url).toBe('http://127.0.0.1:8787/api/radar');
  });
});

describe('handleRadar: what it sends upstream', () => {
  it('home: a GET with the key in the Authorization header, never in the address', async () => {
    const { calls, out } = run();
    expect((await out).status).toBe(200);
    expect(calls[0]!.url).toBe('https://radar.example.com/api/radar');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.url).not.toContain(KEY);
  });
  it('home answers are kept for thirty seconds', async () => {
    await run().out;
    const b = run({ now: 1_000_000 + 10_000 });
    await b.out;
    expect(b.calls).toHaveLength(0);
    const c = run({ now: 1_000_000 + 31_000 });
    await c.out;
    expect(c.calls).toHaveLength(1);
  });
  it('asset: the id is checked, normalised and encoded into the path', async () => {
    const { calls, out } = run({ query: { op: 'asset', assetId: `ethereum:${PEPE}` } });
    expect((await out).status).toBe(200);
    expect(calls[0]!.url).toBe(`https://radar.example.com/api/radar/${encodeURIComponent(`ethereum:${PEPE.toLowerCase()}`)}`);
    const bad = run({ query: { op: 'asset', assetId: '../admin' } });
    expect((await bad.out).status).toBe(400);
    expect(bad.calls).toHaveLength(0);
  });
  it('analyze: a POST of only the normalised id', async () => {
    const { calls, out } = analyze({ body: { assetId: `base:${PEPE}`, evil: 'x' } });
    expect((await out).status).toBe(200);
    expect(calls[0]!.url).toBe('https://radar.example.com/api/radar/analyze');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ assetId: `base:${PEPE.toLowerCase()}` });
    expect((await analyze({ body: {} }).out).status).toBe(400);
    expect((await analyze({ body: null }).out).status).toBe(400);
  });
});

describe('handleRadar: what the visitor is told', () => {
  const answer = (status: number) => ({ reply: () => new Response('{"error":"internal secret detail: db password"}', { status }) });

  it('passes a good answer through unchanged', async () => {
    const r = await run({ reply: () => new Response('{"summary":{"assetsAnalyzed":3}}') }).out;
    expect(r.body).toBe('{"summary":{"assetsAnalyzed":3}}');
  });
  it("maps upstream problems to plain codes and never repeats the server's own text", async () => {
    const cases: [number, number, string][] = [[401, 502, 'radar-error'], [500, 502, 'radar-error'], [404, 404, 'not-analyzed'], [400, 400, 'bad-asset'], [429, 429, 'radar-busy']];
    for (const [up, down, code] of cases) {
      resetRadarProxy();
      const r = await run({ query: { op: 'asset', assetId: `solana:${MINT}` }, ...answer(up) }).out;
      expect(r.status).toBe(down);
      expect(r.body).toBe(JSON.stringify({ error: code }));
      expect(r.body).not.toMatch(/secret|password/);
    }
  });
  it('reports an unreachable, malformed or oversized answer as a bad gateway', async () => {
    const down = (() => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:443');
    }) as unknown as (c: Call) => Response;
    const r = await run({ reply: down }).out;
    expect(r.status).toBe(502);
    expect(r.body).toBe('{"error":"radar-unreachable"}');
    expect((await run({ reply: () => new Response('not json') }).out).status).toBe(502);
    expect((await run({ reply: () => new Response('x'.repeat(1_000_001)) }).out).status).toBe(502);
  });
});

describe('handleRadar: limits', () => {
  it('allows six analyses a minute per visitor, then asks them to wait, and frees them after the minute', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await analyze({ now: 5_000_000 + i }).out).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 200, 429, 429]);
    expect((await analyze({ now: 5_000_000 + 61_000 }).out).status).toBe(200);
  });
  it("one visitor's limit does not use up another's", async () => {
    for (let i = 0; i < 6; i++) await analyze({ ip: '9.9.9.9', now: 7_000_000 + i }).out;
    expect((await analyze({ ip: '8.8.8.8', now: 7_000_100 }).out).status).toBe(200);
  });
  it("caps analyses across all visitors too, since each spends the Radar server's provider quota", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 62; i++) codes.push((await analyze({ ip: `10.0.0.${i}`, now: 9_000_000 + i }).out).status);
    expect(codes.slice(0, 60).every((c) => c === 200)).toBe(true);
    expect(codes.slice(60)).toEqual([429, 429]);
  });
});
