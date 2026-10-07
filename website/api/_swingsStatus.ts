/**
 * GET /api/swings-status: tells the page which optional Swings services this deployment has switched on.
 * Yes/no and chain ids only; never a key, URL or secret.
 *
 * SWINGS_EVM_CHAINS (comma-separated, for example "base,polygon") is the operator's explicit switch for
 * each EVM chain. Aretia's own router needs no third-party key. ZEROX_API_KEY only enables the optional,
 * non-core 0x benchmarking provider. Unlisted chains stay off.
 */
import { isOriginAllowed, type ProxyEnv } from './_rpcProxy.js';

export interface StatusEnv extends ProxyEnv {
  ZEROX_API_KEY?: string;
  SWINGS_EVM_CHAINS?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  PUBLIC_SWINGS_ANALYTICS?: string;
  /** Set to "off" to stop the non-core aggregator providers (Jupiter, 0x) taking part in quotes. */
  SWINGS_AGGREGATORS?: string;
}

const EVM_CHAINS = ['ethereum', 'bnb', 'polygon', 'base', 'arbitrum', 'optimism', 'avalanche'];

export function handleStatus(input: { method: string; origin: string | null; env: StatusEnv }): { status: number; body: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { vary: 'origin', 'cache-control': 'no-store', 'content-type': 'application/json' };
  const allowed = isOriginAllowed(input.origin, input.env);
  if (allowed) headers['access-control-allow-origin'] = input.origin!;
  if (input.method !== 'GET') return { status: 405, body: '{"error":"method"}', headers: { ...headers, allow: 'GET' } };
  if (!allowed) return { status: 403, body: '{"error":"origin"}', headers };
  const { env } = input;
  const configured = Boolean(env.ZEROX_API_KEY?.trim());
  const chains = (env.SWINGS_EVM_CHAINS ?? '').split(',').map((c) => c.trim().toLowerCase()).filter((c) => EVM_CHAINS.includes(c));
  const body = {
    evm: { configured, chains },
    tokens: Boolean(env.SUPABASE_URL?.trim() && env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
    analytics: env.PUBLIC_SWINGS_ANALYTICS === '1',
    aggregators: env.SWINGS_AGGREGATORS !== 'off',
  };
  return { status: 200, body: JSON.stringify(body), headers };
}
