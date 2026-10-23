import { describe, expect, it } from 'vitest';
import { parseMetadataJson, publicUrl } from '../swings/launchmeta/core.js';
import { LaunchUploader, fetchTokenMetas, sha256Hex, type ChosenImage, type UploaderDeps } from './walletLaunchMeta';

const BASE = 'https://abcd.supabase.co';
const SESSION = { owner: 'solana:X', address: 'X', token: 't', expiresAt: 9e15 };
const image = (): ChosenImage => ({ type: 'image/png', size: 4, bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), previewUrl: 'blob:x' });
const details = { description: 'A token.', website: 'https://example.org/', x: '', telegram: '' };

function setup(over: { exists?: Set<string>; putStatus?: number } = {}) {
  const puts: { url: string; headers: Record<string, string>; body: FormData }[] = [];
  const signs: Record<string, unknown>[] = [];
  const deps: UploaderDeps = {
    fetchImpl: (async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        puts.push({ url, headers: (init.headers ?? {}) as Record<string, string>, body: init.body as FormData });
        return new Response('{}', { status: over.putStatus ?? 200 });
      }
      return new Response(JSON.stringify({ enabled: true }), { status: 200 });
    }) as typeof fetch,
    session: async () => SESSION,
    call: async (_s, payload) => {
      signs.push(payload);
      const path = payload.kind === 'image' ? `img/${payload.sha256}.png` : payload.kind === 'json' ? `meta/${payload.sha256}.json` : `evm/${payload.chain}/${payload.address}.json`;
      const url = publicUrl(BASE, 'launch-assets', path);
      return over.exists?.has(payload.kind as string) ? ({ exists: true, url } as never) : ({ uploadUrl: `${BASE}/storage/v1/object/upload/sign/launch-assets/${path}?token=T`, url, upsert: payload.kind === 'evm-meta' } as never);
    },
  };
  return { up: new LaunchUploader(deps), puts, signs };
}

describe('sha256Hex', () => {
  it('is the hash the server expects in a path', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('publishSolana', () => {
  it('uploads the picture, then a details file that points at it, and answers the file’s address', async () => {
    const { up, puts, signs } = setup();
    const uri = await up.publishSolana({ name: 'Example', symbol: 'EXMP', details, image: image() });
    expect(signs.map((s) => s.kind)).toEqual(['image', 'json']);
    expect(signs[0]).toMatchObject({ contentType: 'image/png', size: 4 });
    expect(puts).toHaveLength(2);
    const file = puts[1]!;
    expect(uri).toMatch(/^https:\/\/abcd\.supabase\.co\/storage\/v1\/object\/public\/launch-assets\/meta\/[0-9a-f]{64}\.json$/);
    // The details file names the picture by its public address, and its hash is in its own path.
    const sent = (file.body.get('') as Blob).size;
    expect(sent).toBeGreaterThan(50);
    expect(signs[1]!.size).toBe(sent);
    expect(uri).toContain(signs[1]!.sha256 as string);
    expect(uri.length).toBeLessThanOrEqual(200);
    expect(file.headers).toEqual({});
  });
  it('sends no picture when there is none, and skips a file that is already stored', async () => {
    const a = setup();
    await a.up.publishSolana({ name: 'Example', symbol: 'EXMP', details, image: null });
    expect(a.signs.map((s) => s.kind)).toEqual(['json']);
    const b = setup({ exists: new Set(['image']) });
    await b.up.publishSolana({ name: 'Example', symbol: 'EXMP', details, image: image() });
    expect(b.puts).toHaveLength(1);
  });
  it('turns a refused upload into a plain error', async () => {
    const { up } = setup({ putStatus: 413 });
    await expect(up.publishSolana({ name: 'E', symbol: 'E', details, image: image() })).rejects.toThrow(/too large/);
    await expect(setup({ putStatus: 500 }).up.publishSolana({ name: 'E', symbol: 'E', details, image: null })).rejects.toThrow(/did not go through/);
  });
});

describe('publishEvm', () => {
  it('keys the details file by the token address and allows replacing it', async () => {
    const { up, puts, signs } = setup();
    const token = '0x' + 'ab'.repeat(20);
    const url = await up.publishEvm({ chain: 'bnb', token, txHash: '0x' + 'cd'.repeat(32), name: 'E', symbol: 'E', details, image: image() });
    expect(signs.map((s) => s.kind)).toEqual(['image', 'evm-meta']);
    expect(signs[1]).toMatchObject({ chain: 'bnb', address: token, txHash: '0x' + 'cd'.repeat(32) });
    expect(url).toContain(`evm/bnb/${token}.json`);
    expect(puts[1]!.headers).toEqual({ 'x-upsert': 'true' });
  });
});

describe('status', () => {
  it('asks once and treats any failure as not set up', async () => {
    let asked = 0;
    const mk = (r: () => Response | Promise<Response>) => new LaunchUploader({ fetchImpl: (async () => (asked++, r())) as unknown as typeof fetch, session: async () => SESSION, call: async () => ({}) as never });
    const ok = mk(() => new Response('{"enabled":true}'));
    expect(await ok.status()).toBe(true);
    expect(await ok.status()).toBe(true);
    expect(asked).toBe(1);
    expect(await mk(() => new Response('{"enabled":false}')).status()).toBe(false);
    expect(await mk(() => new Response('{}', { status: 503 })).status()).toBe(false);
    expect(await mk(() => Promise.reject(new Error('offline'))).status()).toBe(false);
  });
});

describe('fetchTokenMetas', () => {
  const IMG = publicUrl(BASE, 'launch-assets', `img/${'ab'.repeat(32)}.png`);
  it('keeps only what passes the strict reader again, even if the server sent more', async () => {
    const a = '0x' + '1'.repeat(40);
    const b = '0x' + '2'.repeat(40);
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ items: { [a]: { description: 'Hi', image: IMG, website: 'https://example.org/', x: null, telegram: null }, [b]: { description: '', image: 'https://tracker.example/p.png', website: 'javascript:alert(1)', x: null, telegram: null } } }))) as unknown as typeof fetch;
    const got = await fetchTokenMetas('bnb', [a, b], fetchImpl);
    expect(got.get(a)).toEqual({ description: 'Hi', image: IMG, website: 'https://example.org/', x: null, telegram: null });
    expect(got.get(b)).toEqual({ description: '', image: null, website: null, x: null, telegram: null });
    expect(parseMetadataJson(null)).toBeNull();
  });
  it('answers nothing when the request fails', async () => {
    expect((await fetchTokenMetas('bnb', ['0x' + '1'.repeat(40)], (async () => new Response('', { status: 500 })) as unknown as typeof fetch)).size).toBe(0);
    expect((await fetchTokenMetas('bnb', ['0x' + '1'.repeat(40)], (async () => Promise.reject(new Error('x'))) as unknown as typeof fetch)).size).toBe(0);
  });
});
