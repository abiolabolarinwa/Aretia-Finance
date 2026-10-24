import { describe, expect, it } from 'vitest';
import {
  EMPTY_DETAILS,
  IMAGE_RULES,
  bucketProblem,
  buildMetadataJson,
  checkImage,
  cleanHttpsUrl,
  hasAnyDetails,
  isTrustedAssetUrl,
  parseMetadataJson,
  planUpload,
  publicUrl,
  sniffImageType,
  validateDetails,
} from './core.js';

const SHA = 'ab'.repeat(32);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const BASE = 'https://abcd.supabase.co';
const IMG = publicUrl(BASE, 'launch-assets', `img/${SHA}.png`);

describe('links', () => {
  it('accepts a plain https link and refuses everything else', () => {
    expect(cleanHttpsUrl('https://example.org/about')).toBe('https://example.org/about');
    for (const bad of ['http://example.org', 'ipfs://x', 'javascript:alert(1)', 'https://user:pw@example.org', 'https://localhost/x', 'https://127.0.0.1/', 'https://example.org:8443/', 'https://exa mple.org', '', 'example.org', 'https://example.org/' + 'a'.repeat(120)]) {
      expect(cleanHttpsUrl(bad), bad).toBeNull();
    }
  });
  it('limits X and Telegram links to their own sites', () => {
    expect(cleanHttpsUrl('https://x.com/aretia', ['x.com', 'twitter.com'])).toBe('https://x.com/aretia');
    expect(cleanHttpsUrl('https://www.twitter.com/aretia', ['x.com', 'twitter.com'])).not.toBeNull();
    expect(cleanHttpsUrl('https://evil.example/aretia', ['x.com', 'twitter.com'])).toBeNull();
    expect(cleanHttpsUrl('https://t.me/aretia', ['t.me', 'telegram.me'])).toBe('https://t.me/aretia');
    expect(cleanHttpsUrl('https://x.com.evil.example/a', ['x.com'])).toBeNull();
  });
});

describe('validateDetails', () => {
  it('lets every field stay empty', () => {
    expect(validateDetails(EMPTY_DETAILS)).toEqual({ ok: true, value: EMPTY_DETAILS });
  });
  it('trims and keeps good values', () => {
    const v = validateDetails({ description: '  A token.\r\nTwo lines.  ', website: ' https://example.org/ ', x: 'https://x.com/a', telegram: 'https://t.me/a' });
    expect(v).toEqual({ ok: true, value: { description: 'A token.\nTwo lines.', website: 'https://example.org/', x: 'https://x.com/a', telegram: 'https://t.me/a' } });
  });
  it('names each bad field', () => {
    const v = validateDetails({ description: 'x'.repeat(501), website: 'http://example.org', x: 'https://t.me/a', telegram: 'https://x.com/a' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues.map((i) => i.field).sort()).toEqual(['description', 'telegram', 'website', 'x']);
  });
  it('refuses control characters in the description but allows line breaks', () => {
    expect(validateDetails({ ...EMPTY_DETAILS, description: 'a\u0007b' }).ok).toBe(false);
    expect(validateDetails({ ...EMPTY_DETAILS, description: 'a\nb' }).ok).toBe(true);
  });
  it('knows whether anything was given', () => {
    expect(hasAnyDetails(EMPTY_DETAILS, false)).toBe(false);
    expect(hasAnyDetails(EMPTY_DETAILS, true)).toBe(true);
    expect(hasAnyDetails({ ...EMPTY_DETAILS, x: 'https://x.com/a' }, false)).toBe(true);
  });
});

describe('pictures', () => {
  it('is read from the first bytes, not the name', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(new TextEncoder().encode('GIF89a....'))).toBe('image/gif');
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns='))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode('RIFFxxxxWEBP'))).toBeNull();
  });
  it('is limited to 15 MB', () => {
    expect(checkImage({ size: IMAGE_RULES.maxBytes }, PNG)).toEqual({ ok: true, type: 'image/png' });
    expect(checkImage({ size: IMAGE_RULES.maxBytes + 1 }, PNG).ok).toBe(false);
    expect(checkImage({ size: 0 }, PNG).ok).toBe(false);
    expect(checkImage({ size: 10 }, new TextEncoder().encode('<svg>')).ok).toBe(false);
  });
});

