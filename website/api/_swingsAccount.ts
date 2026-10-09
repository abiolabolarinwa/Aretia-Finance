/**
 * POST /api/swings-account: favourite tokens and swap history that follow a wallet address across devices.
 *
 *   { op: 'login', message, signature }   prove control of an address; answers with a session token
 *   { op: 'get' }                          the person's favourites and saved trades
 *   { op: 'favourite', chain, address, symbol, name, icon, on }   add or remove one favourite
 *   { op: 'trades', items: [...] }         save swap-history items (already-saved ones are kept as they are)
 *
 * Everything after login needs `Authorization: Bearer <session token>`, and only ever touches the rows of the address
 * the token was issued for. Nothing here can move funds, and no key or recovery phrase is ever sent: a signature over a
 * plain message is the only proof asked for. Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (the session key is derived
 * from the latter, so no extra setting is required); SWINGS_SESSION_SECRET may be set to use a separate secret.
 */
import { supabaseBase, supabaseHeaders } from '../src/swings/tokens/supabaseAuth.js';
import { isOriginAllowed, overLimit } from './_rpcProxy.js';
import { CHAINS, isChainId, type ChainId } from '../src/swings/core/types.js';
import { normalizeTokenRef } from '../src/swings/core/token.js';
import { cleanLogo, cleanText } from '../src/swings/tokens/registry.js';
import { issueSession, readSession, verifyLogin } from './_swingsAuth.js';
import type { TokensEnv } from './_swingsTokens.js';

export interface AccountInput {
  method: string;
  origin: string | null;
  authorization: string | null;
  ip: string;
  body: unknown;
  env: TokensEnv & { SWINGS_SESSION_SECRET?: string };
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
const usedNonces = new Map<string, number>();

export function resetAccountState(): void {
  usedNonces.clear();
}

const json = (status: number, data: unknown, headers: Record<string, string>): AccountOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

interface Rest {
  call(path: string, init?: RequestInit): Promise<unknown>;
}

function rest(url: string, key: string, fetchImpl: typeof fetch): Rest {
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
  return { id, at, data: { id, at, account: acct, chain, provider, fromSymbol, toSymbol, amountIn, expectedOut, txId, status } };
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
  const secret = input.env.SWINGS_SESSION_SECRET?.trim() || key;
  const body = obj(input.body);
  const op = body.op;
  const db = rest(url, key, input.fetchImpl);

  if (op === 'login') {
    const message = typeof body.message === 'string' ? body.message : '';
    const signature = typeof body.signature === 'string' ? body.signature : '';
    if (!message || message.length > 1000 || !signature || signature.length > 400) return json(400, { error: 'bad-request' }, headers);
    const domain = (() => {
      try {
        return new URL(input.origin ?? '').host;
      } catch {
        return '';
      }
    })();
    const check = verifyLogin({ message, signature, domain, now: input.now });
    if (!check.ok) return json(401, { error: 'sign-in', message: check.reason }, headers);
    // A signed message works once: a second use of the same message is refused.
    const nonceKey = `${check.owner}|${signature.slice(0, 40)}`;
    if (usedNonces.has(nonceKey)) return json(401, { error: 'sign-in', message: 'That sign-in was already used. Try again.' }, headers);
    if (usedNonces.size > 5000) usedNonces.clear();
    usedNonces.set(nonceKey, input.now);
    const session = issueSession(secret, check.owner, input.now);
    return json(200, { token: session.token, expiresAt: session.expiresAt, owner: check.owner, address: check.address }, headers);
  }

  const bearer = input.authorization?.startsWith('Bearer ') ? input.authorization.slice(7).trim() : null;
  const owner = readSession(secret, bearer, input.now);
  if (!owner) return json(401, { error: 'session', message: 'Sign in again to continue.' }, headers);
  const account = owner.slice(owner.indexOf(':') + 1);
  const q = encodeURIComponent(owner);

  try {
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
