/**
 * AretiaDexRegistry: what Aretia knows about each venue. A venue is data (addresses, mechanism, fee
 * model, status), so adding or removing one never touches routing code.
 *
 * The addresses in dex/entries.ts are real protocol deployments. An entry is trusted for routing only
 * after `npm run test:live` has confirmed on-chain that its contracts exist and behave (see the
 * `verified` field and dex/entries.live.ts).
 */
import type { ChainId } from '../core/types.js';
import { SwingsError } from '../core/types.js';
import type { ProviderHealth } from './health.js';
import { worstStatus } from './health.js';
import type { DexStatus, PoolModel } from './types.js';

/** How swaps on this venue are executed. New mechanisms get a new value and a new adapter. */
export type SwapMechanism = 'evm-v2-router' | 'evm-v3-router' | 'evm-aerodrome-router' | 'evm-balancer-vault' | 'evm-curve-pool' | 'solana-program';

export interface DexEntry {
  id: string;
  name: string;
  chain: ChainId;
  protocol: 'uniswap-v2' | 'uniswap-v3' | 'curve' | 'balancer' | 'aerodrome' | 'raydium' | 'orca' | 'meteora' | 'pumpswap';
  model: PoolModel;
  mechanism: SwapMechanism;
  /** Router (EVM) or program id (Solana). */
  router?: string;
  factory?: string;
  quoter?: string;
  /** Default fee in parts per million, where the venue has one fixed fee (V2 forks). */
  feePpm?: number;
  /** The chain's wrapped native token, used when a path starts or ends in the native coin. */
  wrappedNative?: string;
  /** Pool addresses Aretia knows for venues whose pools cannot be derived from a pair (for example ACT's own pools). */
  knownPools?: string[];
  /** V2 forks on Avalanche name their native-coin functions after AVAX (`swapExactAVAXForTokens`) instead of ETH. */
  nativeNaming?: 'avax';
  /** V3-style venues: the fee tiers (in hundredths of a basis point) their factory may hold pools for. */
  feeTiers?: number[];
  status: DexStatus;
  notes?: string;
}

export class AretiaDexRegistry {
  private readonly entries = new Map<string, DexEntry>();
  /** Manual status overrides, kept apart from the entry so health and manual flags can combine. */
  private readonly manual = new Map<string, DexStatus>();

  constructor(
    entries: readonly DexEntry[] = [],
    private readonly health: ProviderHealth | null = null,
  ) {
    for (const e of entries) this.register(e);
  }

  register(entry: DexEntry): void {
    if (this.entries.has(entry.id)) throw new SwingsError('invalid', `A venue named ${entry.id} is already registered.`);
    this.entries.set(entry.id, { ...entry });
  }

  /** Removing a venue is all it takes to stop routing through it. */
  remove(id: string): boolean {
    this.manual.delete(id);
    return this.entries.delete(id);
  }

  get(id: string): DexEntry | null {
    return this.entries.get(id) ?? null;
  }

  forChain(chain: ChainId): DexEntry[] {
    return [...this.entries.values()].filter((e) => e.chain === chain);
  }

  setStatus(id: string, status: DexStatus): void {
    if (!this.entries.has(id)) throw new SwingsError('invalid', `Unknown venue ${id}.`);
    this.manual.set(id, status);
  }

  /** The venue's registered status, any manual flag, and measured health: whichever is worst. */
  effectiveStatus(id: string): DexStatus {
    const e = this.entries.get(id);
    if (!e) return 'DISABLED';
    let status = worstStatus(e.status, this.manual.get(id) ?? 'ACTIVE');
    if (this.health) status = worstStatus(status, this.health.status(id));
    return status;
  }

  /** Venues the router may use now. DEGRADED venues are returned too (the router penalises them). */
  routable(chain: ChainId): DexEntry[] {
    return this.forChain(chain).filter((e) => {
      const s = this.effectiveStatus(e.id);
      return s === 'ACTIVE' || s === 'DEGRADED';
    });
  }

  all(): DexEntry[] {
    return [...this.entries.values()];
  }
}
