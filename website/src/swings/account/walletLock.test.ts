import { describe, expect, it } from 'vitest';
import {
  afterTry,
  deviceUnlockName,
  derToRaw,
  FREE_TRIES,
  fromB64Url,
  hashSecret,
  isDesktopComputer,
  LockStore,
  lockKey,
  passwordProblem,
  pinProblem,
  registerDevice,
  secretMatches,
  toB64Url,
  verifyDevice,
  waitMs,
  type DeviceDeps,
  type LockRecord,
  type LockStorage,
} from './walletLock.js';

const FAST = 1000; // PBKDF2 rounds: the real count is far higher and slow to run in a test

function memory(): LockStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const base: LockRecord = { v: 1, method: 'pin', createdAt: 1, autoLockMin: 15, secret: { salt: 'a', hash: 'b', iterations: 1 }, fails: 0, lockedUntil: 0 };

describe('PIN and password rules', () => {
  it('accepts 6 to 10 digits that are not obvious', () => {
    expect(pinProblem('493817')).toBeNull();
    expect(pinProblem('4938172650')).toBeNull();
  });
  it('refuses short, long, non-digit, repeated and run PINs', () => {
    for (const bad of ['12345', '49381726501', '49a817', '000000', '777777', '123456', '654321', '234567']) expect(pinProblem(bad), bad).not.toBeNull();
  });
  it('wants 8 characters and not just spaces', () => {
    expect(passwordProblem('correct horse')).toBeNull();
    expect(passwordProblem('short')).not.toBeNull();
    expect(passwordProblem('        ')).not.toBeNull();
  });
});

describe('hashing', () => {
  it('matches the right secret and refuses a wrong one', async () => {
    const saved = await hashSecret('493817', FAST);
    expect(await secretMatches('493817', saved)).toBe(true);
    expect(await secretMatches('493818', saved)).toBe(false);
    expect(await secretMatches('', saved)).toBe(false);
  });
  it('salts every hash, and never stores the secret itself', async () => {
    const a = await hashSecret('same secret', FAST);
    const b = await hashSecret('same secret', FAST);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    expect(JSON.stringify(a)).not.toContain('same secret');
  });
  it('refuses a damaged record rather than throwing', async () => {
    expect(await secretMatches('x', { salt: 'a', hash: 'b', iterations: 0 })).toBe(false);
  });
});

describe('wrong tries', () => {
  it('allows five wrong tries, then makes the person wait, longer each time', () => {
    let rec = base;
    for (let i = 0; i < FREE_TRIES; i++) {
      rec = afterTry(rec, false, 1000);
      expect(waitMs(rec, 1000)).toBe(0);
    }
    rec = afterTry(rec, false, 1000);
    expect(waitMs(rec, 1000)).toBe(30_000);
    rec = afterTry(rec, false, 1000);
    expect(waitMs(rec, 1000)).toBe(60_000);
  });
  it('never waits more than fifteen minutes', () => {
    let rec = base;
    for (let i = 0; i < 40; i++) rec = afterTry(rec, false, 0);
    expect(waitMs(rec, 0)).toBe(15 * 60_000);
  });
  it('resets on a right try', () => {
    let rec = base;
    for (let i = 0; i < 8; i++) rec = afterTry(rec, false, 0);
    rec = afterTry(rec, true, 0);
    expect(rec.fails).toBe(0);
    expect(waitMs(rec, 0)).toBe(0);
  });
  it('stops waiting once the time has passed', () => {
    expect(waitMs({ lockedUntil: 5000 }, 6000)).toBe(0);
  });
});

