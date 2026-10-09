/**
 * Proof of wallet ownership and the short-lived sessions that follow from it.
 *
 *  - A person signs a plain message (see account/loginMessage.ts) with the wallet. Solana wallets sign it with ed25519;
 *    Ethereum-style wallets with `personal_sign` (secp256k1). The server checks the signature really belongs to the
 *    address named in the message, that the message is exactly the one Aretia writes, that it names this site, and that
 *    it was made in the last few minutes.
 *  - It then issues a session token for that one address, valid for seven days, signed with a key derived from a server
 *    secret. The token proves nothing to anyone else and holds no secret of the person's.
 *
 * No wallet key or recovery phrase is involved at any point: only a signature over a message.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak256 } from '../src/swings/core/keccak.js';
import { LOGIN_WINDOW_MS, parseLoginMessage, type WalletFamily } from '../src/swings/account/loginMessage.js';

export const SESSION_MS = 7 * 86_400_000;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function fromBase58(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(Buffer.from(b64, 'base64'));
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** The owner key a verified address is stored under. */
export function ownerOf(family: WalletFamily, address: string): string {
  return family === 'evm' ? `evm:${address.toLowerCase()}` : `solana:${address}`;
}

function evmAddressFromSignature(message: string, sigHex: string): string | null {
  const sig = sigHex.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{130}$/.test(sig)) return null;
  const body = new TextEncoder().encode(message);
  const prefixed = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefixed.length + body.length);
  joined.set(prefixed);
  joined.set(body, prefixed.length);
  const digest = keccak256(joined);
  let v = Number.parseInt(sig.slice(128, 130), 16);
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return null;
  try {
    const point = secp256k1.Signature.fromCompact(sig.slice(0, 128)).addRecoveryBit(v).recoverPublicKey(digest);
    const raw = point.toRawBytes(false).slice(1);
    return '0x' + hex(keccak256(raw).slice(12));
  } catch {
    return null;
  }
}

export type LoginCheck = { ok: true; owner: string; address: string; family: WalletFamily } | { ok: false; reason: string };

/** Checks a sign-in: the message, the site, the time, and the signature. `domain` is this site's host. */
export function verifyLogin(input: { message: string; signature: string; domain: string; now: number }): LoginCheck {
  const f = parseLoginMessage(input.message);
  if (!f) return { ok: false, reason: 'The sign-in message was not recognised.' };
  if (f.domain !== input.domain) return { ok: false, reason: 'The sign-in message names a different site.' };
  if (Math.abs(input.now - f.issuedAt) > LOGIN_WINDOW_MS) return { ok: false, reason: 'The sign-in message has expired. Try again.' };
  const message = new TextEncoder().encode(input.message);
  if (f.family === 'solana') {
    const key = fromBase58(f.address);
    if (!key || key.length !== 32) return { ok: false, reason: 'The address is not a Solana address.' };
    const good = ((): boolean => {
      try {
        return ed25519.verify(fromBase64(input.signature), message, key);
      } catch {
        return false;
      }
    })();
    return good ? { ok: true, owner: ownerOf('solana', f.address), address: f.address, family: 'solana' } : { ok: false, reason: 'The signature does not match the address.' };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(f.address)) return { ok: false, reason: 'The address is not an Ethereum-style address.' };
  const recovered = evmAddressFromSignature(input.message, input.signature);
  return recovered && recovered.toLowerCase() === f.address.toLowerCase()
    ? { ok: true, owner: ownerOf('evm', f.address), address: f.address, family: 'evm' }
    : { ok: false, reason: 'The signature does not match the address.' };
}

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

function mac(secret: string, body: string): string {
  // The signing key is derived, so the raw server secret is never used directly as a key for tokens.
  const key = createHmac('sha256', 'aretia-session-v1').update(secret).digest();
  return createHmac('sha256', key).update(body).digest('hex');
}

export function issueSession(secret: string, owner: string, now: number): { token: string; expiresAt: number } {
  const expiresAt = now + SESSION_MS;
  const body = b64url(JSON.stringify({ o: owner, e: expiresAt }));
  return { token: `v1.${body}.${mac(secret, `v1.${body}`)}`, expiresAt };
}

/** The owner a session token was issued for, or null when it is forged, malformed or out of date. */
export function readSession(secret: string, token: string | null, now: number): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const want = Buffer.from(mac(secret, `v1.${parts[1]}`), 'hex');
  const got = Buffer.from(parts[2]!, 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { o?: unknown; e?: unknown };
    return typeof p.o === 'string' && typeof p.e === 'number' && p.e > now ? p.o : null;
  } catch {
    return null;
  }
}
