/**
 * Web push without a library. A browser push needs the sender to prove who it is (VAPID: a short signed token) and then a
 * POST to the browser's push address. The messages sent here carry no text: the browser wakes our service worker, which
 * collects the waiting message from the site itself. So only the signed token is needed, no payload encryption.
 */

const enc = new TextEncoder();

export function b64uEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(text: string): Uint8Array<ArrayBuffer> {
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4));
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface VapidKeys {
  /** The public key as the browser wants it: the 65-byte uncompressed point, base64url. */
  publicKey: string;
  /** The private key: the 32-byte scalar, base64url. */
  privateKey: string;
  /** Who is sending: "mailto:you@example.com" or the site's address. */
  subject: string;
}

/** A new key pair, for the person setting this up to put in the server's settings. */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const point = new Uint8Array(65);
  point[0] = 4;
  point.set(b64uDecode(jwk.x!), 1);
  point.set(b64uDecode(jwk.y!), 33);
  return { publicKey: b64uEncode(point), privateKey: jwk.d! };
}

/** The `Authorization` header value for a push to `endpoint`. The signed token lasts twelve hours. */
export async function vapidAuthorization(keys: VapidKeys, endpoint: string, nowMs: number): Promise<string> {
  const point = b64uDecode(keys.publicKey);
  if (point.length !== 65 || point[0] !== 4) throw new Error('The push public key is not valid.');
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: b64uEncode(point.slice(1, 33)), y: b64uEncode(point.slice(33)), d: keys.privateKey, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64uEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64uEncode(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: keys.subject })));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64uEncode(signature)}, k=${keys.publicKey}`;
}

/** Wakes a browser. Returns the push service's status: 201 queued, 404 or 410 the browser is gone for good. */
export async function sendPush(fetchImpl: typeof fetch, keys: VapidKeys, endpoint: string, nowMs: number): Promise<number> {
  // Only a known push service is ever asked (validPushEndpoint), and a redirect is never followed to somewhere else.
  if (!validPushEndpoint(endpoint)) return 400;
  const res = await fetchImpl(endpoint, { method: 'POST', redirect: 'manual', headers: { authorization: await vapidAuthorization(keys, endpoint, nowMs), ttl: '3600', urgency: 'high', 'content-length': '0' } });
  return res.status;
}

/** The browsers' push services: Chrome / Edge-on-Chromium (FCM), Firefox (Mozilla autopush), Windows (WNS) and Safari (Apple). */
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
const PUSH_HOST_SUFFIXES = ['.push.services.mozilla.com', '.notify.windows.com'];

/** A push address is only ever an https address on one of the browsers' push services; anything else is refused. */
export function validPushEndpoint(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 600) return false;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
    const host = u.hostname.toLowerCase();
    return PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s) && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host.slice(0, -s.length)));
  } catch {
    return false;
  }
}
