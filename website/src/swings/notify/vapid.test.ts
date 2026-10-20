import { describe, expect, it } from 'vitest';
import { b64uDecode, b64uEncode, generateVapidKeys, sendPush, validPushEndpoint, vapidAuthorization } from './vapid.js';

const NOW = 1_800_000_000_000;

describe('VAPID', () => {
  it('signs a token the public key can verify, naming the push service and the sender', async () => {
    const keys = { ...(await generateVapidKeys()), subject: 'mailto:ops@example.org' };
    const auth = await vapidAuthorization(keys, 'https://fcm.googleapis.com/fcm/send/abc', NOW);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(auth);
    expect(m).not.toBeNull();
    const [, h, c, sig, k] = m!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(new TextDecoder().decode(b64uDecode(h!)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(new TextDecoder().decode(b64uDecode(c!)))).toEqual({ aud: 'https://fcm.googleapis.com', exp: NOW / 1000 + 43_200, sub: 'mailto:ops@example.org' });
    const point = b64uDecode(keys.publicKey);
    const pub = await crypto.subtle.importKey('raw', point, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64uDecode(sig!), new TextEncoder().encode(`${h}.${c}`))).toBe(true);
  });
  it('makes a 65-byte public key and a 32-byte private key', async () => {
    const k = await generateVapidKeys();
    expect(b64uDecode(k.publicKey)).toHaveLength(65);
    expect(b64uDecode(k.privateKey)).toHaveLength(32);
    expect(b64uDecode(b64uEncode(new Uint8Array([1, 2, 3, 250, 251])))).toEqual(new Uint8Array([1, 2, 3, 250, 251]));
  });
  it('refuses a key that is not a public point', async () => {
    await expect(vapidAuthorization({ publicKey: 'AAAA', privateKey: 'x', subject: 'mailto:a@b.c' }, 'https://a.example/x', NOW)).rejects.toThrow(/not valid/);
  });
  it('sends an empty POST with the signed header and reports the status', async () => {
    const keys = { ...(await generateVapidKeys()), subject: 'mailto:ops@example.org' };
    let seen: { url: string; init?: RequestInit } | null = null;
    const f = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    expect(await sendPush(f, keys, 'https://fcm.googleapis.com/fcm/send/send/1', NOW)).toBe(201);
    expect(seen!.url).toBe('https://fcm.googleapis.com/fcm/send/send/1');
    expect(seen!.init?.method).toBe('POST');
    expect((seen!.init?.headers as Record<string, string>).authorization.startsWith('vapid t=')).toBe(true);
    expect(seen!.init?.body).toBeUndefined();
    expect(seen!.init?.redirect).toBe('manual');
    // a stored address that is not a push service is never contacted
    seen = null;
    expect(await sendPush(f, keys, 'https://attacker.example/x', NOW)).toBe(400);
    expect(seen).toBeNull();
  });
  it('accepts only https push addresses', () => {
    expect(validPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    for (const good of ['https://updates.push.services.mozilla.com/wpush/v2/x', 'https://autopush.prod.push.services.mozilla.com/x', 'https://wns2-bl2p.notify.windows.com/w/?token=x', 'https://web.push.apple.com/QGx']) expect(validPushEndpoint(good), good).toBe(true);
    // M-11: any other https host is refused, so the alert job cannot be made to POST to arbitrary or internal addresses
    for (const bad of ['https://attacker.example/x', 'https://169.254.169.254.nip.io/latest', 'https://internal.corp.example/admin', 'https://fcm.googleapis.com.evil.example/x', 'https://evilnotify.windows.com/x', 'https://fcm.googleapis.com:8443/x', 'https://x.push.apple.com/a']) expect(validPushEndpoint(bad), bad).toBe(false);
    for (const bad of ['http://x.example/a', 'javascript:alert(1)', 'https://user:pw@x.example/a', 'https://localhost/a', '', 5, null, `https://x.example/${'a'.repeat(700)}`]) expect(validPushEndpoint(bad)).toBe(false);
  });
});
