/**
 * Token pictures and details, the server side (docs/LAUNCH_ASSETS.md).
 *
 *   POST /api/swings-upload  { op: 'status' }                  (no sign-in) whether uploads are set up
 *                            { op: 'sign', kind, ... }          (needs the wallet sign-in session) a one-use upload link for ONE file
 *   GET  /api/swings-meta?chain=<chain>&address=<a,b,...>       (public, cached) the picture, description and links of tokens
 *
 * The file itself never passes through here: the browser sends it straight to a PUBLIC Supabase Storage bucket, using a signed
 * upload link this file asks Supabase for with the service key. The key stays on the server; the browser only ever gets a link for one
 * path. What may be uploaded (type, size, name) is decided by planUpload in src/swings/launchmeta/core.ts. A picture and a Solana
 * details file are named by the SHA-256 of their bytes and are never overwritten. An Ethereum-style token's details file is keyed by
 * the token's address, and is accepted only from the wallet that created the token: the creation transaction is read back from the chain
 * and must contain the factory's TokenCreated log naming that token and that wallet.
 *
 * Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and a public bucket (LAUNCH_ASSETS_BUCKET, default "launch-assets"). Without them
 * 'status' answers { enabled: false } and the Launch page says image upload is not set up yet; nothing else changes.
 */
import { supabaseBase, supabaseHeaders } from '../src/swings/tokens/supabaseAuth.js';
import { isOriginAllowed, overLimit } from './_rpcProxy.js';
import { sessionOwner, sessionSecret } from './_swingsAuth.js';
import { rest } from './_swingsAccount.js';
import { overBudget } from './_limits.js';
import { EVM_FACTORIES, TOKEN_CREATED_TOPIC, type EvmLaunchChain } from '../src/swings/launchbox/core.js';
import { PUBLIC_EVM_RPC } from '../src/swings/launchbox/indexer.js';
import { EVM_META_CHAINS, JSON_MAX_BYTES, UPLOAD_LIMITS, hasMeta, parseMetadataJson, planUpload, publicUrl, type TokenMeta } from '../src/swings/launchmeta/core.js';
import type { TokensEnv } from './_swingsTokens.js';

