/**
 * Free token profiles, the server side (docs/token-profiles.md; the rules are in src/swings/profiles/core.ts).
 *
 *   GET  /api/swings-profiles?chain=<chain>&address=<a>     (public, cached) the live profile of a token, or null
 *   POST /api/swings-profiles { op: 'check', chain, address }        (wallet sign-in) whether this wallet controls the token, and what is there
 *        { op: 'submit', chain, address, profile, txHash? }           (wallet sign-in) publish (controller) or send for review (anyone else)
 *        { op: 'admin-list' | 'admin-approve' | 'admin-reject' | 'admin-remove' | 'admin-unblock', ... }   (owner only; 404 for anyone else)
 *
 * Control of a token is read from the chain here, never taken from the browser. Nothing in this file charges, ranks or sorts anything.
 */
import { supabaseBase } from '../src/swings/tokens/supabaseAuth.js';
import { isOriginAllowed, overLimit } from './_rpcProxy.js';
import { sessionOwner, sessionSecret } from './_swingsAuth.js';
import { rest, type Rest } from './_swingsAccount.js';
import { overBudget } from './_limits.js';
import { authenticateAdmin, type AdminEnv } from './_adminStats.js';
import { creationMatches, type UploadEnv } from './_swingsUpload.js';
import { EVM_FACTORIES, type EvmLaunchChain } from '../src/swings/launchbox/core.js';
import { PUBLIC_EVM_RPC } from '../src/swings/chains/evmSession.js';
import { METADATA_PROGRAM, TOKEN_2022_PROGRAM, metadataAddress, parseMetadata, parseToken2022Metadata } from '../src/swings/mi/solana/accounts.js';
import {
  evmAbiString,
  evmAddressWord,
  impersonationProblem,
  LAUNCHPAD_AUTHORITIES,
  metaplexUpdateAuthority,
  ownershipDecision,
  profileAddress,
  publicProfile,
  solanaMintAuthority,
  token2022UpdateAuthority,
  validateProfile,
  type PublicProfile,
} from '../src/swings/profiles/core.js';
import type { ChainId } from '../src/swings/core/types.js';

export type ProfilesEnv = UploadEnv & AdminEnv;

/** What the chain says about a token: who controls it, and what it calls itself. `exists` false when no such token was found. */
export interface TokenFacts {
  exists: boolean;
  controllers: string[];
  name: string | null;
  symbol: string | null;
}

export interface ProfilesInput {
  method: string;
  origin: string | null;
  authorization: string | null;
  ip: string;
  query: Record<string, string | undefined>;
  body: unknown;
  env: ProfilesEnv;
  fetchImpl: typeof fetch;
  now: number;
  /** For tests: replaces the chain read. */
  readFacts?: (chain: ChainId, address: string) => Promise<TokenFacts>;
}
export interface ProfilesOutput {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const HOUR = 3_600_000;
/** Submissions one wallet may make per hour, and from one IP; requests one wallet may have waiting at once. */
export const PROFILE_BUDGET = { perOwnerPerHour: 10, perIpPerHour: 30, pendingPerOwner: 10 } as const;
const PUBLIC_COLUMNS = 'chain,address,description,website,x,telegram,discord,logo,proof,updated_at';
const CACHE_MS = 60_000;

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const json = (status: number, data: unknown, headers: Record<string, string>): ProfilesOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });
const enc = encodeURIComponent;

const cache = new Map<string, { at: number; profile: PublicProfile | null }>();
export function resetProfileState(): void {
  cache.clear();
}

function database(env: ProfilesEnv): { base: string; key: string } | null {
  const base = supabaseBase(env.SUPABASE_URL);
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return base && key ? { base, key } : null;
}

// ---------------------------------------------------------------- reading the chain

const EVM_ENV: Readonly<Record<Exclude<ChainId, 'solana'>, keyof ProfilesEnv>> = { ethereum: 'EVM_RPC_ETHEREUM', bnb: 'EVM_RPC_BNB', polygon: 'EVM_RPC_POLYGON', base: 'EVM_RPC_BASE', robinhood: 'EVM_RPC_ROBINHOOD' };

async function rpc(fetchImpl: typeof fetch, url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!res.ok) throw new Error(`RPC answered ${res.status}`);
  const out = obj(await res.json());
  // A reverted eth_call (no owner() function) is an answer, not a failure: it means "none".
  return out.error !== undefined ? null : out.result;
}

