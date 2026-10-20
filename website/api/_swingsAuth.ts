/**
 * Proof of wallet ownership and the short-lived sessions that follow from it.
 *
 *  - A person signs a Sign-In with Ethereum / Sign In With Solana message (see account/loginMessage.ts) with the wallet. Solana
 *    wallets sign it with ed25519 (strict RFC 8032 checks, small-order keys refused); Ethereum-style wallets with
 *    `personal_sign` (secp256k1). The server checks the signature really belongs to the address named in the message, that the
 *    message is exactly the one Aretia writes, that it names this site as configured on the server (never as the request
 *    claims), and that it was made in the last few minutes. The nonce in it is single-use and issued by the server
 *    (_swingsAccount.ts), so a signature works once.
 *  - It then issues a session token for that one address, valid for seven days, signed with a key derived from
 *    SWINGS_SESSION_SECRET. The token carries the owner's session version; raising the version (sign out everywhere, or the
 *    operator) ends every older token at once.
 *
 * No wallet key or recovery phrase is involved at any point: only a signature over a message.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak256 } from '../src/swings/core/keccak.js';
import { LOGIN_WINDOW_MS, parseLoginMessage, type WalletFamily } from '../src/swings/account/loginMessage.js';
import { allowedOrigins, type ProxyEnv } from './_rpcProxy.js';

export const SESSION_MS = 7 * 86_400_000;

let warnedFallback = false;
/**
 * The secret sessions (and other server-issued tokens) are signed with. SWINGS_SESSION_SECRET should be set to its own long random
 * value; until it is, the database service key is used, as before, and a warning is logged once per instance.
 */
export function sessionSecret(env: { SWINGS_SESSION_SECRET?: string; SUPABASE_SERVICE_ROLE_KEY?: string }): string | null {
  const own = env.SWINGS_SESSION_SECRET?.trim();
  if (own) return own;
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) return null;
  if (!warnedFallback) {
    warnedFallback = true;
    console.warn('SWINGS_SESSION_SECRET is not set: sessions are signed with a key derived from the database service key. Set SWINGS_SESSION_SECRET (see .env.example).');
  }
  return key;
}

/**
 * The hosts a sign-in message may name: SWINGS_LOGIN_DOMAINS (comma-separated hosts) when set, otherwise the hosts of the allowed
 * origins (aretiafinance.org, www.aretiafinance.org and RPC_ALLOWED_ORIGINS). Taken from configuration, never from the request.
 */
