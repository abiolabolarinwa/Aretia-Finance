import { beforeEach, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak256 } from '../src/swings/core/keccak.js';
import { loginMessage, parseLoginMessage } from '../src/swings/account/loginMessage.js';
import { resetRateLimit } from './_rpcProxy.js';
import { cleanTrade, handleAccount, resetAccountState, type AccountInput } from './_swingsAccount.js';
import { issueSession, readSession, verifyLogin } from './_swingsAuth.js';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://aretiafinance.org';
const DOMAIN = 'aretiafinance.org';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const toBase58 = (bytes: Uint8Array): string => {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)]! + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
};
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const NONCE = 'ab'.repeat(16);

function solanaSignIn(over: { domain?: string; issuedAt?: number; nonce?: string } = {}) {
  const priv = ed25519.utils.randomPrivateKey();
  const address = toBase58(ed25519.getPublicKey(priv));
  const message = loginMessage({ family: 'solana', address, domain: over.domain ?? DOMAIN, issuedAt: over.issuedAt ?? NOW, nonce: over.nonce ?? 'ab'.repeat(16) });
  const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(message), priv)).toString('base64');
  return { address, message, signature, priv };
}

function evmSignIn(over: { issuedAt?: number; nonce?: string; domain?: string } = {}) {
  const priv = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(priv, false).slice(1);
  const address = '0x' + hex(keccak256(pub).slice(12));
  const message = loginMessage({ family: 'evm', address, domain: over.domain ?? DOMAIN, issuedAt: over.issuedAt ?? NOW, nonce: over.nonce ?? 'cd'.repeat(16) });
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix);
  joined.set(body, prefix.length);
  const sig = secp256k1.sign(keccak256(joined), priv);
  const signature = '0x' + sig.toCompactHex() + (27 + sig.recovery).toString(16);
  return { address, message, signature };
}

