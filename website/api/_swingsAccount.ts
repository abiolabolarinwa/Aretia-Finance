/**
 * POST /api/swings-account: favourite tokens and swap history that follow a wallet address across devices.
 *
 *   { op: 'nonce' }                        a single-use value to put in the sign-in message (valid five minutes)
 *   { op: 'login', message, signature }   prove control of an address; answers with a session token
 *   { op: 'sign-out-all' }                 end every session of this address, on every device
 *   { op: 'get' }                          the person's favourites and saved trades
 *   { op: 'favourite', chain, address, symbol, name, icon, on }   add or remove one favourite
 *   { op: 'trades', items: [...] }         save swap-history items (already-saved ones are kept as they are)
 *
 * Everything after login needs `Authorization: Bearer <session token>`, and only ever touches the rows of the address
 * the token was issued for. Nothing here can move funds, and no key or recovery phrase is ever sent: a signature over a
 * plain message is the only proof asked for. Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and migration 0014 (sign-in nonces
 * and session versions). SWINGS_SESSION_SECRET should be set to its own secret; until it is, the session key is derived from the
 * service key and a warning is logged.
 */
import { supabaseBase, supabaseHeaders } from '../src/swings/tokens/supabaseAuth.js';
import { isOriginAllowed, overLimit } from './_rpcProxy.js';
import { CHAINS, isChainId, type ChainId } from '../src/swings/core/types.js';
import { normalizeTokenRef } from '../src/swings/core/token.js';
import { cleanLogo, cleanText } from '../src/swings/tokens/registry.js';
import { issueSession, loginDomains, sessionOwner, sessionSecret, sessionVersion, verifyLogin } from './_swingsAuth.js';
import { overBudget, resetBudgets } from './_limits.js';
import { LOGIN_WINDOW_MS } from '../src/swings/account/loginMessage.js';
import type { TokensEnv } from './_swingsTokens.js';

export interface AccountInput {
  method: string;
  origin: string | null;
  authorization: string | null;
  ip: string;
  body: unknown;
  env: TokensEnv & { SWINGS_SESSION_SECRET?: string; SWINGS_LOGIN_DOMAINS?: string };
  fetchImpl: typeof fetch;
  now: number;
}
export interface AccountOutput {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const MAX_FAVOURITES = 500;
const MAX_TRADES = 200;
const STATUSES = ['quoting', 'building', 'simulating', 'awaiting-signature', 'submitted', 'confirmed', 'failed', 'rejected', 'expired'];
/** Sign-in nonces one address (IP) may ask for per minute. */
const NONCES_PER_MINUTE = 20;

export function resetAccountState(): void {
  resetBudgets();
}

const randomHex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

const json = (status: number, data: unknown, headers: Record<string, string>): AccountOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export interface Rest {
  call(path: string, init?: RequestInit): Promise<unknown>;
}

export function rest(url: string, key: string, fetchImpl: typeof fetch): Rest {
  return {
    async call(path, init = {}) {
      const res = await fetchImpl(`${url}/rest/v1/${path}`, { ...init, headers: { ...supabaseHeaders(key), 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) } });
      if (!res.ok) throw new Error(`The account database answered ${res.status}.`);
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    },
  };
}

