import { beforeEach, describe, expect, it } from 'vitest';
import { EVM_FACTORIES, TOKEN_CREATED_TOPIC } from '../src/swings/launchbox/core.js';
import { buildMetadataJson, publicUrl } from '../src/swings/launchmeta/core.js';
import { resetBudgets } from './_limits.js';
import { resetRateLimit } from './_rpcProxy.js';
import { issueSession } from './_swingsAuth.js';
import { handleMeta, handleUpload, resetUploadState, type UploadInput } from './_swingsUpload.js';

const NOW = 1_800_000_000_000;
const KEY = 'service-key-for-tests';
const BASE = 'https://abcd.supabase.co';
const BUCKET = 'launch-assets';
const ORIGIN = 'https://aretiafinance.org';
const SHA = 'ab'.repeat(32);
const SOL_OWNER = 'solana:3Bq9yNGK5WbGpkT1DnBL8nPSCsEdXPC9aVzYcMGzTvEeU';
const CREATOR = '0x' + '1'.repeat(40);
const TOKEN = '0x' + '2'.repeat(40);
const TX = '0x' + 'cd'.repeat(32);
const pad = (a: string) => '0x' + a.replace('0x', '').padStart(64, '0');
const session = (owner: string) => `Bearer ${issueSession(KEY, owner, NOW).token}`;

const GOOD_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'application/json'];
/** The bucket record the storage API returns: public, capped at 15 MB, only the allowed types (what the upload check requires). */
function bucketRecord(kind: string | undefined): Record<string, unknown> {
  const good = { id: BUCKET, public: true, file_size_limit: 15 * 1024 * 1024, allowed_mime_types: GOOD_TYPES };
  if (kind === 'private') return { ...good, public: false };
  if (kind === 'unrestricted') return { id: BUCKET, public: true, file_size_limit: null, allowed_mime_types: null };
  if (kind === 'wide-types') return { ...good, allowed_mime_types: [...GOOD_TYPES, 'text/html'] };
  if (kind === 'huge-limit') return { ...good, file_size_limit: 5 * 1024 * 1024 * 1024 };
  return good;
}

interface World {
  fetchImpl: typeof fetch;
  calls: string[];
}

