import { beforeEach, describe, expect, it } from 'vitest';
import { EVM_FACTORIES, TOKEN_CREATED_TOPIC } from '../src/swings/launchbox/core.js';
import { buildMetadataJson, publicUrl } from '../src/swings/launchmeta/core.js';
import { resetBudgets } from './_limits.js';
import { resetRateLimit } from './_rpcProxy.js';
import { issueSession } from './_swingsAuth.js';
import { handleMeta, handleUpload, resetUploadState, type UploadEnv, type UploadInput } from './_swingsUpload.js';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://aretiafinance.org';
const SHA = 'ab'.repeat(32);
const SOL_OWNER = 'solana:3Bq9yNGK5WbGpkT1DnBL8nPSCsEdXPC9aVzYcMGzTvEeU';
const CREATOR = '0x' + '1'.repeat(40);
const TOKEN = '0x' + '2'.repeat(40);
const TX = '0x' + 'cd'.repeat(32);
const pad = (a: string) => '0x' + a.replace('0x', '').padStart(64, '0');
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const R2 = 'https://assets.aretiafinance.org';
const OLD = 'https://abcd.supabase.co';
const DB_KEY = 'db-key-for-tests';
const SECRET = 'r2-secret-for-tests';
const env: UploadEnv = { SUPABASE_URL: 'https://data.example.org', SUPABASE_SERVICE_ROLE_KEY: DB_KEY, R2_ACCOUNT_ID: ACCOUNT, R2_ACCESS_KEY_ID: 'AKID', R2_SECRET_ACCESS_KEY: SECRET, R2_BUCKET: 'launch-assets', R2_PUBLIC_BASE: R2 };
const bearer = (owner: string) => `Bearer ${issueSession(DB_KEY, owner, NOW).token}`;
const image = { op: 'sign', kind: 'image', contentType: 'image/png', size: 5000, sha256: SHA };