describe('the metadata file', () => {
  const details = { description: 'A token.', website: 'https://example.org/', x: 'https://x.com/a', telegram: 'https://t.me/a' };
  it('carries name, symbol, description, picture and links, and nothing that was left empty', () => {
    const json = JSON.parse(buildMetadataJson({ name: 'Example', symbol: 'EXMP', details, image: IMG, imageType: 'image/png' }));
    expect(json).toEqual({
      name: 'Example',
      symbol: 'EXMP',
      description: 'A token.',
      image: IMG,
      properties: { category: 'image', files: [{ uri: IMG, type: 'image/png' }] },
      external_url: 'https://example.org/',
      extensions: { website: 'https://example.org/', twitter: 'https://x.com/a', telegram: 'https://t.me/a' },
    });
    expect(JSON.parse(buildMetadataJson({ name: 'E', symbol: 'E', details: { description: '', website: '', x: '', telegram: '' }, image: null, imageType: null }))).toEqual({ name: 'E', symbol: 'E' });
  });
  it('is the same bytes for the same input', () => {
    const a = buildMetadataJson({ name: 'Example', symbol: 'EXMP', details, image: IMG, imageType: 'image/png' });
    expect(buildMetadataJson({ name: 'Example', symbol: 'EXMP', details, image: IMG, imageType: 'image/png' })).toBe(a);
  });
  it('fits the upload limit and a Solana uri even with every field full', () => {
    const full = { description: 'd'.repeat(500), website: 'https://example.org/' + 'a'.repeat(90), x: 'https://x.com/' + 'a'.repeat(90), telegram: 'https://t.me/' + 'a'.repeat(90) };
    expect(new TextEncoder().encode(buildMetadataJson({ name: 'N'.repeat(32), symbol: 'S'.repeat(10), details: full, image: IMG, imageType: 'image/png' })).length).toBeLessThanOrEqual(4096);
    expect(publicUrl(BASE, 'launch-assets', `meta/${SHA}.json`).length).toBeLessThanOrEqual(200);
  });
  it('reads back only what is safe to show', () => {
    const back = parseMetadataJson(buildMetadataJson({ name: 'Example', symbol: 'EXMP', details, image: IMG, imageType: 'image/png' }));
    expect(back).toEqual({ description: 'A token.', image: IMG, website: 'https://example.org/', x: 'https://x.com/a', telegram: 'https://t.me/a' });
    const hostile = parseMetadataJson({ description: 'ok', image: 'https://tracker.example/p.png', extensions: { website: 'javascript:alert(1)', twitter: 'https://evil.example/a', telegram: 'http://t.me/a' } });
    expect(hostile).toEqual({ description: 'ok', image: null, website: null, x: null, telegram: null });
    expect(parseMetadataJson('not json')).toBeNull();
    expect(parseMetadataJson([1])).toBeNull();
  });
  it('trusts pictures only from the public storage path', () => {
    expect(isTrustedAssetUrl(IMG)).toBe(true);
    for (const bad of ['http://abcd.supabase.co/storage/v1/object/public/a/b.png', 'https://abcd.supabase.co/storage/v1/object/sign/a/b.png', 'https://supabase.co.evil.example/storage/v1/object/public/a', 'https://abcd.supabase.co/storage/v1/object/public/a/b.png?x=1', 7, null]) expect(isTrustedAssetUrl(bad), String(bad)).toBe(false);
  });
});

