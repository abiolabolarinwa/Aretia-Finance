/**
 * An optional screen lock for the Aretia wallet page, set up per wallet, on desktop and laptop computers only.
 *
 * What it is: a gate in this page. With it on, Aretia asks for a password, a PIN or the computer's own unlock (Windows Hello,
 * Touch ID, a fingerprint reader or the screen-lock PIN) before it shows that wallet's balances and lets its screens be used,
 * on opening the page, after a set idle time, and whenever the person presses "Lock now".
 *
 * What it is not: encryption, and not a replacement for the wallet's own password. Keys never live here, so there is
 * nothing to encrypt. It keeps a passer-by or someone borrowing the computer out of the Aretia page. It cannot stop someone
 * who can clear this site's data or who can open the wallet extension itself. The screen says so.
 *
 * Nothing leaves the browser. A password or PIN is kept only as a salted PBKDF2 hash; device unlock keeps the public key of
 * a credential held by the computer's own authenticator, and each unlock is checked against it.
 */

/** The parts of browser storage this needs. */
export interface LockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export type LockMethod = 'password' | 'pin' | 'device';

/** Minutes of no activity before the lock comes back. 0 means never. */
export const AUTO_LOCK_CHOICES = [0, 5, 15, 30] as const;
export const DEFAULT_AUTO_LOCK_MIN = 15;

export const PBKDF2_ITERATIONS = 600_000;
export const FREE_TRIES = 5;
const MAX_DELAY_MS = 15 * 60_000;
const BASE_DELAY_MS = 30_000;

export interface LockRecord {
  v: 1;
  method: LockMethod;
  createdAt: number;
  autoLockMin: number;
  /** A password or PIN, as a salted hash. */
  secret?: { salt: string; hash: string; iterations: number };
  /** A credential kept by the computer's own authenticator. */
  device?: { id: string; publicKey: string; alg: number };
  /** Wrong tries in a row, and when trying is allowed again. */
  fails: number;
  lockedUntil: number;
}

// ------------------------------------------------------------------ bytes

const enc = new TextEncoder();

export function toB64Url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64Url(text: string): Uint8Array {
  const b = text.replace(/-/g, '+').replace(/_/g, '/');
  const s = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** A comparison that takes the same time wherever two values differ. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// ------------------------------------------------------------------ password and PIN

/** A PIN is 6 to 10 digits, and not an obvious one. Returns what is wrong, or null. */
export function pinProblem(pin: string): string | null {
  if (!/^\d{6,10}$/.test(pin)) return 'Use 6 to 10 digits.';
  if (/^(\d)\1+$/.test(pin)) return 'Not the same digit repeated.';
  const steps = [...pin].map((c, i, a) => (i === 0 ? 0 : Number(c) - Number(a[i - 1]))).slice(1);
  if (steps.every((d) => d === 1) || steps.every((d) => d === -1)) return 'Not a run of digits like 123456.';
  return null;
}

/** A password is at least 8 characters, and not just spaces. Returns what is wrong, or null. */
export function passwordProblem(password: string): string | null {
  if (password.trim().length === 0) return 'Use something other than spaces.';
  if (password.length < 8) return 'Use at least 8 characters.';
  return null;
}

async function pbkdf2(secret: string, salt: Uint8Array, iterations: number, subtle: SubtleCrypto): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashSecret(secret: string, iterations = PBKDF2_ITERATIONS, subtle: SubtleCrypto = crypto.subtle): Promise<NonNullable<LockRecord['secret']>> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: toB64Url(salt), hash: toB64Url(await pbkdf2(secret, salt, iterations, subtle)), iterations };
}

export async function secretMatches(secret: string, saved: NonNullable<LockRecord['secret']>, subtle: SubtleCrypto = crypto.subtle): Promise<boolean> {
  if (!Number.isInteger(saved.iterations) || saved.iterations < 1) return false;
  return sameBytes(await pbkdf2(secret, fromB64Url(saved.salt), saved.iterations, subtle), fromB64Url(saved.hash));
}

// ------------------------------------------------------------------ wrong tries

/** How long until trying is allowed again, in milliseconds. 0 when it is allowed now. */
export const waitMs = (rec: Pick<LockRecord, 'lockedUntil'>, now: number): number => Math.max(0, rec.lockedUntil - now);

