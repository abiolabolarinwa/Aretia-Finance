/**
 * AWS Signature Version 4 presigned URLs, just enough for Cloudflare R2's S3 endpoint (no AWS SDK). Pure apart from `crypto.subtle`
 * (Node 18+ and browsers). The browser is handed one URL for ONE object path that expires in minutes; the secret never leaves the server.
 */

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function hmac(key: Uint8Array | string, msg: string): Promise<Uint8Array> {
  const raw = typeof key === 'string' ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

/** RFC 3986 encoding as SigV4 wants it: everything but A-Z a-z 0-9 - _ . ~ is percent-encoded. */
export const uriEncode = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export interface PresignArgs {
  method: 'GET' | 'PUT' | 'HEAD';
  /** e.g. "<account>.r2.cloudflarestorage.com" */
  host: string;
  /** The object path, not yet encoded, starting with "/" (e.g. "/launch-assets/img/ab.png"). */
  path: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Seconds the link stays valid (1 to 604800). */
  expires: number;
  now: Date;
  /** Headers the caller must send exactly as given; they are signed. `host` is always signed and need not be listed. */
  signedHeaders?: Record<string, string>;
}

/** Returns the presigned URL (query-string form of SigV4, payload UNSIGNED-PAYLOAD). */
export async function presignUrl(a: PresignArgs): Promise<string> {
  const amzDate = a.now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20130524T000000Z
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${a.region}/${a.service}/aws4_request`;
  const headers: Record<string, string> = { host: a.host };
  for (const [k, v] of Object.entries(a.signedHeaders ?? {})) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  const names = Object.keys(headers).sort();
  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${a.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(a.expires)],
    ['X-Amz-SignedHeaders', names.join(';')],
  ];
  const canonicalQuery = query
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalPath = a.path.split('/').map(uriEncode).join('/');
  const canonicalRequest = [a.method, canonicalPath, canonicalQuery, names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(await crypto.subtle.digest('SHA-256', enc.encode(canonicalRequest)))].join('\n');
  let key = await hmac(`AWS4${a.secretAccessKey}`, day);
  for (const part of [a.region, a.service, 'aws4_request']) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  return `https://${a.host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
