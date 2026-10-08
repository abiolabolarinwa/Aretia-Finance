/**
 * GET /api/swings-status: tells the page which optional Swings services this deployment has switched on.
 * Yes/no and chain ids only; never a key, URL or secret.
 *
 * EVM networks are ON by default. SWINGS_EVM_CHAINS is the operator's switch: when it is set it is an allow-list
 * (comma-separated, for example "base,polygon"; the word "none" turns every EVM network off) and any chain not
 * listed is off. Aretia's own router needs no third-party key. ZEROX_API_KEY only enables the optional, non-core 0x
 * benchmarking provider.
 */
import { supabaseBase } from '../src/swings/tokens/supabaseAuth.js';
import { createHash } from 'node:crypto';
import { isOriginAllowed, type ProxyEnv } from './_rpcProxy.js';

export interface StatusEnv extends ProxyEnv {
  ZEROX_API_KEY?: string;
  SWINGS_EVM_CHAINS?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  PUBLIC_SWINGS_ANALYTICS?: string;
  /** Set to "off" to stop the non-core aggregator providers (Jupiter, 0x) taking part in quotes. */
  SWINGS_AGGREGATORS?: string;
  /**
   * Staged rollout: comma-separated wallet addresses allowed to review and sign swaps. Unset means everyone. Only
   * SHA-256 hashes are sent to the page, so the first group is not published.
   */
  SWINGS_CANARY_WALLETS?: string;
  /** Set to "on" to offer protected (Jito) sending for Solana swaps. Off unless set. */
  SWINGS_PROTECTED_SUBMIT?: string;
}

const EVM_CHAINS = ['ethereum', 'bnb', 'polygon', 'base', 'arbitrum', 'optimism', 'avalanche'];

/**
 * The EVM networks that are on. Unset means all of them. Set means exactly the ones listed ("none" or any list that
 * names no real chain means none), so the operator can switch any network off without a deploy.
 */
export function evmChainsFromEnv(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [...EVM_CHAINS];
  return value.split(',').map((c) => c.trim().toLowerCase()).filter((c) => EVM_CHAINS.includes(c));
}

/** Hashes of the listed addresses (EVM lower-cased, Solana as written), or null when no list is set. */
export function canaryHashes(list: string | undefined): string[] | null {
  const items = (list ?? '').split(',').map((a) => a.trim()).filter((a) => a.length > 0);
  if (items.length === 0) return null;
  return items.map((a) => createHash('sha256').update(a.startsWith('0x') ? a.toLowerCase() : a).digest('hex'));
}

export function handleStatus(input: { method: string; origin: string | null; env: StatusEnv }): { status: number; body: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { vary: 'origin', 'cache-control': 'no-store', 'content-type': 'application/json' };
  const allowed = isOriginAllowed(input.origin, input.env);
  if (allowed) headers['access-control-allow-origin'] = input.origin!;
  if (input.method !== 'GET') return { status: 405, body: '{"error":"method"}', headers: { ...headers, allow: 'GET' } };
  if (!allowed) return { status: 403, body: '{"error":"origin"}', headers };
  const { env } = input;
  const configured = Boolean(env.ZEROX_API_KEY?.trim());
  const chains = evmChainsFromEnv(env.SWINGS_EVM_CHAINS);
  const body = {
    evm: { configured, chains },
    tokens: Boolean(supabaseBase(env.SUPABASE_URL) && env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
    // Whether the optional recovery copy of executions can be kept on the server.
    records: Boolean(supabaseBase(env.SUPABASE_URL) && env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
    analytics: env.PUBLIC_SWINGS_ANALYTICS === '1',
    aggregators: env.SWINGS_AGGREGATORS !== 'off',
    canary: canaryHashes(env.SWINGS_CANARY_WALLETS),
    protectedSubmit: env.SWINGS_PROTECTED_SUBMIT === 'on',
  };
  return { status: 200, body: JSON.stringify(body), headers };
}