export interface UploadEnv extends TokensEnv {
  LAUNCH_ASSETS_BUCKET?: string;
  SWINGS_SESSION_SECRET?: string;
}
export interface UploadInput {
  method: string;
  origin: string | null;
  authorization: string | null;
  ip: string;
  query: Record<string, string | undefined>;
  body: unknown;
  env: UploadEnv;
  fetchImpl: typeof fetch;
  now: number;
}
export interface UploadOutput {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const NOT_SET_UP = 'Image upload is not set up yet';
const HOUR = 3_600_000;
const STATUS_TTL_MS = 5 * 60_000;
const META_TTL_MS = 5 * 60_000;
const META_MISS_TTL_MS = 60_000;
const MAX_ADDRESSES = 20;

const json = (status: number, data: unknown, headers: Record<string, string>): UploadOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

let statusCache: { key: string; at: number; ok: boolean } | null = null;
const metaCache = new Map<string, { at: number; meta: TokenMeta | null }>();
export function resetUploadState(): void {
  statusCache = null;
  metaCache.clear();
}

export const bucketOf = (env: UploadEnv): string => {
  const b = (env.LAUNCH_ASSETS_BUCKET ?? '').trim();
  return /^[a-z0-9][a-z0-9_-]{1,62}$/.test(b) ? b : 'launch-assets';
};

function config(env: UploadEnv): { base: string; key: string; bucket: string } | null {
  const base = supabaseBase(env.SUPABASE_URL);
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return base && key ? { base, key, bucket: bucketOf(env) } : null;
}

/** True when the bucket exists and is public, asked of Supabase at most every five minutes. */
async function bucketReady(c: { base: string; key: string; bucket: string }, fetchImpl: typeof fetch, now: number): Promise<boolean> {
  const id = `${c.base}|${c.bucket}`;
  if (statusCache && statusCache.key === id && now - statusCache.at < STATUS_TTL_MS) return statusCache.ok;
  const ok = await fetchImpl(`${c.base}/storage/v1/bucket/${encodeURIComponent(c.bucket)}`, { headers: supabaseHeaders(c.key) })
    .then(async (res) => res.ok && obj(await res.json().catch(() => null)).public === true)
    .catch(() => false);
  statusCache = { key: id, at: now, ok };
  return ok;
}

// ---------------------------------------------------------------- Ethereum-style creation check

const hexWord = (a: string): string => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

/** True when `txHash` is a successful creation by `creator` of exactly `token`, emitted by Aretia's factory on `chain`. Read from a node, never taken from the browser. */
export async function creationMatches(args: { chain: EvmLaunchChain; token: string; creator: string; txHash: string; env: UploadEnv; fetchImpl: typeof fetch }): Promise<boolean> {
  const rpc = (args.chain === 'bnb' ? args.env.EVM_RPC_BNB : args.chain === 'ethereum' ? args.env.EVM_RPC_ETHEREUM : args.env.EVM_RPC_POLYGON)?.trim() || PUBLIC_EVM_RPC[args.chain];
  const res = await args.fetchImpl(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [args.txHash] }) });
  if (!res.ok) return false;
  const receipt = obj(obj(await res.json().catch(() => null)).result);
  if (receipt.status !== '0x1' || !Array.isArray(receipt.logs)) return false;
  for (const raw of receipt.logs) {
    const log = obj(raw);
    const topics = Array.isArray(log.topics) ? log.topics.map((t) => String(t).toLowerCase()) : [];
    if (typeof log.address === 'string' && log.address.toLowerCase() === EVM_FACTORIES[args.chain] && topics.length === 3 && topics[0] === TOKEN_CREATED_TOPIC && topics[1] === hexWord(args.token) && topics[2] === hexWord(args.creator)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- upload

export async function handleUpload(input: UploadInput): Promise<UploadOutput> {
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
  if (overLimit(`upload:${input.ip}`, input.now)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '60' });
  const c = config(input.env);
  const body = obj(input.body);

  if (body.op === 'status') {
    const enabled = c !== null && (await bucketReady(c, input.fetchImpl, input.now));
    return json(200, enabled ? { enabled: true } : { enabled: false, message: NOT_SET_UP }, headers);
  }
  if (body.op !== 'sign') return json(400, { error: 'bad-request' }, headers);
  if (!c || !(await bucketReady(c, input.fetchImpl, input.now))) return json(503, { error: 'not-configured', message: NOT_SET_UP }, headers);

  const secret = sessionSecret(input.env) ?? c.key;
  let owner: string | null;
  try {
    owner = await sessionOwner(secret, input.authorization, input.now, rest(c.base, c.key, input.fetchImpl));
  } catch {
    return json(502, { error: 'database', message: 'Your sign-in could not be checked right now.' }, headers);
  }
  if (!owner) return json(401, { error: 'session', message: 'Sign in again to continue.' }, headers);

  const plan = planUpload(body);
  if (!plan.ok) return json(400, { error: 'refused', message: plan.message }, headers);

  if (overBudget(`upload-owner:${owner}`, input.now, UPLOAD_LIMITS.perOwnerPerHour, HOUR) || overBudget(`upload-ip:${input.ip}`, input.now, UPLOAD_LIMITS.perIpPerHour, HOUR))
    return json(429, { error: 'rate-limit', message: 'Too many uploads from this wallet. Try again later.' }, { ...headers, 'retry-after': '600' });

  // An Ethereum-style token's file is accepted only from the wallet that created that token.
  if (body.kind === 'evm-meta') {
    const address = String(body.address);
    const txHash = typeof body.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(body.txHash) ? body.txHash : null;
    if (!owner.startsWith('evm:') || !txHash) return json(400, { error: 'refused', message: 'Sign in with the wallet that created the token and give its creation transaction.' }, headers);
    let ok: boolean;
    try {
      ok = await creationMatches({ chain: body.chain as EvmLaunchChain, token: address, creator: owner.slice(4), txHash, env: input.env, fetchImpl: input.fetchImpl });
    } catch {
      return json(502, { error: 'chain', message: 'The creation could not be read from the network right now. Try again in a minute.' }, headers);
    }
    if (!ok) return json(403, { error: 'not-creator', message: 'That transaction does not show this wallet creating this token through Aretia.' }, headers);
  }

  const url = publicUrl(c.base, c.bucket, plan.path);
  if (plan.immutableName) {
    try {
      if ((await input.fetchImpl(url, { method: 'HEAD' })).ok) return json(200, { exists: true, url }, headers);
    } catch {
      // not known to exist: a link is issued, and an upload of the same bytes to an existing name is refused by Storage
    }
  }
  try {
    const res = await input.fetchImpl(`${c.base}/storage/v1/object/upload/sign/${encodeURIComponent(c.bucket)}/${plan.path.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST',
      headers: { ...supabaseHeaders(c.key), 'content-type': 'application/json', ...(plan.immutableName ? {} : { 'x-upsert': 'true' }) },
      body: '{}',
    });
    const data = obj(await res.json().catch(() => null));
    if (!res.ok || typeof data.url !== 'string') {
      if (res.status === 404) statusCache = null;
      return json(502, { error: 'storage', message: res.status === 404 ? NOT_SET_UP : 'The picture store did not give an upload link. Try again.' }, headers);
    }
    const uploadUrl = data.url.startsWith('https://') ? data.url : `${c.base}/storage/v1${data.url.startsWith('/') ? '' : '/'}${data.url}`;
    if (!uploadUrl.startsWith(`${c.base}/storage/v1/object/upload/sign/`)) return json(502, { error: 'storage', message: 'The picture store answered unexpectedly.' }, headers);
    return json(200, { uploadUrl, url, contentType: plan.contentType, upsert: !plan.immutableName, maxBytes: plan.contentType === 'application/json' ? JSON_MAX_BYTES : undefined }, headers);
  } catch {
    return json(502, { error: 'storage', message: 'The picture store could not be reached. Try again.' }, headers);
  }
}

// ---------------------------------------------------------------- reading details back

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

async function fetchMetaJson(fetchImpl: typeof fetch, url: string): Promise<TokenMeta | null> {
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const text = await res.text();
    return text.length <= JSON_MAX_BYTES * 4 ? parseMetadataJson(text) : null;
  } catch {
    return null;
  }
}

/** The metadata uri of Token-2022 mints, read from the chain. */
async function solanaUris(input: UploadInput, addresses: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const rpc = input.env.SOLANA_RPC_URL?.trim() || 'https://solana-rpc.publicnode.com';
  const res = await input.fetchImpl(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [addresses, { encoding: 'jsonParsed' }] }) });
  if (!res.ok) throw new Error(String(res.status));
  const value = obj(obj(await res.json()).result).value;
  if (!Array.isArray(value)) return out;
  value.forEach((acc, i) => {
    const info = obj(obj(obj(obj(acc).data).parsed).info);
    const ext = Array.isArray(info.extensions) ? info.extensions : [];
    for (const e of ext) {
      const x = obj(e);
      const uri = obj(x.state).uri;
      if (x.extension === 'tokenMetadata' && typeof uri === 'string') out.set(addresses[i]!, uri);
    }
  });
  return out;
}

export async function handleMeta(input: UploadInput): Promise<UploadOutput> {
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (input.method !== 'GET') return json(405, { error: 'method' }, { ...headers, allow: 'GET' });
  if (overLimit(`meta:${input.ip}`, input.now)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '30' });
  const c = config(input.env);
  const chain = input.query.chain ?? '';
  const solana = chain === 'solana';
  if (!solana && !(EVM_META_CHAINS as readonly string[]).includes(chain)) return json(400, { error: 'bad-request' }, headers);
  const wanted = [...new Set((input.query.address ?? '').split(',').map((s) => s.trim()).filter((a) => (solana ? SOLANA_ADDRESS.test(a) : EVM_ADDRESS.test(a))))]
    .map((a) => (solana ? a : a.toLowerCase()))
    .slice(0, MAX_ADDRESSES);
  const cached = { ...headers, 'cache-control': 'public, s-maxage=120, stale-while-revalidate=600' };
  if (!c || wanted.length === 0) return json(200, { items: {}, ...(c ? {} : { setup: 'not-configured' }) }, c ? cached : headers);

  const items: Record<string, TokenMeta> = {};
  const todo: string[] = [];
  for (const a of wanted) {
    const hit = metaCache.get(`${chain}:${a}`);
    if (hit && input.now - hit.at < (hit.meta ? META_TTL_MS : META_MISS_TTL_MS)) {
      if (hit.meta) items[a] = hit.meta;
    } else todo.push(a);
  }
  if (todo.length > 0) {
    const found = new Map<string, TokenMeta | null>();
    try {
      if (solana) {
        const prefix = publicUrl(c.base, c.bucket, 'meta/');
        const uris = await solanaUris(input, todo);
        await Promise.all(todo.map(async (a) => {
          const uri = uris.get(a);
          // Only a file in Aretia's own bucket is read: a token may point its uri anywhere, and that is not fetched from here.
          found.set(a, uri && uri.startsWith(prefix) && /^[0-9a-f]{64}\.json$/.test(uri.slice(prefix.length)) ? await fetchMetaJson(input.fetchImpl, uri) : null);
        }));
      } else {
        await Promise.all(todo.map(async (a) => void found.set(a, await fetchMetaJson(input.fetchImpl, publicUrl(c.base, c.bucket, `evm/${chain}/${a}.json`)))));
      }
    } catch {
      return json(502, { error: 'upstream' }, headers);
    }
    for (const [a, m] of found) {
      const meta = hasMeta(m) ? m : null;
      metaCache.set(`${chain}:${a}`, { at: input.now, meta });
      if (meta) items[a] = meta;
    }
    if (metaCache.size > 5000) metaCache.clear();
  }
  return json(200, { items }, cached);
}