const b64 = (s: unknown): Uint8Array | null => (typeof s === 'string' ? Uint8Array.from(Buffer.from(s, 'base64')) : null);

/** Who controls a token, read from the chain. Throws when the chain cannot be read (the caller answers "try again"). */
export async function readTokenFacts(chain: ChainId, address: string, env: ProfilesEnv, fetchImpl: typeof fetch): Promise<TokenFacts> {
  if (chain === 'solana') {
    const url = env.SOLANA_RPC_URL?.trim() || 'https://solana-rpc.publicnode.com';
    const meta = metadataAddress(address);
    const value = obj(await rpc(fetchImpl, url, 'getMultipleAccounts', [[address, ...(meta ? [meta] : [])], { encoding: 'base64' }])).value;
    if (!Array.isArray(value)) throw new Error('unreadable');
    const mint = obj(value[0]);
    const mintData = b64(Array.isArray(mint.data) ? mint.data[0] : null);
    if (!mintData) return { exists: false, controllers: [], name: null, symbol: null };
    const controllers: string[] = [];
    const add = (k: string | null): void => void (k && !LAUNCHPAD_AUTHORITIES.has(k) && !controllers.includes(k) && controllers.push(k));
    add(solanaMintAuthority(mintData));
    let name: string | null = null;
    let symbol: string | null = null;
    if (mint.owner === TOKEN_2022_PROGRAM) {
      add(token2022UpdateAuthority(mintData));
      const m = parseToken2022Metadata(mintData);
      if (m) ({ name, symbol } = m);
    }
    const metaAcc = obj(value[1]);
    const metaData = metaAcc.owner === METADATA_PROGRAM ? b64(Array.isArray(metaAcc.data) ? metaAcc.data[0] : null) : null;
    if (metaData) {
      add(metaplexUpdateAuthority(metaData));
      const m = parseMetadata(metaData);
      if (m && m.mint === address) ({ name, symbol } = m);
    }
    return { exists: true, controllers, name, symbol };
  }
  const url = (env[EVM_ENV[chain]] as string | undefined)?.trim() || PUBLIC_EVM_RPC[chain];
  const call = (data: string): Promise<unknown> => rpc(fetchImpl, url, 'eth_call', [{ to: address, data }, 'latest']);
  const [code, owner, getOwner, name, symbol] = await Promise.all([
    rpc(fetchImpl, url, 'eth_getCode', [address, 'latest']),
    call('0x8da5cb5b'), // owner()
    call('0x893d20e8'), // getOwner() (BEP-20)
    call('0x06fdde03'), // name()
    call('0x95d89b41'), // symbol()
  ]);
  if (typeof code !== 'string' || code === '0x') return { exists: false, controllers: [], name: null, symbol: null };
  const controllers = [...new Set([evmAddressWord(owner), evmAddressWord(getOwner)].filter((a): a is string => a !== null))];
  return { exists: true, controllers, name: evmAbiString(name), symbol: evmAbiString(symbol) };
}

// ---------------------------------------------------------------- public read

async function readLive(db: Rest, chain: ChainId, address: string): Promise<PublicProfile | null> {
  const rows = (await db.call(`token_profiles?chain=eq.${enc(chain)}&address=eq.${enc(address)}&status=eq.live&select=${PUBLIC_COLUMNS}&limit=1`)) as unknown[] | null;
  return Array.isArray(rows) && rows.length > 0 ? publicProfile(rows[0]) : null;
}

async function handleGet(input: ProfilesInput, headers: Record<string, string>): Promise<ProfilesOutput> {
  if (overLimit(`profile:${input.ip}`, input.now)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '30' });
  const where = profileAddress(input.query.chain, input.query.address);
  if (!where) return json(400, { error: 'bad-request' }, headers);
  const cached = { ...headers, 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' };
  const key = `${where.chain}:${where.address}`;
  const hit = cache.get(key);
  if (hit && input.now - hit.at < CACHE_MS) return json(200, { profile: hit.profile }, cached);
  const d = database(input.env);
  if (!d) return json(200, { profile: null, setup: 'not-configured' }, headers);
  try {
    const profile = await readLive(rest(d.base, d.key, input.fetchImpl), where.chain, where.address);
    if (cache.size > 5000) cache.clear();
    cache.set(key, { at: input.now, profile });
    return json(200, { profile }, cached);
  } catch {
    return json(502, { error: 'database' }, headers);
  }
}

