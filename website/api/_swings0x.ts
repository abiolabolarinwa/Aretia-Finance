/**
 * Core of POST /api/swings-0x: the server-side door to the 0x Swap API for Aretia Swings. The browser
 * never sees the API key (ZEROX_API_KEY, a server environment variable) and cannot choose the upstream
 * path or add parameters: only the validated fields below are forwarded to one fixed endpoint.
 *
 * Without ZEROX_API_KEY the endpoint answers 503 "not configured"; it never guesses or falls back.
 * Same origin allow-list and per-IP limit as the RPC proxy. Request bodies are not logged here.
 */
import { isOriginAllowed, overLimit, type ProxyEnv } from './_rpcProxy.js';

export const ZEROX_QUOTE_URL = 'https://api.0x.org/swap/allowance-holder/quote';
/** EVM chains Swings may ask about (EIP-155 ids): Ethereum, BNB Chain, Polygon, Base. */
export const ZEROX_CHAIN_IDS: ReadonlySet<number> = new Set([1, 56, 137, 8453]);
const MAX_BODY_BYTES = 2 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;

export interface ZeroXEnv extends ProxyEnv {
  ZEROX_API_KEY?: string;
}

export interface ZeroXInput {
  method: string;
  origin: string | null;
  ip: string;
  contentType: string | null;
  body: string;
  env: ZeroXEnv;
  fetchImpl: typeof fetch;
  now: number;
}

export interface ZeroXOutput {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DIGITS = /^[0-9]{1,78}$/;

const fail = (status: number, error: string, message: string, headers: Record<string, string>): ZeroXOutput => ({
  status,
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ error, message }),
});

export async function handleZeroX(input: ZeroXInput): Promise<ZeroXOutput> {
  const { env } = input;
  const headers: Record<string, string> = { vary: 'origin', 'cache-control': 'no-store' };
  const allowed = isOriginAllowed(input.origin, env);
  if (allowed) {
    headers['access-control-allow-origin'] = input.origin!;
    headers['access-control-allow-methods'] = 'POST, OPTIONS';
    headers['access-control-allow-headers'] = 'content-type';
  }
  if (input.method === 'OPTIONS') return { status: allowed ? 204 : 403, body: '', headers };
  if (input.method !== 'POST') return fail(405, 'method', 'Use POST.', { ...headers, allow: 'POST, OPTIONS' });
  if (!allowed) return fail(403, 'origin', 'This origin is not allowed.', headers);
  if (!(input.contentType ?? '').toLowerCase().includes('application/json')) return fail(415, 'content-type', 'Send JSON.', headers);
  if (new TextEncoder().encode(input.body).length > MAX_BODY_BYTES) return fail(413, 'too-large', 'Request too large.', headers);

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    return fail(400, 'json', 'Invalid JSON.', headers);
  }
  const p = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
  const { chainId, sellToken, buyToken, sellAmount, taker, slippageBps } = p;
  if (typeof chainId !== 'number' || !ZEROX_CHAIN_IDS.has(chainId)) return fail(400, 'chain', 'Unsupported chain.', headers);
  if (typeof sellToken !== 'string' || !EVM_ADDRESS.test(sellToken) || typeof buyToken !== 'string' || !EVM_ADDRESS.test(buyToken)) return fail(400, 'token', 'Invalid token address.', headers);
  if (typeof taker !== 'string' || !EVM_ADDRESS.test(taker)) return fail(400, 'taker', 'Invalid wallet address.', headers);
  if (typeof sellAmount !== 'string' || !DIGITS.test(sellAmount) || BigInt(sellAmount) <= 0n) return fail(400, 'amount', 'Invalid amount.', headers);
  if (typeof slippageBps !== 'number' || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) return fail(400, 'slippage', 'Invalid slippage.', headers);

  const key = env.ZEROX_API_KEY?.trim();
  if (!key) return fail(503, 'not-configured', 'EVM swaps are not configured on this server yet.', headers);
  if (overLimit(`0x:${input.ip}`, input.now)) return fail(429, 'rate-limit', 'Too many requests. Try again in a minute.', { ...headers, 'retry-after': '60' });

  const query = new URLSearchParams({ chainId: String(chainId), sellToken, buyToken, sellAmount, taker, slippageBps: String(slippageBps) });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await input.fetchImpl(`${ZEROX_QUOTE_URL}?${query}`, { headers: { '0x-api-key': key, '0x-version': 'v2' }, signal: controller.signal });
    const text = await res.text();
    if (res.status === 400 || res.status === 404) return fail(422, 'no-route', 'No route was found for this swap.', headers);
    // Never relay an upstream error body: it can echo request details or account information.
    if (!res.ok) return fail(res.status === 429 ? 429 : 502, 'upstream', 'The routing provider could not complete that request.', headers);
    return { status: 200, body: text, headers: { ...headers, 'content-type': 'application/json' } };
  } catch {
    return fail(504, 'timeout', 'The routing provider did not answer in time.', headers);
  } finally {
    clearTimeout(timer);
  }
}