describe('LockStore: one lock per wallet', () => {
  it('only the wallet that set a lock has one', () => {
    const store = new LockStore(memory());
    store.set('WalletA', base);
    expect(store.has('WalletA')).toBe(true);
    expect(store.has('WalletB')).toBe(false);
    expect(store.get('WalletB')).toBeNull();
  });
  it('keeps each wallet’s own lock apart', () => {
    const store = new LockStore(memory());
    store.set('A', { ...base, autoLockMin: 5 });
    store.set('B', { ...base, autoLockMin: 30 });
    expect(store.get('A')?.autoLockMin).toBe(5);
    expect(store.get('B')?.autoLockMin).toBe(30);
    store.remove('A');
    expect(store.has('A')).toBe(false);
    expect(store.has('B')).toBe(true);
  });
  it('treats an Ethereum-style address the same in any letter case, but not a Solana one', () => {
    const upper = '0x' + 'AB'.repeat(20);
    expect(lockKey(upper)).toBe(lockKey(upper.toLowerCase()));
    expect(lockKey('AbCd')).not.toBe(lockKey('abcd'));
  });
  it('ignores a damaged or hostile saved lock instead of locking people out or letting them in by accident', () => {
    const m = memory();
    const store = new LockStore(m);
    m.setItem(lockKey('A'), '{oops');
    expect(store.get('A')).toBeNull();
    m.setItem(lockKey('A'), JSON.stringify({ ...base, method: 'face' }));
    expect(store.get('A')).toBeNull();
    m.setItem(lockKey('A'), JSON.stringify({ ...base, secret: undefined }));
    expect(store.get('A')).toBeNull();
    m.setItem(lockKey('A'), JSON.stringify({ ...base, autoLockMin: 1 }));
    expect(store.get('A')).toBeNull();
  });
  it('removes a lock even from storage that cannot delete', () => {
    const data = new Map<string, string>();
    const store = new LockStore({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) });
    store.set('A', base);
    store.remove('A');
    expect(store.has('A')).toBe(false);
  });
  it('says so when it could not save', () => {
    expect(new LockStore(null).set('A', base)).toBe(false);
    expect(new LockStore({ getItem: () => null, setItem: () => { throw new Error('full'); } }).set('A', base)).toBe(false);
  });
});