interface World {
  fetchImpl: typeof fetch;
  calls: string[];
}
function world(opts: { existing?: Set<string>; files?: Record<string, string>; accounts?: unknown[]; receipt?: unknown } = {}): World {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.includes('/rest/v1/account_sessions')) return new Response('[]', { status: 200 });
    if (new URL(url).origin === R2) {
      const path = url.slice(R2.length + 1);
      if (init?.method === 'HEAD') return new Response(null, { status: opts.existing?.has(path) ? 200 : 404 });
      const f = opts.files?.[path];
      return f ? new Response(f) : new Response('', { status: 404 });
    }
    if (url.includes('publicnode')) {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === 'eth_getTransactionReceipt') return new Response(JSON.stringify({ result: opts.receipt ?? null }));
      return new Response(JSON.stringify({ result: { value: opts.accounts ?? [] } }));
    }
    return new Response('', { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
/** The host names of the requests a world saw (calls are "METHOD url"). */
const hostsOf = (calls: string[]): string[] => calls.map((c) => new URL(c.split(' ')[1]!).hostname);
const call = (w: World, body: unknown, over: Partial<UploadInput> = {}) =>
  handleUpload({ method: 'POST', origin: ORIGIN, authorization: bearer(SOL_OWNER), ip: '1.1.1.1', query: {}, body, env, fetchImpl: w.fetchImpl, now: NOW, ...over }).then((r) => ({ status: r.status, data: JSON.parse(r.body || '{}') as Record<string, unknown> }));

beforeEach(() => {
  resetUploadState();
  resetBudgets();
  resetRateLimit();
});

describe('upload to Cloudflare R2', () => {
  it('is enabled without asking any server, and checks the sign-in on the site database, not on storage', async () => {
    const w = world();
    expect((await call(w, { op: 'status' }, { authorization: null })).data).toEqual({ enabled: true });
    expect((await call(w, image)).status).toBe(200);
    const rest = w.calls.filter((c) => new URL(c.split(' ')[1]!).pathname.startsWith('/rest/v1/'));
    expect(rest.length).toBeGreaterThan(0);
    expect(hostsOf(rest).every((h) => h === 'data.example.org')).toBe(true);
    expect(hostsOf(w.calls).some((h) => h.endsWith('supabase.co'))).toBe(false);
  });
  it('hands out a presigned PUT for one path, bound to type and size, valid five minutes, and never the secret', async () => {
    const r = await call(world(), image);
    const u = new URL(String(r.data.uploadUrl));
    expect(u.host).toBe(`${ACCOUNT}.r2.cloudflarestorage.com`);
    expect(u.pathname).toBe(`/launch-assets/img/${SHA}.png`);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(u.searchParams.get('X-Amz-Credential')).toContain('AKID/');
    expect(u.searchParams.get('X-Amz-Credential')).toContain('/auto/s3/aws4_request');
    expect(r.data.url).toBe(`${R2}/img/${SHA}.png`);
    expect(r.data.raw).toBe(true);
    expect(JSON.stringify(r.data)).not.toContain(SECRET);
    const other = await call(world(), { ...image, size: 5001 });
    expect(new URL(String(other.data.uploadUrl)).searchParams.get('X-Amz-Signature')).not.toBe(u.searchParams.get('X-Amz-Signature'));
  });
  it('can leave the size out of the signature when R2_SIGN_CONTENT_LENGTH is 0', async () => {
    const r = await call(world(), image, { env: { ...env, R2_SIGN_CONTENT_LENGTH: '0' } });
    expect(new URL(String(r.data.uploadUrl)).searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
  });
  it('keeps every validation: wallet sign-in, origin, type, size, hash, details size, rate limit', async () => {
    const w = world();
    expect((await call(w, image, { authorization: null })).status).toBe(401);
    expect((await call(w, image, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call(w, { ...image, contentType: 'image/svg+xml' })).status).toBe(400);
    expect((await call(w, { ...image, size: 15 * 1024 * 1024 + 1 })).status).toBe(400);
    expect((await call(w, { ...image, sha256: '../x' })).status).toBe(400);
    expect((await call(w, { op: 'sign', kind: 'json', size: 9000, sha256: SHA })).status).toBe(400);
    for (let i = 0; i < 12; i++) expect((await call(w, { ...image, sha256: i.toString(16).padStart(64, '0') })).status).toBe(200);
    expect((await call(w, { ...image, sha256: 'f'.repeat(64) })).status).toBe(429);
  });
  it('uses the same path layout for details files and does not re-upload a file that exists', async () => {
    const json = await call(world(), { op: 'sign', kind: 'json', size: 200, sha256: SHA });
    expect(new URL(String(json.data.uploadUrl)).pathname).toBe(`/launch-assets/meta/${SHA}.json`);
    expect(json.data.contentType).toBe('application/json');
    const exists = await call(world({ existing: new Set([`img/${SHA}.png`]) }), image);
    expect(exists.data).toEqual({ exists: true, url: `${R2}/img/${SHA}.png` });
  });
  it('treats incomplete or unacceptable R2 settings as not set up, with no fallback to Supabase', async () => {
    const bad: Record<string, string>[] = [{ R2_ACCOUNT_ID: 'short' }, { R2_BUCKET: 'Bad Name' }, { R2_PUBLIC_BASE: 'https://evil.example' }, { R2_PUBLIC_BASE: 'http://assets.aretiafinance.org' }, { R2_PUBLIC_BASE: 'https://aretiafinance.org' }, { R2_SECRET_ACCESS_KEY: '' }];
    for (const patch of bad) {
      const w = world();
      const r = await call(w, { op: 'status' }, { authorization: null, env: { ...env, ...patch, STORAGE_URL: OLD, STORAGE_SERVICE_ROLE_KEY: 'old-key' } });
      expect(r.data.enabled, JSON.stringify(patch)).toBe(false);
      expect(w.calls).toEqual([]);
    }
  });
  it('accepts an Ethereum-style details file only from its creator, keyed by address, overwrite allowed', async () => {
    const created = { status: '0x1', logs: [{ address: EVM_FACTORIES.bnb, topics: [TOKEN_CREATED_TOPIC, pad(TOKEN), pad(CREATOR)], data: '0x' }] };
    const body = { op: 'sign', kind: 'evm-meta', chain: 'bnb', address: TOKEN, size: 300, txHash: TX };
    const ok = await call(world({ receipt: created }), body, { authorization: bearer(`evm:${CREATOR}`) });
    expect(ok.status).toBe(200);
    expect(new URL(String(ok.data.uploadUrl)).pathname).toBe(`/launch-assets/evm/bnb/${TOKEN}.json`);
    expect(ok.data.upsert).toBe(true);
    expect((await call(world({ receipt: created }), body, { authorization: bearer('evm:0x' + '9'.repeat(40)) })).status).toBe(403);
  });
});

describe('reading details back with R2', () => {
  const details = { description: 'A token.', website: 'https://example.org/', x: '', telegram: '' };
  const oldFile = buildMetadataJson({ name: 'Example', symbol: 'EXMP', details, image: publicUrl(OLD, 'launch-assets', `img/${SHA}.png`), imageType: 'image/png' });
  const newFile = buildMetadataJson({ name: 'Example', symbol: 'EXMP', details, image: `${R2}/img/${SHA}.png`, imageType: 'image/png' });
  const get = (w: World, chain: string, address: string) =>
    handleMeta({ method: 'GET', origin: null, authorization: null, ip: '2.2.2.2', query: { chain, address }, body: undefined, env, fetchImpl: w.fetchImpl, now: NOW }).then((r) => (JSON.parse(r.body) as { items: Record<string, { image: string | null }> }).items);
  const account = (uri: string) => ({ data: { parsed: { info: { extensions: [{ extension: 'tokenMetadata', state: { uri } }] } } } });
  const mint = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

  it('reads a token made after the move', async () => {
    const w = world({ files: { [`meta/${SHA}.json`]: newFile }, accounts: [account(`${R2}/meta/${SHA}.json`)] });
    expect((await get(w, 'solana', mint))[mint]?.image).toBe(`${R2}/img/${SHA}.png`);
  });
  it('shows a token made before the move from the copy on R2, picture included, without touching Supabase', async () => {
    const w = world({ files: { [`meta/${SHA}.json`]: oldFile }, accounts: [account(publicUrl(OLD, 'launch-assets', `meta/${SHA}.json`))] });
    expect((await get(w, 'solana', mint))[mint]?.image).toBe(`${R2}/img/${SHA}.png`);
    expect(hostsOf(w.calls).some((h) => h.endsWith('supabase.co'))).toBe(false);
  });
  it('never follows a uri outside the bucket', async () => {
    const w = world({ accounts: [account('https://tracker.example/x.json')] });
    expect(await get(w, 'solana', mint)).toEqual({});
    expect(hostsOf(w.calls)).not.toContain('tracker.example');
  });
  it('reads an Ethereum-style file by address', async () => {
    const w = world({ files: { [`evm/polygon/${TOKEN}.json`]: oldFile } });
    expect((await get(w, 'polygon', TOKEN))[TOKEN]?.image).toBe(`${R2}/img/${SHA}.png`);
  });
});

describe('fallback to Supabase Storage', () => {
  it('uses Supabase when no R2 value is set', async () => {
    const w = world();
    const calls: string[] = [];
    const fetchImpl = (async (u: string | URL, i?: RequestInit) => {
      calls.push(String(u));
      if (String(u) === `${OLD}/storage/v1/bucket/launch-assets`) return new Response(JSON.stringify({ public: true, file_size_limit: 15 * 1024 * 1024, allowed_mime_types: ['image/png', 'image/jpeg', 'image/gif', 'application/json'] }));
      return w.fetchImpl(u, i);
    }) as typeof fetch;
    const r = await call(w, { op: 'status' }, { authorization: null, fetchImpl, env: { SUPABASE_URL: OLD, SUPABASE_SERVICE_ROLE_KEY: 'old-key', R2_ACCOUNT_ID: '  ' } });
    expect(r.data).toEqual({ enabled: true });
    expect(calls).toContain(`${OLD}/storage/v1/bucket/launch-assets`);
  });
});