// ---------------------------------------------------------------- the creator's side

async function blocked(db: Rest, chain: ChainId, address: string): Promise<boolean> {
  const rows = (await db.call(`token_profile_blocks?chain=eq.${enc(chain)}&address=eq.${enc(address)}&select=chain&limit=1`)) as unknown[] | null;
  return Array.isArray(rows) && rows.length > 0;
}

async function ownPending(db: Rest, chain: ChainId, address: string, owner: string): Promise<{ id: number } | null> {
  const rows = (await db.call(`token_profiles?chain=eq.${enc(chain)}&address=eq.${enc(address)}&submitted_by=eq.${enc(owner)}&status=eq.pending&select=id,description,website,x,telegram,discord,logo,created_at&limit=1`)) as Record<string, unknown>[] | null;
  return Array.isArray(rows) && rows[0] ? (rows[0] as { id: number }) : null;
}

/** The token's facts, with the wallet that created it through Aretia Launch added as a controller when the creation transaction shows it. */
async function factsFor(input: ProfilesInput, chain: ChainId, address: string, owner: string): Promise<TokenFacts> {
  const facts = await (input.readFacts ?? ((c, a) => readTokenFacts(c, a, input.env, input.fetchImpl)))(chain, address);
  const body = obj(input.body);
  const txHash = typeof body.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(body.txHash) ? body.txHash : null;
  if (txHash && owner.startsWith('evm:') && chain in EVM_FACTORIES) {
    const creator = owner.slice(4);
    if (await creationMatches({ chain: chain as EvmLaunchChain, token: address, creator, txHash, env: input.env, fetchImpl: input.fetchImpl })) facts.controllers.push(creator);
  }
  return facts;
}

