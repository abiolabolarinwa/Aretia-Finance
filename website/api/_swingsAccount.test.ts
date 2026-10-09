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

function solanaSignIn(over: { domain?: string; issuedAt?: number; nonce?: string } = {}) {
  const priv = ed25519.utils.randomPrivateKey();
  const address = toBase58(ed25519.getPublicKey(priv));
  const message = loginMessage({ family: 'solana', address, domain: over.domain ?? DOMAIN, issuedAt: over.issuedAt ?? NOW, nonce: over.nonce ?? 'ab'.repeat(16) });
  const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(message), priv)).toString('base64');
  return { address, message, signature, priv };
}

function evmSignIn(over: { issuedAt?: number } = {}) {
  const priv = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(priv, false).slice(1);
  const address = '0x' + hex(keccak256(pub).slice(12));
  const message = loginMessage({ family: 'evm', address, domain: DOMAIN, issuedAt: over.issuedAt ?? NOW, nonce: 'cd'.repeat(16) });
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
    expect(parseLoginMessage(m.replace('Aretia Wallet sign-in', 'Pay me'))).toBeNull();
    expect(parseLoginMessage('hello')).toBeNull();
  });
});

describe('proof of wallet ownership', () => {
  it('accepts a real Solana signature and a real Ethereum-style signature', () => {
    const s = solanaSignIn();
    expect(verifyLogin({ message: s.message, signature: s.signature, domain: DOMAIN, now: NOW })).toMatchObject({ ok: true, owner: `solana:${s.address}` });
    const e = evmSignIn();
    expect(verifyLogin({ message: e.message, signature: e.signature, domain: DOMAIN, now: NOW })).toMatchObject({ ok: true, owner: `evm:${e.address}` });
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
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? init.body : null });
    if (url.includes('user_favourites') && (init?.method ?? 'GET') === 'GET' && url.includes('select=chain')) return new Response(JSON.stringify([{ chain: 'solana', address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', name: 'Solana', icon: null, added_at: 5 }]));
    if (url.includes('user_trades') && (init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify([{ data: { id: 't1' } }]));
    if (url.includes('select=address')) return new Response('[]');
    return new Response('');
  }) as unknown as typeof fetch;
  const base = { method: 'POST', origin: ORIGIN, authorization: null as string | null, ip: '4.4.4.4', env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test' }, fetchImpl, now: NOW };
  const call = (body: unknown, auth: string | null = null, over: Partial<AccountInput> = {}) => handleAccount({ ...base, authorization: auth, body, ...over });
  return { calls, call };
}

describe('the account endpoint', () => {
  beforeEach(() => {
    resetRateLimit();
    resetAccountState();
  });

  it('signs a person in once per signature, then serves only their own rows', async () => {
    const { calls, call } = setup();
    const s = solanaSignIn();
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
    const { calls, call } = setup();
    const e = evmSignIn();
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
    const { calls, call } = setup();
    const e = evmSignIn();
    const token = (JSON.parse((await call({ op: 'login', message: e.message, signature: e.signature })).body) as { token: string }).token;
    const mine = { id: 'a', at: 5, account: e.address, chain: 'base', provider: 'aretia', fromSymbol: 'ETH', toSymbol: 'USDC', amountIn: '1', expectedOut: '2', txId: '0xabc', status: 'confirmed' };
    const theirs = { ...mine, id: 'b', account: '0x' + '9'.repeat(40) };
    const out = await call({ op: 'trades', items: [mine, theirs, { id: 'c' }] }, `Bearer ${token}`);
    expect(JSON.parse(out.body)).toEqual({ saved: 1, skipped: 2 });
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('user_trades'))!;
    expect(JSON.parse(post.body!)).toHaveLength(1);
  });

  it('cleanTrade keeps a solana address as written and refuses odd values', () => {
    const item = { id: 'a', at: 1, account: 'SoLAddr', chain: 'solana', provider: 'p', fromSymbol: 'A', toSymbol: 'B', amountIn: '1', expectedOut: '1', txId: null, status: 'confirmed' };
    expect(cleanTrade(item, 'SoLAddr')?.id).toBe('a');
    expect(cleanTrade(item, 'soladdr')).toBeNull();
    expect(cleanTrade({ ...item, status: 'weird' }, 'SoLAddr')).toBeNull();
  });
});
