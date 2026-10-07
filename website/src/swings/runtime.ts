/**
 * Runtime configuration the server reports: which optional services are set up and which EVM chains the
 * operator has switched on. The page never learns any secret, only yes/no and chain ids.
 *
 * A chain can execute when the code says so (`CHAINS[..].executionEnabled`, Solana) or when the operator lists
 * it in SWINGS_EVM_CHAINS. Aretia's own EVM router needs no third-party key, so the list alone decides.
 * The default is everything off. The 0x key only switches on the optional benchmarking provider.
 */
import { CHAINS, isChainId, type ChainId } from './core/types.js';

export interface RuntimeConfig {
  /** The optional 0x benchmarking provider is configured (non-core). */
  evmConfigured: boolean;
  evmChains: ChainId[];
  tokensConfigured: boolean;
  analytics: boolean;
  /** Whether the non-core aggregator providers (Jupiter, 0x) may take part. The operator can switch them off. */
  aggregators: boolean;
  /**
   * Staged rollout: SHA-256 hashes of the wallet addresses allowed to review and sign swaps, or null for everyone.
   * Hashes, so the list of first users is not published. This is a rollout brake on a non-custodial page, not access control.
   */
  canary?: string[] | null;
  /** The operator has switched on protected (Jito) sending for Solana. */
  protectedSubmit?: boolean;
  loaded: boolean;
}

export const runtime: RuntimeConfig = { evmConfigured: false, evmChains: [], tokensConfigured: false, analytics: false, aggregators: true, canary: null, protectedSubmit: false, loaded: false };

/** Pure reading of a status response: anything unexpected leaves the safe default (all off). */
export function parseStatus(body: unknown): Omit<RuntimeConfig, 'loaded'> {
  const off = { evmConfigured: false, evmChains: [] as ChainId[], tokensConfigured: false, analytics: false, aggregators: true, canary: null as string[] | null, protectedSubmit: false };
  if (typeof body !== 'object' || body === null) return off;
  const b = body as Record<string, unknown>;
  const evm = typeof b.evm === 'object' && b.evm !== null ? (b.evm as Record<string, unknown>) : {};
  const configured = evm.configured === true;
  const chains = Array.isArray(evm.chains) ? evm.chains.filter((c): c is ChainId => isChainId(c) && CHAINS[c].kind === 'evm') : [];
  const canary = Array.isArray(b.canary) ? b.canary.filter((h): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) : null;
  return { evmConfigured: configured, evmChains: chains, tokensConfigured: b.tokens === true, analytics: b.analytics === true, aggregators: b.aggregators !== false, canary, protectedSubmit: b.protectedSubmit === true };
}

export async function loadRuntime(fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    const res = await fetchImpl('/api/swings-status');
    if (res.ok) Object.assign(runtime, parseStatus(await res.json().catch(() => null)));
  } catch {
    // Unreachable status means "off", which is already the state.
  }
  runtime.loaded = true;
}

export function isChainEnabled(chain: ChainId, config: RuntimeConfig = runtime): boolean {
  const info = CHAINS[chain];
  return info.executionEnabled || (info.kind === 'evm' && config.evmChains.includes(chain));
}

/** The form an address is hashed in: EVM addresses lower-case, Solana addresses exactly as written. */
export const canaryForm = (address: string): string => (address.startsWith('0x') ? address.toLowerCase() : address);

export async function hashAddress(address: string): Promise<string> {
  const bytes = new TextEncoder().encode(canaryForm(address));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** True when everyone may swap (no staged rollout) or this wallet is in the first group. */
export async function isCanaryAllowed(address: string | null, config: RuntimeConfig = runtime): Promise<boolean> {
  if (!config.canary) return true;
  if (!address) return false;
  return config.canary.includes(await hashAddress(address));
}
