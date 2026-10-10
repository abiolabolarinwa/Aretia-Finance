/**
 * POST /api/swings-events: stores anonymous, aggregate Swings events (see supabase/migrations/0002).
 * Strict allow-list of names and fields, so the table cannot become a place to put personal data:
 * anything else in a request is dropped, and a request that carries nothing valid stores nothing.
 * The caller's IP is used only for the in-memory rate limit and is never written down.
 * Off unless SWINGS_ANALYTICS is "1" and the database is configured.
 */
import { isOriginAllowed, overLimit, type ProxyEnv } from './_rpcProxy.js';
import { supabaseBase, supabaseHeaders } from '../src/swings/tokens/supabaseAuth.js';

export interface EventsEnv extends ProxyEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  PUBLIC_SWINGS_ANALYTICS?: string;
}

const CHAINS = ['solana', 'ethereum', 'bnb', 'polygon', 'base', 'arbitrum', 'optimism', 'avalanche', 'robinhood'];
const NAMES = ['quote_failed', 'routes_found', 'swap', 'shadow'];
const STATUSES = ['submitted', 'confirmed', 'failed', 'rejected', 'expired'];
const PROVIDER = /^[a-z0-9_-]{1,24}$/;
const MAX_EVENTS = 20;
const MAX_BODY = 4 * 1024;

export interface CleanEvent {
  at: number;
  name: string;
  chain: string | null;
  provider: string | null;
  status: string | null;
  ms: number | null;
  count: number | null;
  /** Shadow comparison only: the other provider, and Aretia's output minus its output, in basis points. */
  rival: string | null;
  diff_bps: number | null;
}

/** Keeps only the allow-listed fields with valid values. Returns null if the event is not usable. */
export function cleanEvent(raw: unknown, at: number): CleanEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.name !== 'string' || !NAMES.includes(e.name)) return null;
  const int = (v: unknown, max: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null);
  return {
    at,
    name: e.name,
    chain: typeof e.chain === 'string' && CHAINS.includes(e.chain) ? e.chain : null,
    provider: typeof e.provider === 'string' && PROVIDER.test(e.provider) ? e.provider : typeof e.best === 'string' && PROVIDER.test(e.best) ? e.best : null,
    status: typeof e.status === 'string' && STATUSES.includes(e.status) ? e.status : null,
    ms: int(e.ms, 3_600_000),
    count: int(e.count, 1000),
    rival: e.name === 'shadow' && typeof e.rival === 'string' && PROVIDER.test(e.rival) ? e.rival : null,
    diff_bps: e.name === 'shadow' && typeof e.diff === 'number' && Number.isInteger(e.diff) && e.diff >= -10_000 && e.diff <= 10_000 ? e.diff : null,
  };
}

export async function handleEvents(input: { method: string; origin: string | null; ip: string; contentType: string | null; body: string; env: EventsEnv; fetchImpl: typeof fetch; now: number }): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const headers: Record<string, string> = { vary: 'origin', 'cache-control': 'no-store', 'content-type': 'application/json' };
  const allowed = isOriginAllowed(input.origin, input.env);
  if (allowed) {
    headers['access-control-allow-origin'] = input.origin!;
    headers['access-control-allow-methods'] = 'POST, OPTIONS';
    headers['access-control-allow-headers'] = 'content-type';
  }
  const reply = (status: number, error?: string) => ({ status, body: JSON.stringify(error ? { error } : { ok: true }), headers });
  if (input.method === 'OPTIONS') return { status: allowed ? 204 : 403, body: '', headers };
  if (input.method !== 'POST') return reply(405, 'method');
  if (!allowed) return reply(403, 'origin');
  const { env } = input;
  const url = supabaseBase(env.SUPABASE_URL);
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (env.PUBLIC_SWINGS_ANALYTICS !== '1' || !url || !key) return reply(503, 'not-configured');
  if (!(input.contentType ?? '').toLowerCase().includes('json') && !(input.contentType ?? '').toLowerCase().includes('text/plain')) return reply(415, 'content-type');
  if (new TextEncoder().encode(input.body).length > MAX_BODY) return reply(413, 'too-large');
  if (overLimit(`events:${input.ip}`, input.now)) return reply(429, 'rate-limit');

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    return reply(400, 'json');
  }
  const list = (typeof parsed === 'object' && parsed !== null ? (parsed as { events?: unknown }).events : null) as unknown;
  if (!Array.isArray(list)) return reply(400, 'shape');
  const rows = list.slice(0, MAX_EVENTS).map((e) => cleanEvent(e, input.now)).filter((e): e is CleanEvent => e !== null);
  if (rows.length === 0) return reply(400, 'empty');
  try {
    const res = await input.fetchImpl(`${url.replace(/\/$/, '')}/rest/v1/swings_events`, {
      method: 'POST',
      headers: { ...supabaseHeaders(key), 'content-type': 'application/json', prefer: 'return=minimal' },
      body: JSON.stringify(rows),
    });
    return res.ok ? reply(202) : reply(502, 'database');
  } catch {
    return reply(502, 'database');
  }
}
