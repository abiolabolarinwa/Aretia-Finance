/**
 * POST /api/game: Ultimate City Search, milestone 2 (sign-in and the player's identity).
 *
 *   { op: 'nonce' }                       a single-use value for the sign-in message (valid five minutes)
 *   { op: 'login', message, signature }  prove control of a wallet; answers with a game session and the player's profile
 *   { op: 'me' }                          the signed-in player's profile
 *   { op: 'logout' }                      record the sign-out
 *   { op: 'sign-out-all' }                end every game session of this wallet, on every device
 *
 * The game is separate from the wallet and from ACT. A game sign-in message says so and is refused by the wallet endpoint (and the
 * reverse), and a game token (kind "g1") is refused everywhere else. Signing is free and cannot move funds. Nothing here touches a
 * token, a fee or a transaction. The wallet is how a player proves who they are; the permanent key is the internal player id.
 * Needs the same database and migrations 0014 and 0023.
 */
import { supabaseBase } from '../src/swings/tokens/supabaseAuth.js';
import { isOriginAllowed, overLimit } from './_rpcProxy.js';
import { LOGIN_WINDOW_MS } from '../src/swings/account/loginMessage.js';
import { loginDomains, openToken, SESSION_MS, sessionSecret, sessionVersion, signToken, verifyLogin } from './_swingsAuth.js';
import { rest, type Rest } from './_swingsAccount.js';
import { overBudget } from './_limits.js';
import type { TokensEnv } from './_swingsTokens.js';