describe('desktop only', () => {
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
  it('is true for a laptop or desktop with a mouse or trackpad', () => {
    expect(isDesktopComputer({ userAgent: chrome, maxTouchPoints: 0, finePointer: true })).toBe(true);
    expect(isDesktopComputer({ userAgent: chrome, maxTouchPoints: 10, finePointer: true })).toBe(true); // touchscreen laptop
  });
  it('is false for phones and tablets, including an iPad that says it is a Mac', () => {
    expect(isDesktopComputer({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148', maxTouchPoints: 5, finePointer: false })).toBe(false);
    expect(isDesktopComputer({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126 Mobile Safari/537.36', maxTouchPoints: 5, finePointer: false })).toBe(false);
    expect(isDesktopComputer({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', maxTouchPoints: 5, finePointer: false })).toBe(false);
    expect(isDesktopComputer({ userAgent: chrome, maxTouchPoints: 5, finePointer: false })).toBe(false);
  });
  it('names the computer’s own unlock the way that computer does', () => {
    expect(deviceUnlockName(chrome)).toMatch(/Windows Hello/);
    expect(deviceUnlockName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toMatch(/Touch ID/);
  });
});

// ---------------------------------------------------------------- device unlock, with a pretend authenticator

const RP = 'aretiafinance.org';
const ORIGIN = 'https://aretiafinance.org';
const enc = new TextEncoder();

/** An ECDSA signature as an authenticator sends it: DER, not the plain pair Web Crypto produces. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array): number[] => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const body = [...b.subarray(i)];
    if (body[0] & 0x80) body.unshift(0);
    return [0x02, body.length, ...body];
  };
  const r = int(raw.subarray(0, 32));
  const s = int(raw.subarray(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

async function fakeAuthenticator(opts: { flags?: number; rpId?: string; origin?: string; tamper?: boolean; wrongChallenge?: boolean } = {}) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const rawId = crypto.getRandomValues(new Uint8Array(16));
  const credentials = {
    async create() {
      return { rawId: rawId.buffer, response: { getPublicKey: () => spki.buffer, getPublicKeyAlgorithm: () => -7, getAuthenticatorData: () => new Uint8Array(37).fill(0).map((_, i) => (i === 32 ? 0x45 : 0)).buffer } };
    },
    async get(o: CredentialRequestOptions) {
      const challenge = new Uint8Array(o.publicKey!.challenge as ArrayBuffer);
      const clientData = enc.encode(JSON.stringify({ type: 'webauthn.get', challenge: toB64Url(opts.wrongChallenge ? crypto.getRandomValues(new Uint8Array(32)) : challenge), origin: opts.origin ?? ORIGIN }));
      const authData = new Uint8Array(37);
      authData.set(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(opts.rpId ?? RP))), 0);
      authData[32] = opts.flags ?? 0x05;
      const signed = new Uint8Array(37 + 32);
      signed.set(authData, 0);
      signed.set(new Uint8Array(await crypto.subtle.digest('SHA-256', clientData)), 37);
      const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signed));
      if (opts.tamper) raw[5] ^= 0xff;
      return { rawId: rawId.buffer, response: { authenticatorData: authData.buffer, clientDataJSON: clientData.buffer, signature: rawToDer(raw).buffer } };
    },
  };
  const deps = { credentials, subtle: crypto.subtle, rpId: RP, origin: ORIGIN } as unknown as DeviceDeps;
  return deps;
}

describe('device unlock', () => {
  it('registers, then accepts a genuine verified answer', async () => {
    const deps = await fakeAuthenticator();
    const device = await registerDevice('Aretia wallet 8s2T…DRHz', deps);
    expect(device.alg).toBe(-7);
    expect(await verifyDevice(device, deps)).toBe(true);
  });
  it('refuses an answer signed by some other key', async () => {
    const device = await registerDevice('x', await fakeAuthenticator());
    expect(await verifyDevice(device, await fakeAuthenticator())).toBe(false);
  });
  it('refuses a tampered signature', async () => {
    const deps = await fakeAuthenticator({ tamper: true });
    const device = await registerDevice('x', deps);
    expect(await verifyDevice(device, deps)).toBe(false);
  });
  it('refuses an answer to a different challenge, site or origin', async () => {
    for (const opts of [{ wrongChallenge: true }, { rpId: 'evil.example' }, { origin: 'https://evil.example' }]) {
      const deps = await fakeAuthenticator(opts);
      const device = await registerDevice('x', deps);
      expect(await verifyDevice(device, deps), JSON.stringify(opts)).toBe(false);
    }
  });
  it('refuses an answer where the computer did not verify the person', async () => {
    for (const flags of [0x01, 0x04, 0x00]) {
      const deps = await fakeAuthenticator({ flags });
      const device = await registerDevice('x', deps);
      expect(await verifyDevice(device, deps), `flags ${flags}`).toBe(false);
    }
  });
  it('treats a cancelled prompt as not unlocked', async () => {
    const deps = await fakeAuthenticator();
    const device = await registerDevice('x', deps);
    const cancelled = { ...deps, credentials: { ...deps.credentials, get: async () => { throw new DOMException('cancelled', 'NotAllowedError'); } } } as unknown as DeviceDeps;
    expect(await verifyDevice(device, cancelled)).toBe(false);
  });
  it('will not register when the browser cannot hand over a key to check against', async () => {
    const deps = (await fakeAuthenticator()) as unknown as { credentials: { create: () => Promise<unknown> } };
    deps.credentials.create = async () => ({ rawId: new ArrayBuffer(8), response: {} });
    await expect(registerDevice('x', deps as unknown as DeviceDeps)).rejects.toThrow(/cannot check/);
  });
});

describe('encoding helpers', () => {
  it('round-trips base64url', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(33));
    expect([...fromB64Url(toB64Url(bytes))]).toEqual([...bytes]);
    expect(toB64Url(bytes)).not.toMatch(/[+/=]/);
  });
  it('turns a DER signature into the plain pair, with or without padding bytes', () => {
    const der = new Uint8Array([0x30, 0x08, 0x02, 0x02, 0x00, 0x80, 0x02, 0x02, 0x01, 0x02]);
    const raw = derToRaw(der, 4);
    expect([...raw]).toEqual([0, 0, 0, 0x80, 0, 0, 0x01, 0x02]);
    expect(() => derToRaw(new Uint8Array([1, 2, 3]), 4)).toThrow();
  });
});