async function handleUser(input: ProfilesInput, headers: Record<string, string>): Promise<ProfilesOutput> {
  const body = obj(input.body);
  const d = database(input.env);
  const secret = sessionSecret(input.env) ?? d?.key;
  if (!d || !secret) return json(503, { error: 'not-configured', message: 'Token profiles are not set up yet.' }, headers);
  const db = rest(d.base, d.key, input.fetchImpl);
  let owner: string | null;
  try {
    owner = await sessionOwner(secret, input.authorization, input.now, db);
  } catch {
    return json(502, { error: 'database', message: 'Your sign-in could not be checked right now.' }, headers);
  }
  if (!owner) return json(401, { error: 'session', message: 'Sign in again to continue.' }, headers);
  const where = profileAddress(body.chain, body.address);
  if (!where) return json(400, { error: 'bad-request', message: 'That is not a token address on that network.' }, headers);
  const { chain, address } = where;

  if (body.op === 'check') {
    try {
      const [facts, isBlocked, live, pending] = await Promise.all([factsFor(input, chain, address, owner), blocked(db, chain, address), readLive(db, chain, address), ownPending(db, chain, address, owner)]);
      return json(200, { exists: facts.exists, controls: ownershipDecision(chain, owner, facts.controllers), hasController: facts.controllers.length > 0, blocked: isBlocked, live, pending }, headers);
    } catch {
      return json(502, { error: 'chain', message: 'The token could not be read right now. Try again in a minute.' }, headers);
    }
  }

  // op === 'submit'
  const check = validateProfile(body.profile);
  if (!check.ok) return json(400, { error: 'refused', issues: check.issues, message: check.issues[0]!.message }, headers);
  if (overBudget(`profile-owner:${owner}`, input.now, PROFILE_BUDGET.perOwnerPerHour, HOUR) || overBudget(`profile-ip:${input.ip}`, input.now, PROFILE_BUDGET.perIpPerHour, HOUR))
    return json(429, { error: 'rate-limit', message: 'Too many profile changes from this wallet. Try again later.' }, { ...headers, 'retry-after': '600' });

  let facts: TokenFacts;
  try {
    if (await blocked(db, chain, address)) return json(403, { error: 'blocked', message: 'Aretia removed this token’s profile. It cannot have a new one for now.' }, headers);
    facts = await factsFor(input, chain, address, owner);
  } catch {
    return json(502, { error: 'chain', message: 'The token could not be read right now. Try again in a minute.' }, headers);
  }
  if (!facts.exists) return json(404, { error: 'no-token', message: 'No token was found at that address on that network.' }, headers);
  const fake = impersonationProblem(chain, address, facts.symbol, facts.name);
  if (fake) return json(403, { error: 'impersonation', message: fake }, headers);
  const decision = ownershipDecision(chain, owner, facts.controllers);
  if (decision === 'wrong-family') return json(400, { error: 'wrong-wallet', message: chain === 'solana' ? 'Sign in with a Solana wallet for a Solana token.' : 'Sign in with an Ethereum-style wallet for this token.' }, headers);

  const v = check.value;
  const fields = { description: v.description, website: v.website || null, x: v.x || null, telegram: v.telegram || null, discord: v.discord || null, logo: v.logo || null };
  const write = { 'content-type': 'application/json', prefer: 'return=minimal' };
  try {
    const mine = await ownPending(db, chain, address, owner);
    if (decision === 'authority') {
      // The controller's version replaces what is live, and any request of theirs that was waiting.
      await db.call(`token_profiles?chain=eq.${enc(chain)}&address=eq.${enc(address)}&status=eq.live`, { method: 'PATCH', headers: write, body: JSON.stringify({ status: 'rejected', note: 'replaced', updated_at: input.now }) });
      if (mine) await db.call(`token_profiles?id=eq.${mine.id}`, { method: 'PATCH', headers: write, body: JSON.stringify({ status: 'rejected', note: 'replaced', updated_at: input.now }) });
      await db.call('token_profiles', { method: 'POST', headers: write, body: JSON.stringify({ chain, address, status: 'live', proof: 'authority', submitted_by: owner, ...fields, created_at: input.now, updated_at: input.now }) });
      cache.delete(`${chain}:${address}`);
      return json(200, { status: 'live', message: 'Published. It shows on the token page now.' }, headers);
    }
    if (mine) {
      await db.call(`token_profiles?id=eq.${mine.id}`, { method: 'PATCH', headers: write, body: JSON.stringify({ ...fields, updated_at: input.now }) });
    } else {
      const waiting = (await db.call(`token_profiles?submitted_by=eq.${enc(owner)}&status=eq.pending&select=id&limit=${PROFILE_BUDGET.pendingPerOwner}`)) as unknown[] | null;
      if (Array.isArray(waiting) && waiting.length >= PROFILE_BUDGET.pendingPerOwner) return json(429, { error: 'too-many-pending', message: 'This wallet already has requests waiting. Wait for them to be reviewed.' }, headers);
      await db.call('token_profiles', { method: 'POST', headers: write, body: JSON.stringify({ chain, address, status: 'pending', proof: 'review', submitted_by: owner, ...fields, created_at: input.now, updated_at: input.now }) });
    }
    return json(200, { status: 'pending', message: 'Sent for review. It shows on the token page once Aretia approves it.' }, headers);
  } catch {
    return json(502, { error: 'database', message: 'The profile could not be saved right now. Try again.' }, headers);
  }
}

// ---------------------------------------------------------------- the owner's side

const ADMIN_COLUMNS = 'id,chain,address,status,proof,submitted_by,description,website,x,telegram,discord,logo,created_at,updated_at,reviewed_by,reviewed_at,note';
const note = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);