/** The record after one try. Right resets the count; the sixth wrong try in a row, and every one after, waits longer. */
export function afterTry(rec: LockRecord, ok: boolean, now: number): LockRecord {
  if (ok) return { ...rec, fails: 0, lockedUntil: 0 };
  const fails = rec.fails + 1;
  const over = fails - FREE_TRIES;
  const delay = over <= 0 ? 0 : Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (over - 1));
  return { ...rec, fails, lockedUntil: delay === 0 ? 0 : now + delay };
}

// ------------------------------------------------------------------ the saved lock, one per wallet

const KEY = 'aretia-lock-v1:';

/** One key per wallet. Ethereum-style addresses ignore letter case; Solana ones do not. */
export const lockKey = (address: string): string => KEY + (/^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : address);

function validRecord(v: unknown): v is LockRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<LockRecord>;
  if (r.v !== 1 || (r.method !== 'password' && r.method !== 'pin' && r.method !== 'device')) return false;
  if (typeof r.autoLockMin !== 'number' || !(AUTO_LOCK_CHOICES as readonly number[]).includes(r.autoLockMin)) return false;
  if (typeof r.fails !== 'number' || typeof r.lockedUntil !== 'number' || typeof r.createdAt !== 'number') return false;
  if (r.method === 'device') return !!r.device && typeof r.device.id === 'string' && typeof r.device.publicKey === 'string' && typeof r.device.alg === 'number';
  return !!r.secret && typeof r.secret.salt === 'string' && typeof r.secret.hash === 'string' && typeof r.secret.iterations === 'number';
}

export class LockStore {
  constructor(private readonly storage: LockStorage | null) {}

  get(address: string): LockRecord | null {
    try {
      const raw = this.storage?.getItem(lockKey(address));
      if (!raw) return null;
      const v: unknown = JSON.parse(raw);
      return validRecord(v) ? v : null;
    } catch {
      return null;
    }
  }

  /** Whether this wallet has a lock. A wallet that never set one is never asked for anything. */
  has(address: string): boolean {
    return this.get(address) !== null;
  }

  set(address: string, rec: LockRecord): boolean {
    try {
      this.storage?.setItem(lockKey(address), JSON.stringify(rec));
      return this.storage !== null;
    } catch {
      return false;
    }
  }

  remove(address: string): void {
    try {
      if (this.storage?.removeItem) this.storage.removeItem(lockKey(address));
      else this.storage?.setItem(lockKey(address), '');
    } catch {
      // nothing more to do
    }
  }
}

// ------------------------------------------------------------------ the computer's own unlock (WebAuthn)

export interface DeviceDeps {
  credentials: Pick<CredentialsContainer, 'create' | 'get'>;
  subtle: SubtleCrypto;
  /** The site's name for the credential, e.g. "aretiafinance.org". */
  rpId: string;
  /** The page's origin, e.g. "https://aretiafinance.org". */
  origin: string;
}

const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

