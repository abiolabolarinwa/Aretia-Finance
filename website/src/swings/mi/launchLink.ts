/**
 * Association with Aretia Launch Box. READ ONLY: this file never writes to Launch Box tables, never creates a Launch Box record
 * and does not decide what Launch Box lists. It answers one question for the engine: "is this discovered token one that Aretia
 * Launch Box created?", so the market record is attached to the existing token instead of becoming a second one.
 *
 *  - EVM: the Launch Box row must exist AND its creation transaction must contain a `TokenCreated` log for this token emitted by
 *    the approved Aretia factory of that chain (checked here, on-chain, with Launch Box's own decoder). A row that fails the check
 *    is not linked.
 *  - Solana: the row must exist and Launch Box must have judged it (not pending, checked); its mint rule is Launch Box's.
 */
import { decodeTokenCreated, EVM_FACTORIES, isLaunchChain, tokenKey, type EvmLaunchChain } from '../launchbox/core.js';
import { supabaseHeaders } from '../tokens/supabaseAuth.js';
import type { LaunchLookup } from './engine.js';
import { RpcError, type Read } from './rpc.js';

interface LaunchRow {
  chain: string;
  address: string;
  tx: string | null;
  pending: boolean | null;
  checked_at: number | null;
}

export interface LaunchLinkDeps {
  supabaseUrl: string;
  serviceKey: string;
  fetchImpl: typeof fetch;
  /** The reader of the chain, for the on-chain creation check. */
  readFor: (chain: string) => Read | null;
}

export function launchLookup(d: LaunchLinkDeps): LaunchLookup {
  return {
    async find(chain, addresses) {
      const out = new Map<string, string>();
      if (!isLaunchChain(chain) || addresses.length === 0) return out;
      const list = addresses.map((a) => `"${(chain === 'solana' ? a : a.toLowerCase()).replace(/[^A-Za-z0-9]/g, '')}"`).join(',');
      const res = await d.fetchImpl(`${d.supabaseUrl.replace(/\/$/, '')}/rest/v1/launchbox_tokens?chain=eq.${chain}&address=in.(${list})&select=chain,address,tx,pending,checked_at`, { headers: supabaseHeaders(d.serviceKey) });
      // Launch Box tables missing (not migrated yet): no association is possible, and that is not an error for the indexer.
      if (res.status === 404 || res.status === 400) return out;
      if (!res.ok) throw new RpcError(`Launch Box lookup answered ${res.status}`, 'transport');
      const rows = (await res.json()) as LaunchRow[];
      for (const r of rows) {
        const address = chain === 'solana' ? r.address : r.address.toLowerCase();
        if (chain === 'solana') {
          if (r.pending !== true && r.checked_at !== null) out.set(address, tokenKey(chain, address));
          continue;
        }
        const read = d.readFor(chain);
        if (!read || !r.tx) continue;
        if (await creationVerified(read, chain as EvmLaunchChain, address, r.tx)) out.set(address, tokenKey(chain, address));
      }
      return out;
    },
  };
}

/** True when the transaction really created this token through the approved Aretia factory. Throws only on transport failure. */
export async function creationVerified(read: Read, chain: EvmLaunchChain, token: string, tx: string): Promise<boolean> {
  const receipt = (await read('eth_getTransactionReceipt', [tx])) as { status?: string; logs?: unknown[] } | null;
  if (!receipt || receipt.status !== '0x1' || !Array.isArray(receipt.logs)) return false;
  for (const log of receipt.logs) {
    const l = log as { address?: unknown; topics?: unknown; data?: unknown; blockNumber?: unknown; transactionHash?: unknown; logIndex?: unknown };
    if (typeof l.address !== 'string' || l.address.toLowerCase() !== EVM_FACTORIES[chain]) continue;
    const decoded = decodeTokenCreated(chain, l);
    if (decoded && decoded.address === token.toLowerCase()) return true;
  }
  return false;
}