function world(opts: { bucket?: 'public' | 'private' | 'missing' | 'unrestricted' | 'wide-types' | 'huge-limit'; existing?: Set<string>; receipt?: unknown; files?: Record<string, string>; accounts?: unknown[] } = {}): World {
  const calls: string[] = [];
  const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.includes('/rest/v1/account_sessions')) return ok([]);
    if (url === `${BASE}/storage/v1/bucket/${BUCKET}`) return opts.bucket === 'missing' ? ok({ error: 'nope' }, 404) : ok(bucketRecord(opts.bucket));
    if (url.startsWith(`${BASE}/storage/v1/object/upload/sign/`)) return ok({ url: `/object/upload/sign/${BUCKET}/x?token=T` });
    if (url.startsWith(`${BASE}/storage/v1/object/public/`)) {
      const path = url.slice(`${BASE}/storage/v1/object/public/${BUCKET}/`.length);
      if (init?.method === 'HEAD') return new Response(null, { status: opts.existing?.has(path) ? 200 : 404 });
      const file = opts.files?.[path];
      return file ? new Response(file, { status: 200 }) : new Response('', { status: 404 });
    }
    if (url.includes('publicnode')) {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === 'eth_getTransactionReceipt') return ok({ result: opts.receipt ?? null });
      if (body.method === 'getMultipleAccounts') return ok({ result: { value: opts.accounts ?? [] } });
    }
    return new Response('', { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const env = { SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE_KEY: KEY };
const call = (w: World, body: unknown, over: Partial<UploadInput> = {}) =>
  handleUpload({ method: 'POST', origin: ORIGIN, authorization: session(SOL_OWNER), ip: '1.1.1.1', query: {}, body, env, fetchImpl: w.fetchImpl, now: NOW, ...over }).then((r) => ({ status: r.status, data: JSON.parse(r.body || '{}') as Record<string, unknown> }));
const image = { op: 'sign', kind: 'image', contentType: 'image/png', size: 5000, sha256: SHA };

beforeEach(() => {
  resetUploadState();
  resetBudgets();
  resetRateLimit();
});

describe('status', () => {
  it('is enabled when the bucket exists and is public', async () => {
    expect((await call(world(), { op: 'status' }, { authorization: null })).data).toEqual({ enabled: true });
  });
  it('is not enabled for a public bucket with no size limit, no type list, a type list that allows other files, or a limit above 15 MB', async () => {
    for (const bucket of ['unrestricted', 'wide-types', 'huge-limit'] as const) {
      resetUploadState();
      const status = await call(world({ bucket }), { op: 'status' }, { authorization: null });
      expect(status.data).toEqual({ enabled: false, message: 'Image upload is not set up yet' });
      const sign = await call(world({ bucket }), image);
      expect(sign.status).toBe(503);
    }
  });
  it('says image upload is not set up when the keys, the bucket or its public setting are missing', async () => {
    for (const w of [world({ bucket: 'missing' }), world({ bucket: 'private' })]) {
      const r = await call(w, { op: 'status' }, { authorization: null });
      expect(r.data).toEqual({ enabled: false, message: 'Image upload is not set up yet' });
    }
    const none = await call(world(), { op: 'status' }, { authorization: null, env: {} });
    expect(none.data.enabled).toBe(false);
    const sign = await call(world(), image, { env: {} });
    expect(sign.status).toBe(503);
    expect(sign.data.message).toBe('Image upload is not set up yet');
  });
});

describe('sign', () => {
  it('needs a wallet sign-in', async () => {
    expect((await call(world(), image, { authorization: null })).status).toBe(401);
    expect((await call(world(), image, { authorization: 'Bearer v1.abc.def' })).status).toBe(401);
  });
  it('refuses a foreign origin', async () => {
    expect((await call(world(), image, { origin: 'https://evil.example' })).status).toBe(403);
  });
  it('hands out one link for a hash-named path, and never the service key', async () => {
    const w = world();
    const r = await call(w, image);
    expect(r.status).toBe(200);
    expect(r.data.uploadUrl).toBe(`${BASE}/storage/v1/object/upload/sign/${BUCKET}/x?token=T`);
    expect(r.data.url).toBe(publicUrl(BASE, BUCKET, `img/${SHA}.png`));
    expect(JSON.stringify(r.data)).not.toContain(KEY);
    expect(w.calls.some((c) => c.startsWith(`POST ${BASE}/storage/v1/object/upload/sign/${BUCKET}/img/${SHA}.png`))).toBe(true);
  });
  it('does not ask for a second upload of a file that is already there', async () => {
    const w = world({ existing: new Set([`img/${SHA}.png`]) });
    const r = await call(w, image);
    expect(r.data).toEqual({ exists: true, url: publicUrl(BASE, BUCKET, `img/${SHA}.png`) });
    expect(w.calls.some((c) => c.includes('/upload/sign/'))).toBe(false);
  });
  it('refuses by type, size and hash before asking storage', async () => {
    const w = world();
    expect((await call(w, { ...image, contentType: 'image/svg+xml' })).status).toBe(400);
    expect((await call(w, { ...image, size: 15 * 1024 * 1024 + 1 })).status).toBe(400);
    expect((await call(w, { ...image, sha256: '../x' })).status).toBe(400);
    expect((await call(w, { op: 'sign', kind: 'json', size: 9000, sha256: SHA })).status).toBe(400);
    expect(w.calls.some((c) => c.includes('/upload/sign/'))).toBe(false);
  });
  it('limits one wallet to a dozen uploads an hour', async () => {
    const w = world();
    for (let i = 0; i < 12; i++) expect((await call(w, { ...image, sha256: i.toString(16).padStart(64, '0') })).status).toBe(200);
    const r = await call(w, { ...image, sha256: 'f'.repeat(64) });
    expect(r.status).toBe(429);
  });
  it('wraps a storage failure in a plain message', async () => {
    const w = world();
    const failing = (async (u: string | URL, i?: RequestInit) => (String(u).includes('/upload/sign/') ? new Response('{}', { status: 500 }) : w.fetchImpl(u, i))) as typeof fetch;
    const r = await call(w, image, { fetchImpl: failing });
    expect(r.status).toBe(502);
  });
});

describe('an Ethereum-style token’s details', () => {
  const body = { op: 'sign', kind: 'evm-meta', chain: 'bnb', address: TOKEN, size: 300, txHash: TX };
  const created = { status: '0x1', logs: [{ address: EVM_FACTORIES.bnb, topics: [TOKEN_CREATED_TOPIC, pad(TOKEN), pad(CREATOR)], data: '0x' }] };
  const as = `evm:${CREATOR}`;
  it('is accepted from the wallet whose creation of that token is on the chain', async () => {
    const r = await call(world({ receipt: created }), body, { authorization: session(as) });
    expect(r.status).toBe(200);
    expect(r.data.url).toBe(publicUrl(BASE, BUCKET, `evm/bnb/${TOKEN}.json`));
    expect(r.data.upsert).toBe(true);
  });
  it('is refused for another wallet, another token, a failed or foreign transaction', async () => {
    expect((await call(world({ receipt: created }), body, { authorization: session('evm:0x' + '9'.repeat(40)) })).status).toBe(403);
    expect((await call(world({ receipt: created }), { ...body, address: '0x' + '3'.repeat(40) }, { authorization: session(as) })).status).toBe(403);
    expect((await call(world({ receipt: { ...created, status: '0x0' } }), body, { authorization: session(as) })).status).toBe(403);
    expect((await call(world({ receipt: { status: '0x1', logs: [{ ...created.logs[0], address: '0x' + '4'.repeat(40) }] } }), body, { authorization: session(as) })).status).toBe(403);
    expect((await call(world({ receipt: null }), body, { authorization: session(as) })).status).toBe(403);
  });
  it('is refused for a Solana sign-in and when the creation transaction is missing', async () => {
    expect((await call(world({ receipt: created }), body)).status).toBe(400);
    expect((await call(world({ receipt: created }), { ...body, txHash: undefined }, { authorization: session(as) })).status).toBe(400);
  });
});

describe('meta', () => {
  const details = { description: 'A token.', website: 'https://example.org/', x: '', telegram: '' };
  const imageUrl = publicUrl(BASE, BUCKET, `img/${SHA}.png`);
  const file = buildMetadataJson({ name: 'Example', symbol: 'EXMP', details, image: imageUrl, imageType: 'image/png' });
  const get = (w: World, chain: string, address: string, over: Partial<UploadInput> = {}) =>
    handleMeta({ method: 'GET', origin: null, authorization: null, ip: '2.2.2.2', query: { chain, address }, body: undefined, env, fetchImpl: w.fetchImpl, now: NOW, ...over }).then((r) => ({ status: r.status, headers: r.headers, data: JSON.parse(r.body) as { items: Record<string, unknown> }, items: (JSON.parse(r.body) as { items: Record<string, unknown> }).items }));

  it('reads an Ethereum-style token’s file by its address, whatever the case', async () => {
    const w = world({ files: { [`evm/polygon/${TOKEN}.json`]: file } });
    const r = await get(w, 'polygon', TOKEN.toUpperCase().replace('0X', '0x'));
    expect(r.items[TOKEN]).toEqual({ description: 'A token.', image: imageUrl, website: 'https://example.org/', x: null, telegram: null });
    expect(r.headers['cache-control']).toContain('s-maxage');
  });
  it('reads a Solana token’s uri from the chain and follows it only inside the bucket', async () => {
    const mint = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const other = '4Nd1mBQtrMJVYVfKGkqmKMo8WhEKUuf3fEdSm7X1E6SG';
    const account = (uri: string) => ({ data: { parsed: { info: { extensions: [{ extension: 'tokenMetadata', state: { uri } }] } } } });
    const w = world({ files: { [`meta/${SHA}.json`]: file }, accounts: [account(publicUrl(BASE, BUCKET, `meta/${SHA}.json`)), account('https://tracker.example/x.json')] });
    const r = await get(w, 'solana', `${mint},${other}`);
    expect(Object.keys(r.items)).toEqual([mint]);
    expect(w.calls.some((c) => c.includes('tracker.example'))).toBe(false);
  });
  it('answers an empty list when uploads are not set up, and ignores bad input', async () => {
    expect((await get(world(), 'bnb', TOKEN, { env: {} })).items).toEqual({});
    expect((await get(world(), 'bnb', 'junk')).items).toEqual({});
    expect((await get(world(), 'sepolia', TOKEN)).status).toBe(400);
  });
  it('shows nothing for a file that carries nothing safe to show', async () => {
    const w = world({ files: { [`evm/bnb/${TOKEN}.json`]: JSON.stringify({ image: 'https://tracker.example/p.png' }) } });
    expect((await get(w, 'bnb', TOKEN)).items).toEqual({});
  });
});
