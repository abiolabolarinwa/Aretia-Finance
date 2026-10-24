/**
 * Keeps the API reachable only through Aretia's own Cloudflare forwarder (functions/api/[[path]].ts), so whatever protection is set at
 * Cloudflare (rate limits, bot rules) cannot be skipped by calling the *.vercel.app address directly.
 *
 * Off by default, so an existing deployment keeps working until the operator turns it on: it is active only when BOTH `CF_PROXY_SECRET`
 * and `REQUIRE_CF_PROXY=1` are set. The forwarder adds `x-aretia-proxy-secret`; any request without the right value is refused with 403.
 * Scheduled jobs that call Vercel directly (Vercel's own cron) pass `exempt` and are protected by their own bearer secret instead.
 */
import { sameSecret } from './_secrets.js';

type Header = string | string[] | undefined;

export interface GuardEnv {
  CF_PROXY_SECRET?: string;
  REQUIRE_CF_PROXY?: string;
}

const one = (v: Header): string | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/** True when the request may be served: the guard is off, the caller is exempt, or the forwarder's secret is present and correct. */
export function viaCloudflare(headers: Record<string, Header>, env: GuardEnv = process.env, exempt = false): boolean {
  if (exempt) return true;
  const secret = env.CF_PROXY_SECRET?.trim();
  if (env.REQUIRE_CF_PROXY !== '1' || !secret) return true;
  return sameSecret(one(headers['x-aretia-proxy-secret']), secret);
}

interface GuardRes {
  status(code: number): GuardRes;
  setHeader(name: string, value: string): void;
  send(body: string): void;
}

/** The refusal: the same body as an unknown path, and nothing cacheable. */
export function refuse(res: GuardRes): void {
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.status(403).send('{"error":"forbidden"}');
}
