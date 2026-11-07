import { describe, expect, it } from 'vitest';
import { presignUrl, uriEncode } from './r2sign.js';

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'; // the published AWS documentation example, not a real key

describe('presignUrl', () => {
  it('matches the AWS documentation vector for a presigned GET (SigV4 query string)', async () => {
    const url = await presignUrl({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      region: 'us-east-1',
      service: 's3',
      accessKeyId: AWS_KEY,
      secretAccessKey: AWS_SECRET,
      expires: 86400,
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });
  it('signs extra headers, lists them in order, and changes the signature when one differs', async () => {
    const base = { method: 'PUT' as const, host: 'acct.r2.cloudflarestorage.com', path: '/bucket/img/ab.png', region: 'auto', service: 's3', accessKeyId: AWS_KEY, secretAccessKey: AWS_SECRET, expires: 300, now: new Date('2026-11-07T10:00:00Z') };
    const a = await presignUrl({ ...base, signedHeaders: { 'Content-Type': 'image/png', 'content-length': '5000' } });
    const b = await presignUrl({ ...base, signedHeaders: { 'content-type': 'image/png', 'content-length': '5001' } });
    expect(a).toContain('X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost');
    expect(a).toContain('/auto/s3/aws4_request'.replace(/\//g, '%2F'));
    expect(a.split('X-Amz-Signature=')[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(a.split('X-Amz-Signature=')[1]).not.toBe(b.split('X-Amz-Signature=')[1]);
  });
  it('encodes path segments but keeps the slashes', async () => {
    expect(uriEncode("a b/c'd")).toBe('a%20b%2Fc%27d');
    const url = await presignUrl({ method: 'PUT', host: 'h.example', path: '/b/a b.png', region: 'auto', service: 's3', accessKeyId: 'k', secretAccessKey: 's', expires: 60, now: new Date(0) });
    expect(url.startsWith('https://h.example/b/a%20b.png?')).toBe(true);
  });
});