/** Whether this browser can ask the computer to verify the person (fingerprint, face, Windows Hello, a screen-lock PIN). */
export async function deviceUnlockAvailable(win: object = window): Promise<boolean> {
  try {
    const pk = (win as { PublicKeyCredential?: { isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean> } }).PublicKeyCredential;
    if (!pk || typeof pk.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return false;
    return await pk.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** Asks the computer to make a credential, which needs the person to unlock it once. Throws a plain message on failure. */
export async function registerDevice(label: string, deps: DeviceDeps): Promise<NonNullable<LockRecord['device']>> {
  const cred = (await deps.credentials.create({
    publicKey: {
      rp: { name: 'Aretia Finance', id: deps.rpId },
      user: { id: randomBytes(16) as BufferSource, name: label, displayName: label },
      challenge: randomBytes(32) as BufferSource,
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60_000,
      attestation: 'none',
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('The computer did not create an unlock for Aretia.');
  const res = cred.response as AuthenticatorAttestationResponse;
  const spki = res.getPublicKey?.();
  const alg = res.getPublicKeyAlgorithm?.();
  if (!spki || (alg !== -7 && alg !== -257)) throw new Error('This browser cannot check a device unlock here. Use a PIN or password instead.');
  const authData = res.getAuthenticatorData?.();
  if (authData && (new Uint8Array(authData)[32] & 0x04) === 0) throw new Error('The computer did not confirm who you are. Try again.');
  return { id: toB64Url(cred.rawId), publicKey: toB64Url(spki), alg };
}

/** ECDSA signatures from an authenticator are DER encoded; Web Crypto wants the two numbers side by side. */
export function derToRaw(der: Uint8Array, size: number): Uint8Array {
  let i = 2;
  if (der[0] !== 0x30) throw new Error('bad signature');
  if (der[1] & 0x80) i += der[1] & 0x7f;
  const part = (): Uint8Array => {
    if (der[i++] !== 0x02) throw new Error('bad signature');
    let len = der[i++];
    let start = i;
    i += len;
    while (len > size && der[start] === 0) {
      start++;
      len--;
    }
    const out = new Uint8Array(size);
    out.set(der.subarray(start, start + len), size - len);
    return out;
  };
  const r = part();
  const s = part();
  const raw = new Uint8Array(size * 2);
  raw.set(r, 0);
  raw.set(s, size);
  return raw;
}

/**
 * Asks the computer to verify the person, then checks the answer itself rather than trusting that a prompt appeared: the
 * challenge, site and origin must match, the person must have been verified, and the signature must be from the saved key.
 */
export async function verifyDevice(device: NonNullable<LockRecord['device']>, deps: DeviceDeps): Promise<boolean> {
  try {
    const challenge = randomBytes(32);
    const got = (await deps.credentials.get({
      publicKey: {
        challenge: challenge as BufferSource,
        rpId: deps.rpId,
        allowCredentials: [{ type: 'public-key', id: fromB64Url(device.id) as BufferSource, transports: ['internal'] }],
        userVerification: 'required',
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    if (!got) return false;
    const res = got.response as AuthenticatorAssertionResponse;
    const authData = new Uint8Array(res.authenticatorData);
    const clientBytes = new Uint8Array(res.clientDataJSON);
    const client = JSON.parse(new TextDecoder().decode(clientBytes)) as { type?: string; challenge?: string; origin?: string };
    if (client.type !== 'webauthn.get' || client.challenge !== toB64Url(challenge) || client.origin !== deps.origin) return false;
    const rpHash = new Uint8Array(await deps.subtle.digest('SHA-256', enc.encode(deps.rpId)));
    if (!sameBytes(authData.subarray(0, 32), rpHash)) return false;
    // Bit 0: the person was present. Bit 2: the computer verified who they are.
    if ((authData[32] & 0x01) === 0 || (authData[32] & 0x04) === 0) return false;
    const signed = new Uint8Array(authData.length + 32);
    signed.set(authData, 0);
    signed.set(new Uint8Array(await deps.subtle.digest('SHA-256', clientBytes)), authData.length);
    const spki = fromB64Url(device.publicKey) as BufferSource;
    const sig = new Uint8Array(res.signature);
    if (device.alg === -7) {
      const key = await deps.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return await deps.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(sig, 32) as BufferSource, signed as BufferSource);
    }
    const key = await deps.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await deps.subtle.verify('RSASSA-PKCS1-v1_5', key, sig as BufferSource, signed as BufferSource);
  } catch {
    // Cancelled, timed out, or the answer was not valid: not unlocked.
    return false;
  }
}

// ------------------------------------------------------------------ this computer

export interface Environment {
  userAgent: string;
  maxTouchPoints: number;
  /** A mouse or trackpad is the main pointer (not a finger). */
  finePointer: boolean;
}

/** True on a desktop or laptop computer; false on a phone or tablet, including an iPad that presents itself as a Mac. */
export function isDesktopComputer(env: Environment): boolean {
  if (/Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle/i.test(env.userAgent)) return false;
  if (/Macintosh/i.test(env.userAgent) && env.maxTouchPoints > 1) return false;
  return env.finePointer;
}

/** What to call the computer's own unlock, in the words that computer uses. */
export function deviceUnlockName(userAgent: string): string {
  if (/Windows/i.test(userAgent)) return 'Windows Hello (face, fingerprint or PIN)';
  if (/Macintosh|Mac OS/i.test(userAgent)) return 'Touch ID or your Mac password';
  if (/CrOS/i.test(userAgent)) return 'your Chromebook unlock (fingerprint or PIN)';
  return 'this computer’s unlock (fingerprint, face or screen-lock PIN)';
}