describe('the sign-in message', () => {
  it('is read back only if it is exactly the message Aretia writes', () => {
    const m = loginMessage({ family: 'solana', address: 'Addr', domain: DOMAIN, issuedAt: NOW, nonce: 'ab'.repeat(16) });
    expect(parseLoginMessage(m)).toMatchObject({ family: 'solana', address: 'Addr', domain: DOMAIN, issuedAt: NOW });
    expect(parseLoginMessage(m + '\nExtra: yes')).toBeNull();
    expect(parseLoginMessage(m.replace('Sign in to Aretia Wallet', 'Pay me'))).toBeNull();
    expect(parseLoginMessage('hello')).toBeNull();
  });

  it('follows EIP-4361 for EVM wallets (checksummed address) and Sign In With Solana for Solana wallets', () => {
    const evm = loginMessage({ family: 'evm', address: '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', domain: DOMAIN, issuedAt: NOW, nonce: 'ab'.repeat(16) });
    const lines = evm.split('\n');
    expect(lines[0]).toBe('aretiafinance.org wants you to sign in with your Ethereum account:');
    expect(lines[1]).toBe('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
    expect(lines.slice(5)).toEqual(['URI: https://aretiafinance.org', 'Version: 1', 'Chain ID: 1', `Nonce: ${'ab'.repeat(16)}`, `Issued At: ${new Date(NOW).toISOString()}`]);
    // a lower-case address in an otherwise identical message is not the message Aretia writes
    expect(parseLoginMessage(evm.replace(lines[1]!, lines[1]!.toLowerCase()))).toBeNull();
    const sol = loginMessage({ family: 'solana', address: 'Addr', domain: DOMAIN, issuedAt: NOW, nonce: 'ab'.repeat(16) });
    expect(sol.split('\n')[0]).toBe('aretiafinance.org wants you to sign in with your Solana account:');
    expect(sol).toContain('Chain ID: mainnet');
  });
});

describe('proof of wallet ownership', () => {
  it('accepts a real Solana signature and a real Ethereum-style signature', () => {
    const s = solanaSignIn();
    expect(verifyLogin({ message: s.message, signature: s.signature, domain: DOMAIN, now: NOW })).toMatchObject({ ok: true, owner: `solana:${s.address}` });
    const e = evmSignIn();
    expect(verifyLogin({ message: e.message, signature: e.signature, domain: DOMAIN, now: NOW })).toMatchObject({ ok: true, owner: `evm:${e.address}` });
  });

  it('I-21: refuses a small-order ed25519 "address" with a forged signature', () => {
    const id = new Uint8Array(32);
    id[0] = 1; // the identity point
    const message = loginMessage({ family: 'solana', address: toBase58(id), domain: DOMAIN, issuedAt: NOW, nonce: NONCE });
    const sig = new Uint8Array(64);
    sig[0] = 1; // R = identity, S = 0
    expect(verifyLogin({ message, signature: Buffer.from(sig).toString('base64'), domain: DOMAIN, now: NOW })).toMatchObject({ ok: false });
  });

  it('refuses a signature from another key, another site, an old message and garbage', () => {
    const s = solanaSignIn();
    const other = solanaSignIn();
    expect(verifyLogin({ message: s.message, signature: other.signature, domain: DOMAIN, now: NOW })).toMatchObject({ ok: false });
    expect(verifyLogin({ message: s.message, signature: s.signature, domain: 'evil.example', now: NOW })).toMatchObject({ ok: false });
    expect(verifyLogin({ message: s.message, signature: s.signature, domain: DOMAIN, now: NOW + 10 * 60_000 })).toMatchObject({ ok: false });
    expect(verifyLogin({ message: s.message, signature: 'AAAA', domain: DOMAIN, now: NOW })).toMatchObject({ ok: false });
    const e = evmSignIn();
    const wrong = evmSignIn();
    expect(verifyLogin({ message: e.message, signature: wrong.signature, domain: DOMAIN, now: NOW })).toMatchObject({ ok: false });
    expect(verifyLogin({ message: e.message, signature: '0x1234', domain: DOMAIN, now: NOW })).toMatchObject({ ok: false });
  });

  it('issues a session that only that owner can use, and refuses forged, altered and expired ones', () => {
    const { token, expiresAt } = issueSession('secret', 'evm:0xabc', NOW);
    expect(readSession('secret', token, NOW)).toBe('evm:0xabc');
    expect(readSession('other-secret', token, NOW)).toBeNull();
    expect(readSession('secret', token, expiresAt + 1)).toBeNull();
    const parts = token.split('.');
    const forged = `${parts[0]}.${Buffer.from(JSON.stringify({ o: 'evm:0xdef', e: expiresAt })).toString('base64url')}.${parts[2]}`;
    expect(readSession('secret', forged, NOW)).toBeNull();
    expect(readSession('secret', 'nonsense', NOW)).toBeNull();
    expect(readSession('secret', null, NOW)).toBeNull();
  });
});

function setup() {
  const calls: { method: string; url: string; body: string | null }[] = [];
  // The sign-in tables of migration 0014, as PostgREST would answer them.
  const nonces = new Map<string, { expires_at: number; used_at: number | null; owner: string | null }>();
  const versions = new Map<string, number>();
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? init.body : null });
    const method = init?.method ?? 'GET';
    const params = new URLSearchParams(url.split('?')[1] ?? '');
    if (url.includes('/rest/v1/auth_nonces')) {
      if (method === 'POST') {
        const row = JSON.parse(String(init!.body)) as { nonce: string; expires_at: number };
        nonces.set(row.nonce, { expires_at: row.expires_at, used_at: null, owner: null });
        return new Response('', { status: 201 });
      }
      const n = nonces.get(params.get('nonce')!.slice(3));
      const now = Number(params.get('expires_at')!.slice(3));
      if (!n || n.used_at !== null || n.expires_at <= now) return new Response('[]');
      const patch = JSON.parse(String(init!.body)) as { used_at: number; owner: string };
      Object.assign(n, patch);
      return new Response(JSON.stringify([n]));
    }
    if (url.includes('/rest/v1/account_sessions')) {
      if (method === 'POST') {
        const row = JSON.parse(String(init!.body)) as { owner: string; version: number };
        versions.set(row.owner, row.version);
        return new Response('', { status: 201 });
      }
      const v = versions.get(decodeURIComponent(params.get('owner')!.slice(3)));
      return new Response(JSON.stringify(v === undefined ? [] : [{ version: v }]));
    }
    if (url.includes('user_favourites') && (init?.method ?? 'GET') === 'GET' && url.includes('select=chain')) return new Response(JSON.stringify([{ chain: 'solana', address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', name: 'Solana', icon: null, added_at: 5 }]));
    if (url.includes('user_trades') && (init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify([{ data: { id: 't1' } }]));
    if (url.includes('select=address')) return new Response('[]');
    return new Response('');
  }) as unknown as typeof fetch;
  const base = { method: 'POST', origin: ORIGIN, authorization: null as string | null, ip: '4.4.4.4', env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test' }, fetchImpl, now: NOW };
  const call = (body: unknown, auth: string | null = null, over: Partial<AccountInput> = {}) => handleAccount({ ...base, authorization: auth, body, ...over });
  /** Asks the server for a nonce, as the page does before building the message. */
  const nonce = async (): Promise<string> => (JSON.parse((await call({ op: 'nonce' })).body) as { nonce: string }).nonce;
  return { calls, call, nonce, nonces, versions };
}

describe('the account endpoint', () => {
  beforeEach(() => {
    resetRateLimit();
    resetAccountState();
  });

  it('signs a person in once per signature, then serves only their own rows', async () => {
    const { calls, call, nonce } = setup();
    const s = solanaSignIn({ nonce: await nonce() });
    const login = await call({ op: 'login', message: s.message, signature: s.signature });
    expect(login.status).toBe(200);
    const { token, owner } = JSON.parse(login.body) as { token: string; owner: string };
    expect(owner).toBe(`solana:${s.address}`);
    expect((await call({ op: 'login', message: s.message, signature: s.signature })).status).toBe(401);
    const got = await call({ op: 'get' }, `Bearer ${token}`);
    expect(got.status).toBe(200);
    expect(JSON.parse(got.body).favourites[0]).toMatchObject({ symbol: 'SOL' });
    expect(calls.filter((c) => c.url.includes('user_')).every((c) => c.url.includes(encodeURIComponent(owner)))).toBe(true);
  });

  it('needs a session for everything but login, and a good origin', async () => {
    const { call } = setup();
    expect((await call({ op: 'get' })).status).toBe(401);
    expect((await call({ op: 'get' }, 'Bearer nope')).status).toBe(401);
    expect((await call({ op: 'login' }, null, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call({}, null, { method: 'GET' })).status).toBe(405);
  });

  it('saves and removes a favourite, scoped to the owner, and refuses a bad token', async () => {
    const { calls, call, nonce } = setup();
    const e = evmSignIn({ nonce: await nonce() });
    const token = (JSON.parse((await call({ op: 'login', message: e.message, signature: e.signature })).body) as { token: string }).token;
    const add = await call({ op: 'favourite', chain: 'base', address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', icon: 'https://x.example/a.png', on: true }, `Bearer ${token}`);
    expect(add.status).toBe(200);
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('user_favourites'))!;
    expect(JSON.parse(post.body!)).toMatchObject({ owner: `evm:${e.address}`, chain: 'base', symbol: 'WETH' });
    const del = await call({ op: 'favourite', chain: 'base', address: '0x4200000000000000000000000000000000000006', on: false }, `Bearer ${token}`);
    expect(del.status).toBe(200);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes(encodeURIComponent(`evm:${e.address}`)))).toBe(true);
    expect((await call({ op: 'favourite', chain: 'base', address: 'bad', symbol: 'X', on: true }, `Bearer ${token}`)).status).toBe(400);
  });

  it('saves only swaps that belong to the signed-in address', async () => {
    const { calls, call, nonce } = setup();
    const e = evmSignIn({ nonce: await nonce() });
    const token = (JSON.parse((await call({ op: 'login', message: e.message, signature: e.signature })).body) as { token: string }).token;
    const mine = { id: 'a', at: 5, account: e.address, chain: 'base', provider: 'aretia', fromSymbol: 'ETH', toSymbol: 'USDC', amountIn: '1', expectedOut: '2', txId: '0xabc', status: 'confirmed' };
    const theirs = { ...mine, id: 'b', account: '0x' + '9'.repeat(40) };
    const out = await call({ op: 'trades', items: [mine, theirs, { id: 'c' }] }, `Bearer ${token}`);
    expect(JSON.parse(out.body)).toEqual({ saved: 1, skipped: 2 });
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('user_trades'))!;
    expect(JSON.parse(post.body!)).toHaveLength(1);
  });

  it('refuses a nonce the server never issued, and an expired one', async () => {
    const { call, nonce } = setup();
    const made = solanaSignIn({ nonce: 'ef'.repeat(16) });
    expect((await call({ op: 'login', message: made.message, signature: made.signature })).status).toBe(401);
    const n = await nonce();
    const late = solanaSignIn({ nonce: n, issuedAt: NOW + 6 * 60_000 });
    expect((await call({ op: 'login', message: late.message, signature: late.signature }, null, { now: NOW + 6 * 60_000 })).status).toBe(401);
  });

  it('L-3: a sign-in cannot be replayed by re-encoding the signature (no 0x, upper case), on any instance', async () => {
    const { call, nonce } = setup();
    const e = evmSignIn({ nonce: await nonce() });
    const hexSig = e.signature.slice(2);
    expect((await call({ op: 'login', message: e.message, signature: e.signature })).status).toBe(200);
    resetAccountState(); // a fresh server instance: the used nonce lives in the database, not in memory
    for (const sig of [e.signature, hexSig, '0x' + hexSig.toUpperCase()]) expect((await call({ op: 'login', message: e.message, signature: sig })).status).toBe(401);
  });

  it('L-3: the site a message must name comes from configuration, not from the Origin header', async () => {
    const { call, nonce } = setup();
    // A preview origin is allowed for requests, but a message naming it is refused unless it is a configured sign-in domain.
    const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test', RPC_ALLOWED_ORIGINS: 'https://preview.example', SWINGS_LOGIN_DOMAINS: 'aretiafinance.org' };
    const e = evmSignIn({ nonce: await nonce(), domain: 'preview.example' });
    expect((await call({ op: 'login', message: e.message, signature: e.signature }, null, { origin: 'https://preview.example', env })).status).toBe(401);
    const good = evmSignIn({ nonce: await nonce() });
    expect((await call({ op: 'login', message: good.message, signature: good.signature }, null, { origin: 'https://preview.example', env })).status).toBe(200);
  });

  it('L-3: sign out everywhere ends tokens issued before it', async () => {
    const { call, nonce } = setup();
    const e = evmSignIn({ nonce: await nonce() });
    const token = (JSON.parse((await call({ op: 'login', message: e.message, signature: e.signature })).body) as { token: string }).token;
    expect((await call({ op: 'get' }, `Bearer ${token}`)).status).toBe(200);
    expect((await call({ op: 'sign-out-all' }, `Bearer ${token}`)).status).toBe(200);
    expect((await call({ op: 'get' }, `Bearer ${token}`)).status).toBe(401);
    const again = evmSignIn({ nonce: await nonce() });
    const fresh = (JSON.parse((await call({ op: 'login', message: again.message, signature: again.signature })).body) as { token: string }).token;
    expect((await call({ op: 'get' }, `Bearer ${fresh}`)).status).toBe(200);
  });

  it('cleanTrade keeps a solana address as written and refuses odd values', () => {
    const item = { id: 'a', at: 1, account: 'SoLAddr', chain: 'solana', provider: 'p', fromSymbol: 'A', toSymbol: 'B', amountIn: '1', expectedOut: '1', txId: null, status: 'confirmed' };
    expect(cleanTrade(item, 'SoLAddr')?.id).toBe('a');
    expect(cleanTrade(item, 'soladdr')).toBeNull();
    expect(cleanTrade({ ...item, status: 'weird' }, 'SoLAddr')).toBeNull();
  });

  it('cleanTrade keeps the two token addresses when they are sensible, and drops them when they are not', () => {
    const item = { id: 'a', at: 1, account: 'SoLAddr', chain: 'solana', provider: 'p', fromSymbol: 'A', toSymbol: 'B', amountIn: '1', expectedOut: '1', txId: null, status: 'confirmed' };
    const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    expect(cleanTrade({ ...item, fromAddress: mint, toAddress: mint }, 'SoLAddr')?.data).toMatchObject({ fromAddress: mint, toAddress: mint });
    const bad = cleanTrade({ ...item, fromAddress: 'x', toAddress: 5 }, 'SoLAddr')?.data;
    expect(bad).not.toHaveProperty('fromAddress');
    expect(bad).not.toHaveProperty('toAddress');
  });
});
