/**
 * Makes the key pair browser (web push) alerts need. Run it once:
 *
 *   node scripts/make-vapid-keys.ts
 *
 * Then set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in the site's server settings (Vercel), and VAPID_SUBJECT to
 * "mailto:" and a contact address. Keep the private key secret; the public key is shown to browsers.
 */
const b64u = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
const point = new Uint8Array(65);
point[0] = 4;
point.set(unb64u(jwk.x!), 1);
point.set(unb64u(jwk.y!), 33);
console.log(`VAPID_PUBLIC_KEY=${b64u(point)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
console.log('VAPID_SUBJECT=mailto:you@your-domain.example');

export {};