/** A swap-history item as the page stores it, checked field by field; anything else is refused. */
export function cleanTrade(v: unknown, account: string): { id: string; at: number; data: Record<string, unknown> } | null {
  const o = obj(v);
  const str = (x: unknown, max: number): string | null => (typeof x === 'string' && x.length > 0 && x.length <= max ? cleanText(x, max) : null);
  const id = str(o.id, 80);
  const provider = str(o.provider, 60);
  const fromSymbol = str(o.fromSymbol, 24);
  const toSymbol = str(o.toSymbol, 24);
  const amountIn = str(o.amountIn, 60);
  const expectedOut = str(o.expectedOut, 60);
  const at = typeof o.at === 'number' && Number.isFinite(o.at) && o.at > 0 ? Math.floor(o.at) : null;
  const chain = typeof o.chain === 'string' && isChainId(o.chain) ? o.chain : null;
  const txId = o.txId === null ? null : str(o.txId, 130);
  const status = typeof o.status === 'string' && STATUSES.includes(o.status) ? o.status : null;
  if (!id || !provider || !fromSymbol || !toSymbol || !amountIn || !expectedOut || at === null || !chain || !status || (o.txId !== null && txId === null)) return null;
  // Only the owner's own swaps are kept: the account on the item must be the address that signed in.
  const acct = typeof o.account === 'string' ? o.account : '';
  const same = chain === 'solana' ? acct === account : acct.toLowerCase() === account.toLowerCase();
  if (!same) return null;
  // The tokens' addresses are kept when they are plain strings of a sensible length, so the activity list can open the token.
  const fromAddress = typeof o.fromAddress === 'string' && o.fromAddress.length >= 20 && o.fromAddress.length <= 100 ? cleanText(o.fromAddress, 100) : '';
  const toAddress = typeof o.toAddress === 'string' && o.toAddress.length >= 20 && o.toAddress.length <= 100 ? cleanText(o.toAddress, 100) : '';
  return { id, at, data: { id, at, account: acct, chain, provider, fromSymbol, toSymbol, amountIn, expectedOut, txId, status, ...(fromAddress ? { fromAddress } : {}), ...(toAddress ? { toAddress } : {}) } };
}

