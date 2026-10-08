/**
 * /api/swings-records: optional recovery copies of Swings executions and plans (see supabase/migrations/0005).
 *
 *   GET  ?id=<record id>                          the record, or 404
 *   PUT  { kind, record, expectedVersion }        create (expectedVersion 0) or update (the stored version must match)
 *
 * What keeps it safe:
 *  - the record's long random id is the only key. There is no listing and no search, so nobody can find another
 *    person's record without already holding its id;
 *  - nothing is stored unless it is a well-formed record of a known kind and state, small, shallow, and free of
 *    secret-looking fields, so the table cannot become a place to put keys or personal documents;
 *  - writes are version-checked in the database itself (a stale write is refused with 409), so two tabs cannot clobber
 *    each other;
 *  - same allowed-origin rule and rate limit as the other functions; off unless the database is configured.
 */
import { isOriginAllowed, overLimit, type ProxyEnv } from './_rpcProxy.js';
import { supabaseBase, supabaseHeaders } from '../src/swings/tokens/supabaseAuth.js';

export interface RecordsEnv extends ProxyEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

export const RECORD_ID = /^[a-z0-9_]{24,72}$/;
const EXECUTION_STATES = ['CREATED', 'QUOTED', 'AWAITING_SIGNATURE', 'SOURCE_SUBMITTED', 'SOURCE_CONFIRMED', 'SETTLEMENT_PENDING', 'DESTINATION_RECEIVED', 'DESTINATION_EXECUTED', 'COMPLETED', 'FAILED', 'EXPIRED', 'REFUNDED'];
const PLAN_STATES = ['PLANNED', 'RUNNING', 'WAITING_USER', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'];
const SECRET_KEY = /seed|mnemonic|passphrase|password|private|secret|keypair|apikey|api_key|authorization|bearer|cookie|cvv|cvc|card|iban|passport|ssn/i;
const MAX_BODY = 96 * 1024;
const MAX_DEPTH = 14;

export interface CleanRecord {
  id: string;
  kind: 'settlement' | 'plan';
  version: number;
  state: string;
  body: Record<string, unknown>;
}

function shallowAndClean(v: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(v)) return v.length <= 500 && v.every((x) => shallowAndClean(x, depth + 1));
  if (typeof v === 'object' && v !== null) return Object.entries(v).every(([k, x]) => !SECRET_KEY.test(k) && shallowAndClean(x, depth + 1));
  return typeof v === 'string' ? v.length <= 4000 : true;
}

/** The record to store, or the reason it is refused. */
export function cleanRecord(kind: unknown, record: unknown): { ok: true; value: CleanRecord } | { ok: false; reason: string } {
  if (kind !== 'settlement' && kind !== 'plan') return { ok: false, reason: 'kind' };
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return { ok: false, reason: 'shape' };
  const r = record as Record<string, unknown>;
  if (typeof r.id !== 'string' || !RECORD_ID.test(r.id)) return { ok: false, reason: 'id' };
  if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 1 || r.version > 1_000_000) return { ok: false, reason: 'version' };
  if (typeof r.state !== 'string' || !(kind === 'settlement' ? EXECUTION_STATES : PLAN_STATES).includes(r.state)) return { ok: false, reason: 'state' };
  if (!shallowAndClean(r)) return { ok: false, reason: 'content' };
  return { ok: true, value: { id: r.id, kind, version: r.version, state: r.state, body: r } };
}

export interface RecordsInput {
  method: string;
  origin: string | null;
  ip: string;
  contentType: string | null;
  query: Record<string, string | undefined>;
  body: string;
  env: RecordsEnv;
  fetchImpl: typeof fetch;
  now: number;
}

export async function handleRecords(input: RecordsInput): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const headers: Record<string, string> = { vary: 'origin', 'cache-control': 'no-store', 'content-type': 'application/json' };
  const allowed = isOriginAllowed(input.origin, input.env);
  if (allowed) {
    headers['access-control-allow-origin'] = input.origin!;
    headers['access-control-allow-methods'] = 'GET, PUT, OPTIONS';
    headers['access-control-allow-headers'] = 'content-type';
  }
  const reply = (status: number, value: unknown) => ({ status, body: JSON.stringify(value), headers });
  const err = (status: number, error: string) => reply(status, { error });
  if (input.method === 'OPTIONS') return { status: allowed ? 204 : 403, body: '', headers };
  if (input.method !== 'GET' && input.method !== 'PUT') return err(405, 'method');
  if (!allowed) return err(403, 'origin');
  const url = supabaseBase(input.env.SUPABASE_URL);
  const key = input.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return err(503, 'not-configured');
  if (overLimit(`records:${input.ip}`, input.now)) return err(429, 'rate-limit');
  const db = { ...supabaseHeaders(key), 'content-type': 'application/json' };
  const table = `${url}/rest/v1/swings_records`;

  try {
    if (input.method === 'GET') {
      const id = input.query.id ?? '';
      if (!RECORD_ID.test(id)) return err(400, 'id');
      const res = await input.fetchImpl(`${table}?id=eq.${encodeURIComponent(id)}&select=body`, { headers: db });
      if (!res.ok) return err(502, 'database');
      const rows = (await res.json()) as { body: unknown }[];
      return rows[0] ? reply(200, { record: rows[0].body }) : err(404, 'not-found');
    }

    if (!(input.contentType ?? '').toLowerCase().includes('json')) return err(415, 'content-type');
    if (new TextEncoder().encode(input.body).length > MAX_BODY) return err(413, 'too-large');
    let parsed: { kind?: unknown; record?: unknown; expectedVersion?: unknown };
    try {
      parsed = JSON.parse(input.body) as typeof parsed;
    } catch {
      return err(400, 'json');
    }
    const clean = cleanRecord(parsed.kind, parsed.record);
    if (!clean.ok) return err(400, clean.reason);
    const { value } = clean;
    const expected = parsed.expectedVersion;
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) return err(400, 'expectedVersion');
    if (value.version !== expected + 1) return err(400, 'version-step');
    const row = { id: value.id, kind: value.kind, version: value.version, state: value.state, body: value.body, updated_at: input.now };

    if (expected === 0) {
      const res = await input.fetchImpl(table, { method: 'POST', headers: { ...db, prefer: 'return=minimal' }, body: JSON.stringify({ ...row, created_at: input.now }) });
      if (res.status === 409) return err(409, 'conflict');
      return res.ok ? reply(201, { ok: true, version: value.version }) : err(502, 'database');
    }
    // The version check happens inside the database: the update matches only the version the caller last saw.
    const res = await input.fetchImpl(`${table}?id=eq.${encodeURIComponent(value.id)}&version=eq.${expected}&kind=eq.${value.kind}`, { method: 'PATCH', headers: { ...db, prefer: 'return=representation' }, body: JSON.stringify({ version: row.version, state: row.state, body: row.body, updated_at: row.updated_at }) });
    if (!res.ok) return err(502, 'database');
    const changed = (await res.json()) as unknown[];
    return changed.length === 1 ? reply(200, { ok: true, version: value.version }) : err(409, 'conflict');
  } catch {
    return err(502, 'database');
  }
}