export function loginDomains(env: ProxyEnv & { SWINGS_LOGIN_DOMAINS?: string }): string[] {
  // Hosts only; a value written as an origin ("https://aretiafinance.org/") is reduced to its host rather than never matching.
  const own = (env.SWINGS_LOGIN_DOMAINS ?? '').split(',').map((s) => s.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
  if (own.length > 0) return own;
  const out: string[] = [];
  for (const o of allowedOrigins(env)) {
    try {
      out.push(new URL(o).host.toLowerCase());
    } catch {
      // not an origin: ignored
    }
  }
  return out;
}

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

/** True for an ed25519 public key that decodes to a point of small order (the identity and its relatives). Such a key can "sign" anything. */
function smallOrderKey(key: Uint8Array): boolean {
  try {
    return ed25519.Point.fromHex(key).isSmallOrder();
  } catch {
    return true;
  }
}

/** Checks a sign-in: the message, the site, the time, and the signature. `domain` is this site's host, or the list of hosts allowed. */
export function verifyLogin(input: { message: string; signature: string; domain: string | readonly string[]; now: number }): LoginCheck & { nonce?: string } {
  const f = parseLoginMessage(input.message);
  if (!f) return { ok: false, reason: 'The sign-in message was not recognised.' };
  const domains = typeof input.domain === 'string' ? [input.domain] : input.domain;
  if (!domains.includes(f.domain.toLowerCase())) return { ok: false, reason: 'The sign-in message names a different site.' };
  if (Math.abs(input.now - f.issuedAt) > LOGIN_WINDOW_MS) return { ok: false, reason: 'The sign-in message has expired. Try again.' };
  const message = new TextEncoder().encode(input.message);
  if (f.family === 'solana') {
    const key = fromBase58(f.address);
    if (!key || key.length !== 32) return { ok: false, reason: 'The address is not a Solana address.' };
    if (smallOrderKey(key)) return { ok: false, reason: 'The address is not a usable Solana address.' };
    const good = ((): boolean => {
      try {
        const sig = fromBase64(input.signature);
        return sig.length === 64 && ed25519.verify(sig, message, key, { zip215: false });
      } catch {
        return false;
      }
    })();
    return good ? { ok: true, owner: ownerOf('solana', f.address), address: f.address, family: 'solana', nonce: f.nonce } : { ok: false, reason: 'The signature does not match the address.' };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(f.address)) return { ok: false, reason: 'The address is not an Ethereum-style address.' };
  const recovered = evmAddressFromSignature(input.message, input.signature);
  return recovered && recovered.toLowerCase() === f.address.toLowerCase()
    ? { ok: true, owner: ownerOf('evm', f.address), address: f.address, family: 'evm', nonce: f.nonce }
    : { ok: false, reason: 'The signature does not match the address.' };
}

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

function mac(secret: string, body: string): string {
  // The signing key is derived, so the raw server secret is never used directly as a key for tokens.
  const key = createHmac('sha256', 'aretia-session-v1').update(secret).digest();
  return createHmac('sha256', key).update(body).digest('hex');
}

/** Signs a short server-issued token of some purpose (`kind`), so one kind of token can never be used as another. */
export function signToken(secret: string, kind: string, payload: Record<string, unknown>): string {
  const body = b64url(JSON.stringify(payload));
  return `${kind}.${body}.${mac(secret, `${kind}.${body}`)}`;
}

/** The payload of a token made by `signToken` with the same secret and kind, or null when it is forged or malformed. */
export function openToken(secret: string, kind: string, token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== kind) return null;
  const want = Buffer.from(mac(secret, `${kind}.${parts[1]}`), 'hex');
  const got = Buffer.from(parts[2]!, 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown;
    return typeof p === 'object' && p !== null && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function issueSession(secret: string, owner: string, now: number, version = 0): { token: string; expiresAt: number } {
  const expiresAt = now + SESSION_MS;
  return { token: signToken(secret, 'v1', { o: owner, e: expiresAt, v: version }), expiresAt };
}

/** The owner and session version a token was issued for, or null when it is forged, malformed or out of date. */
export function readSessionClaims(secret: string, token: string | null, now: number): { owner: string; version: number } | null {
  if (!token) return null;
  const p = openToken(secret, 'v1', token);
  if (!p || typeof p.o !== 'string' || typeof p.e !== 'number' || p.e <= now) return null;
  const version = p.v === undefined ? 0 : typeof p.v === 'number' && Number.isInteger(p.v) && p.v >= 0 ? p.v : -1;
  return version < 0 ? null : { owner: p.o, version };
}

/** The owner a session token was issued for, or null when it is forged, malformed or out of date. Does not check revocation: see `sessionOwner`. */
export function readSession(secret: string, token: string | null, now: number): string | null {
  return readSessionClaims(secret, token, now)?.owner ?? null;
}

export interface SessionDb {
  call(path: string, init?: RequestInit): Promise<unknown>;
}

/** The owner's current session version (0 when none was ever raised). Needs migration 0014. */
export async function sessionVersion(db: SessionDb, owner: string): Promise<number> {
  const rows = (await db.call(`account_sessions?owner=eq.${encodeURIComponent(owner)}&select=version&limit=1`)) as { version?: unknown }[] | null;
  const v = Number(Array.isArray(rows) ? rows[0]?.version : 0);
  return Number.isInteger(v) && v > 0 ? v : 0;
}

/**
 * The owner behind an `Authorization: Bearer` header, or null when there is none, it is forged or expired, or the owner has since
 * ended their sessions (the token's version is older than the stored one). Throws when the database cannot be read.
 */
export async function sessionOwner(secret: string, authorization: string | null, now: number, db: SessionDb): Promise<string | null> {
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
  const claims = readSessionClaims(secret, bearer, now);
  if (!claims) return null;
  return claims.version >= (await sessionVersion(db, claims.owner)) ? claims.owner : null;
}