describe('planUpload', () => {
  it('puts a picture under its hash, with an extension from the declared type', () => {
    expect(planUpload({ kind: 'image', contentType: 'image/png', size: 1000, sha256: SHA })).toEqual({ ok: true, path: `img/${SHA}.png`, contentType: 'image/png', immutableName: true });
    expect(planUpload({ kind: 'image', contentType: 'image/jpeg', size: 1000, sha256: SHA })).toMatchObject({ path: `img/${SHA}.jpg` });
  });
  it('refuses the wrong type, size or hash', () => {
    expect(planUpload({ kind: 'image', contentType: 'image/svg+xml', size: 1000, sha256: SHA }).ok).toBe(false);
    expect(planUpload({ kind: 'image', contentType: 'image/png', size: IMAGE_RULES.maxBytes + 1, sha256: SHA }).ok).toBe(false);
    expect(planUpload({ kind: 'image', contentType: 'image/png', size: 0, sha256: SHA }).ok).toBe(false);
    expect(planUpload({ kind: 'image', contentType: 'image/png', size: 5, sha256: 'AB'.repeat(32) }).ok).toBe(false);
    expect(planUpload({ kind: 'image', contentType: 'image/png', size: 5, sha256: '../../x' }).ok).toBe(false);
    expect(planUpload({ kind: 'script', size: 5 }).ok).toBe(false);
    expect(planUpload(null).ok).toBe(false);
  });
  it('keeps the details file small and under its hash', () => {
    expect(planUpload({ kind: 'json', size: 300, sha256: SHA })).toMatchObject({ ok: true, path: `meta/${SHA}.json`, contentType: 'application/json' });
    expect(planUpload({ kind: 'json', size: 5000, sha256: SHA }).ok).toBe(false);
  });
  it('keys an Ethereum-style token’s file by its lower-case address, on the networks that have a factory', () => {
    const address = '0xAbCdEf0123456789abcdef0123456789ABCDEF01';
    expect(planUpload({ kind: 'evm-meta', chain: 'bnb', address, size: 300 })).toMatchObject({ ok: true, path: `evm/bnb/${address.toLowerCase()}.json`, immutableName: false });
    expect(planUpload({ kind: 'evm-meta', chain: 'sepolia', address, size: 300 }).ok).toBe(false);
    expect(planUpload({ kind: 'evm-meta', chain: 'bnb', address: '0x12', size: 300 }).ok).toBe(false);
    expect(planUpload({ kind: 'evm-meta', chain: 'bnb', address: '../../' + address, size: 300 }).ok).toBe(false);
  });
});

describe('bucketProblem', () => {
  const good = { public: true, file_size_limit: 15 * 1024 * 1024, allowed_mime_types: ['image/png', 'image/jpeg', 'image/gif', 'application/json'] };
  it('accepts a public, capped bucket that lists only the allowed types, or a subset of them', () => {
    expect(bucketProblem(good)).toBeNull();
    expect(bucketProblem({ ...good, allowed_mime_types: ['image/png'], file_size_limit: 1000 })).toBeNull();
  });
  it('refuses anything else', () => {
    expect(bucketProblem(null)).not.toBeNull();
    expect(bucketProblem({ ...good, public: false })).not.toBeNull();
    expect(bucketProblem({ ...good, file_size_limit: null })).not.toBeNull();
    expect(bucketProblem({ ...good, file_size_limit: 0 })).not.toBeNull();
    expect(bucketProblem({ ...good, file_size_limit: 15 * 1024 * 1024 + 1 })).not.toBeNull();
    expect(bucketProblem({ ...good, allowed_mime_types: null })).not.toBeNull();
    expect(bucketProblem({ ...good, allowed_mime_types: [] })).not.toBeNull();
    expect(bucketProblem({ ...good, allowed_mime_types: ['image/png', 'text/html'] })).not.toBeNull();
    expect(bucketProblem({ ...good, allowed_mime_types: ['image/svg+xml'] })).not.toBeNull();
  });
});