async function handleAdminOp(input: ProfilesInput, headers: Record<string, string>): Promise<ProfilesOutput> {
  const auth = await authenticateAdmin(input);
  // Every refusal is the same 404 as an unknown path, like the rest of the owner's routes.
  if (!auth) return { status: 404, body: '{"error":"not-found"}', headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } };
  const { db, owner } = auth;
  const body = obj(input.body);
  const write = { 'content-type': 'application/json', prefer: 'return=minimal' };
  const id = typeof body.id === 'number' && Number.isSafeInteger(body.id) && body.id > 0 ? body.id : null;
  try {
    if (body.op === 'admin-list') {
      const [pending, live, blocks] = await Promise.all([
        db.call(`token_profiles?status=eq.pending&select=${ADMIN_COLUMNS}&order=created_at.asc&limit=200`),
        db.call(`token_profiles?status=eq.live&select=${ADMIN_COLUMNS}&order=updated_at.desc&limit=200`),
        db.call('token_profile_blocks?select=chain,address,blocked_at,blocked_by,reason&order=blocked_at.desc&limit=200'),
      ]);
      return json(200, { pending, live, blocks }, headers);
    }
    if (body.op === 'admin-approve' || body.op === 'admin-reject') {
      if (!id) return json(400, { error: 'bad-request' }, headers);
      const rows = (await db.call(`token_profiles?id=eq.${id}&status=eq.pending&select=chain,address&limit=1`)) as { chain: ChainId; address: string }[] | null;
      const row = Array.isArray(rows) ? rows[0] : undefined;
      if (!row) return json(404, { error: 'gone', message: 'That request is no longer waiting.' }, headers);
      if (body.op === 'admin-reject') {
        await db.call(`token_profiles?id=eq.${id}`, { method: 'PATCH', headers: write, body: JSON.stringify({ status: 'rejected', reviewed_by: owner, reviewed_at: input.now, updated_at: input.now, note: note(body.note) ?? 'rejected' }) });
        return json(200, { ok: true }, headers);
      }
      if (await blocked(db, row.chain, row.address)) return json(409, { error: 'blocked', message: 'This token is blocked. Allow it again first.' }, headers);
      await db.call(`token_profiles?chain=eq.${enc(row.chain)}&address=eq.${enc(row.address)}&status=eq.live`, { method: 'PATCH', headers: write, body: JSON.stringify({ status: 'rejected', note: 'replaced', updated_at: input.now }) });
      await db.call(`token_profiles?id=eq.${id}`, { method: 'PATCH', headers: write, body: JSON.stringify({ status: 'live', proof: 'review', reviewed_by: owner, reviewed_at: input.now, updated_at: input.now }) });
      cache.delete(`${row.chain}:${row.address}`);
      return json(200, { ok: true }, headers);
    }
    const where = profileAddress(body.chain, body.address);
    if (!where) return json(400, { error: 'bad-request' }, headers);
    if (body.op === 'admin-remove') {
      // Takes the live profile and every waiting request down, and blocks the token until the owner allows it again.
      await db.call(`token_profiles?chain=eq.${enc(where.chain)}&address=eq.${enc(where.address)}&status=in.(live,pending)`, { method: 'PATCH', headers: write, body: JSON.stringify({ status: 'rejected', reviewed_by: owner, reviewed_at: input.now, updated_at: input.now, note: 'removed' }) });
      await db.call('token_profile_blocks?on_conflict=chain,address', { method: 'POST', headers: { ...write, prefer: 'return=minimal,resolution=merge-duplicates' }, body: JSON.stringify({ chain: where.chain, address: where.address, blocked_at: input.now, blocked_by: owner, reason: note(body.reason) }) });
      cache.delete(`${where.chain}:${where.address}`);
      return json(200, { ok: true }, headers);
    }
    if (body.op === 'admin-unblock') {
      await db.call(`token_profile_blocks?chain=eq.${enc(where.chain)}&address=eq.${enc(where.address)}`, { method: 'DELETE', headers: write });
      return json(200, { ok: true }, headers);
    }
    return json(400, { error: 'bad-request' }, headers);
  } catch {
    return json(502, { error: 'database', message: 'The profiles could not be reached right now.' }, headers);
  }
}

// ---------------------------------------------------------------- entry

export async function handleProfiles(input: ProfilesInput): Promise<ProfilesOutput> {
  const headers: Record<string, string> = { vary: 'origin', 'cache-control': 'no-store' };
  if (input.method === 'GET') return handleGet(input, headers);
  const allowed = isOriginAllowed(input.origin, input.env);
  if (allowed) {
    headers['access-control-allow-origin'] = input.origin!;
    headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
    headers['access-control-allow-headers'] = 'content-type, authorization';
  }
  if (input.method === 'OPTIONS') return { status: allowed ? 204 : 403, body: '', headers };
  if (input.method !== 'POST') return json(405, { error: 'method' }, { ...headers, allow: 'GET, POST, OPTIONS' });
  const op = obj(input.body).op;
  if (typeof op === 'string' && op.startsWith('admin-')) return handleAdminOp(input, headers);
  if (!allowed) return json(403, { error: 'origin' }, headers);
  if (overLimit(`profile:${input.ip}`, input.now)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '60' });
  if (op !== 'check' && op !== 'submit') return json(400, { error: 'bad-request' }, headers);
  return handleUser(input, headers);
}