export async function handleAccount(input: AccountInput): Promise<AccountOutput> {
  const headers: Record<string, string> = { vary: 'origin', 'cache-control': 'no-store' };
  const allowed = isOriginAllowed(input.origin, input.env);
  if (allowed) {
    headers['access-control-allow-origin'] = input.origin!;
    headers['access-control-allow-methods'] = 'POST, OPTIONS';
    headers['access-control-allow-headers'] = 'content-type, authorization';
  }
  if (input.method === 'OPTIONS') return { status: allowed ? 204 : 403, body: '', headers };
  if (input.method !== 'POST') return json(405, { error: 'method' }, { ...headers, allow: 'POST, OPTIONS' });
  if (!allowed) return json(403, { error: 'origin' }, headers);
  const url = supabaseBase(input.env.SUPABASE_URL);
  const key = input.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return json(503, { error: 'not-configured', message: 'Saving to your wallet is not set up on this server yet.' }, headers);
  if (overLimit(`account:${input.ip}`, input.now)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '60' });
  const secret = sessionSecret(input.env) ?? key;
  const body = obj(input.body);
  const op = body.op;
  const db = rest(url, key, input.fetchImpl);

  if (op === 'nonce') {
    if (overBudget(`nonce:${input.ip}`, input.now, NONCES_PER_MINUTE)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '60' });
    const nonce = randomHex(16);
    const expiresAt = input.now + LOGIN_WINDOW_MS;
    try {
      await db.call('auth_nonces', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ nonce, created_at: input.now, expires_at: expiresAt }) });
    } catch {
      return json(502, { error: 'database', message: 'Signing in is not available right now.' }, headers);
    }
    return json(200, { nonce, expiresAt }, headers);
  }

  if (op === 'login') {
    const message = typeof body.message === 'string' ? body.message : '';
    const signature = typeof body.signature === 'string' ? body.signature : '';
    if (!message || message.length > 1000 || !signature || signature.length > 400) return json(400, { error: 'bad-request' }, headers);
    // The site a message must name comes from the server's configuration, never from the request. A local development host is
    // accepted only off the production deployment, as the origin check does.
    const domains = loginDomains(input.env);
    if (input.env.VERCEL_ENV !== 'production') {
      const local = /^http:\/\/((?:localhost|127\.0\.0\.1)(?::\d+)?)$/.exec(input.origin ?? '')?.[1];
      if (local) domains.push(local);
    }
    const check = verifyLogin({ message, signature, domain: domains, now: input.now });
    if (!check.ok) return json(401, { error: 'sign-in', message: check.reason }, headers);
    try {
      // The nonce must be one this server issued, unexpired and unused; using it marks it used for this owner, in one statement,
      // so a second use of the same message (in any spelling of the signature, on any instance) is refused.
      const used = (await db.call(`auth_nonces?nonce=eq.${encodeURIComponent(check.nonce ?? '')}&used_at=is.null&expires_at=gt.${input.now}`, { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ used_at: input.now, owner: check.owner }) })) as unknown[] | null;
      if (!Array.isArray(used) || used.length !== 1) return json(401, { error: 'sign-in', message: 'That sign-in was already used or has expired. Try again.' }, headers);
      const version = await sessionVersion(db, check.owner);
      const session = issueSession(secret, check.owner, input.now, version);
      console.info(`sign-in ${check.owner}`);
      return json(200, { token: session.token, expiresAt: session.expiresAt, owner: check.owner, address: check.address }, headers);
    } catch {
      return json(502, { error: 'database', message: 'Signing in is not available right now.' }, headers);
    }
  }

  let owner: string | null;
  try {
    owner = await sessionOwner(secret, input.authorization, input.now, db);
  } catch {
    return json(502, { error: 'database', message: 'Your saved data could not be reached.' }, headers);
  }
  if (!owner) return json(401, { error: 'session', message: 'Sign in again to continue.' }, headers);
  const account = owner.slice(owner.indexOf(':') + 1);
  const q = encodeURIComponent(owner);

  try {
    if (op === 'sign-out-all') {
      // Every token carries the version it was issued under; raising it ends them all, this one included.
      const next = (await sessionVersion(db, owner)) + 1;
      await db.call('account_sessions?on_conflict=owner', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ owner, version: next, updated_at: input.now }) });
      return json(200, { ok: true }, headers);
    }
    if (op === 'get') {
      const [favs, trades] = await Promise.all([
        db.call(`user_favourites?owner=eq.${q}&select=chain,address,symbol,name,icon,added_at&order=added_at.desc&limit=${MAX_FAVOURITES}`) as Promise<Record<string, unknown>[]>,
        db.call(`user_trades?owner=eq.${q}&select=data&order=at.desc&limit=${MAX_TRADES}`) as Promise<{ data: unknown }[]>,
      ]);
      return json(200, { favourites: favs.map((f) => ({ chain: f.chain, address: f.address, symbol: f.symbol, name: f.name, icon: f.icon ?? null, addedAt: Number(f.added_at) })), trades: trades.map((t) => t.data) }, headers);
    }
    if (op === 'favourite') {
      const chain = typeof body.chain === 'string' && isChainId(body.chain) ? (body.chain as ChainId) : null;
      const ref = chain ? normalizeTokenRef(chain, typeof body.address === 'string' ? body.address : '') : null;
      if (!ref) return json(400, { error: 'bad-request' }, headers);
      const addrKey = encodeURIComponent(ref.address);
      if (body.on === false) {
        await db.call(`user_favourites?owner=eq.${q}&chain=eq.${ref.chain}&address=eq.${addrKey}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
        return json(200, { ok: true }, headers);
      }
      const count = (await db.call(`user_favourites?owner=eq.${q}&select=address&limit=${MAX_FAVOURITES + 1}`)) as unknown[];
      if (count.length >= MAX_FAVOURITES) return json(409, { error: 'limit', message: `You can keep up to ${MAX_FAVOURITES} favourites.` }, headers);
      const symbol = cleanText(body.symbol, 24);
      if (!symbol) return json(400, { error: 'bad-request' }, headers);
      await db.call('user_favourites?on_conflict=owner,chain,address', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ owner, chain: ref.chain, address: ref.address, symbol, name: cleanText(body.name, 64), icon: cleanLogo(body.icon), added_at: input.now }) });
      return json(200, { ok: true, name: CHAINS[ref.chain].name }, headers);
    }
    if (op === 'trades') {
      const items = Array.isArray(body.items) ? body.items.slice(0, MAX_TRADES) : [];
      const rows = items.map((i) => cleanTrade(i, account)).filter((t): t is NonNullable<typeof t> => t !== null).map((t) => ({ owner, id: t.id, at: t.at, data: t.data }));
      if (rows.length > 0) await db.call('user_trades?on_conflict=owner,id', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
      return json(200, { saved: rows.length, skipped: items.length - rows.length }, headers);
    }
    return json(400, { error: 'bad-request' }, headers);
  } catch (e) {
    const detail = e instanceof Error ? /answered (\d{3})/.exec(e.message)?.[1] ?? null : null;
    return json(502, { error: 'database', message: 'Your saved data could not be reached.', ...(detail ? { status: Number(detail) } : {}) }, headers);
  }
}