export interface GameInput {
  method: string;
  origin: string | null;
  authorization: string | null;
  ip: string;
  body: unknown;
  env: TokensEnv & { SWINGS_SESSION_SECRET?: string; SWINGS_LOGIN_DOMAINS?: string; VERCEL_ENV?: string };
  fetchImpl: typeof fetch;
  now: number;
}
export interface GameOutput {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const NONCES_PER_MINUTE = 20;
const TOKEN_KIND = 'g1';

const randomHex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const json = (status: number, data: unknown, headers: Record<string, string>): GameOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The wallet identity: network plus the normalised address, so an EVM and a Solana address can never be mistaken for each other. */
export function walletIdentity(family: 'evm' | 'solana', address: string): { network: 'evm' | 'solana'; addressNorm: string; owner: string } {
  const addressNorm = family === 'evm' ? address.toLowerCase() : address;
  return { network: family, addressNorm, owner: `${family}:${addressNorm}` };
}

/** The key the game's session version is kept under, apart from the wallet's own sessions. */
const versionKey = (owner: string): string => `game:${owner}`;

export interface GameClaims {
  playerId: string;
  owner: string;
  version: number;
}

export function issueGameSession(secret: string, playerId: string, owner: string, now: number, version: number): { token: string; expiresAt: number } {
  const expiresAt = now + SESSION_MS;
  return { token: signToken(secret, TOKEN_KIND, { p: playerId, o: owner, e: expiresAt, v: version }), expiresAt };
}

export function readGameSession(secret: string, authorization: string | null, now: number): GameClaims | null {
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
  if (!bearer) return null;
  const p = openToken(secret, TOKEN_KIND, bearer);
  if (!p || typeof p.p !== 'string' || typeof p.o !== 'string' || typeof p.e !== 'number' || p.e <= now) return null;
  const version = typeof p.v === 'number' && Number.isInteger(p.v) && p.v >= 0 ? p.v : -1;
  return version < 0 || !/^[0-9a-f-]{36}$/.test(p.p) ? null : { playerId: p.p, owner: p.o, version };
}

interface WalletRow { player_id: string }
interface ProfileRow { display_name: string; avatar: string | null; explorer_level: number; total_xp: number; total_discoveries: number; missions_completed: number }

async function findPlayer(db: Rest, network: string, addressNorm: string): Promise<string | null> {
  const rows = (await db.call(`game_player_wallets?network=eq.${network}&address_norm=eq.${encodeURIComponent(addressNorm)}&select=player_id&limit=1`)) as WalletRow[] | null;
  return Array.isArray(rows) && rows[0] ? rows[0].player_id : null;
}

/** The player behind a wallet: the existing one, or a new one. A second wallet never joins an existing player here (no automatic merging). */
async function playerFor(db: Rest, network: 'evm' | 'solana', addressNorm: string, now: number): Promise<{ id: string; created: boolean }> {
  const existing = await findPlayer(db, network, addressNorm);
  if (existing) return { id: existing, created: false };
  const made = (await db.call('game_players', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ created_at: now }) })) as { id: string }[];
  const id = made[0]!.id;
  try {
    await db.call('game_player_wallets', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ player_id: id, network, address_norm: addressNorm, verified_at: now, is_primary: true }) });
  } catch (e) {
    // Another sign-in of the same wallet won the race (unique network + address). Use that player and drop the unused one.
    const winner = await findPlayer(db, network, addressNorm);
    await db.call(`game_players?id=eq.${id}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } }).catch(() => undefined);
    if (winner) return { id: winner, created: false };
    throw e;
  }
  await db.call('game_player_profiles', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ player_id: id }) });
  return { id, created: true };
}

async function logActivity(db: Rest, playerId: string, network: string, addressNorm: string, type: string, now: number, metadata: Record<string, unknown> = {}): Promise<void> {
  await db.call('game_player_activities', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ player_id: playerId, wallet_address: addressNorm, network, activity_type: type, metadata, created_at: now }) });
}

async function profileOf(db: Rest, playerId: string): Promise<Record<string, unknown>> {
  const rows = (await db.call(`game_player_profiles?player_id=eq.${playerId}&select=display_name,avatar,explorer_level,total_xp,total_discoveries,missions_completed&limit=1`)) as ProfileRow[] | null;
  const p = rows?.[0];
  return { playerId, displayName: p?.display_name ?? '', avatar: p?.avatar ?? null, explorerLevel: p?.explorer_level ?? 1, totalXp: Number(p?.total_xp ?? 0), totalDiscoveries: p?.total_discoveries ?? 0, missionsCompleted: p?.missions_completed ?? 0 };
}

export async function handleGame(input: GameInput): Promise<GameOutput> {
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
  if (!url || !key) return json(503, { error: 'not-configured', message: 'The game is not set up on this server yet.' }, headers);
  if (overLimit(`game:${input.ip}`, input.now)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '60' });
  const secret = sessionSecret(input.env) ?? key;
  const body = obj(input.body);
  const op = body.op;
  const db = rest(url, key, input.fetchImpl);

  if (op === 'nonce') {
    if (overBudget(`gamenonce:${input.ip}`, input.now, NONCES_PER_MINUTE)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '60' });
    const nonce = randomHex(16);
    try {
      await db.call('auth_nonces', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ nonce, created_at: input.now, expires_at: input.now + LOGIN_WINDOW_MS }) });
    } catch {
      return json(502, { error: 'database', message: 'Signing in is not available right now.' }, headers);
    }
    return json(200, { nonce, expiresAt: input.now + LOGIN_WINDOW_MS }, headers);
  }

  if (op === 'login') {
    const message = typeof body.message === 'string' ? body.message : '';
    const signature = typeof body.signature === 'string' ? body.signature : '';
    if (!message || message.length > 1000 || !signature || signature.length > 400) return json(400, { error: 'bad-request' }, headers);
    const domains = loginDomains(input.env);
    if (input.env.VERCEL_ENV !== 'production') {
      const local = /^http:\/\/((?:localhost|127\.0\.0\.1)(?::\d+)?)$/.exec(input.origin ?? '')?.[1];
      if (local) domains.push(local);
    }
    const check = verifyLogin({ message, signature, domain: domains, now: input.now, purpose: 'game' });
    if (!check.ok) return json(401, { error: 'sign-in', message: check.reason }, headers);
    const id = walletIdentity(check.family, check.address);
    try {
      const used = (await db.call(`auth_nonces?nonce=eq.${encodeURIComponent(check.nonce ?? '')}&used_at=is.null&expires_at=gt.${input.now}`, { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ used_at: input.now, owner: id.owner }) })) as unknown[] | null;
      if (!Array.isArray(used) || used.length !== 1) return json(401, { error: 'sign-in', message: 'That sign-in was already used or has expired. Try again.' }, headers);
      const player = await playerFor(db, id.network, id.addressNorm, input.now);
      await db.call(`game_player_profiles?player_id=eq.${player.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ last_login_at: input.now }) });
      if (player.created) await logActivity(db, player.id, id.network, id.addressNorm, 'wallet_connected', input.now, { first: true });
      await logActivity(db, player.id, id.network, id.addressNorm, 'login', input.now);
      const version = await sessionVersion(db, versionKey(id.owner));
      const session = issueGameSession(secret, player.id, id.owner, input.now, version);
      return json(200, { token: session.token, expiresAt: session.expiresAt, network: id.network, address: check.address, profile: await profileOf(db, player.id), created: player.created }, headers);
    } catch {
      return json(502, { error: 'database', message: 'Signing in is not available right now.' }, headers);
    }
  }

  const claims = readGameSession(secret, input.authorization, input.now);
  if (!claims) return json(401, { error: 'session', message: 'Sign in again to continue.' }, headers);
  const network: 'evm' | 'solana' = claims.owner.startsWith('evm:') ? 'evm' : 'solana';
  const addressNorm = claims.owner.slice(claims.owner.indexOf(':') + 1);
  try {
    // A session ends when the player signs out everywhere: the token's version is older than the stored one.
    if (claims.version < (await sessionVersion(db, versionKey(claims.owner)))) return json(401, { error: 'session', message: 'Sign in again to continue.' }, headers);
    if (op === 'me') return json(200, { profile: await profileOf(db, claims.playerId), network, address: addressNorm }, headers);
    if (op === 'logout') {
      await logActivity(db, claims.playerId, network, addressNorm, 'logout', input.now);
      return json(200, { ok: true }, headers);
    }
    if (op === 'sign-out-all') {
      const next = (await sessionVersion(db, versionKey(claims.owner))) + 1;
      await db.call('account_sessions?on_conflict=owner', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ owner: versionKey(claims.owner), version: next, updated_at: input.now }) });
      await logActivity(db, claims.playerId, network, addressNorm, 'logout', input.now, { everywhere: true });
      return json(200, { ok: true }, headers);
    }
    return json(400, { error: 'bad-request' }, headers);
  } catch {
    return json(502, { error: 'database', message: 'The game could not be reached.' }, headers);
  }
}
