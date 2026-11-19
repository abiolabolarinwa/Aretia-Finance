/**
 * The vault gate: the cheap question "did anything happen in this pool?" answered for a hundred pools with ONE node call.
 *
 * Following a pool means listing the signatures of its quote token account and reading each new transaction. Doing that for every
 * followed pool on every run is what used up a whole month of a hosted node's allowance in days: most pools did nothing in the 15
 * seconds since the last look. But a swap always moves tokens through the pool's vaults, so a pool whose quote vault holds exactly what it
 * held at the last look has had no swap. `getMultipleAccounts` reads 100 vaults in one call, so the gate reads them all, and only the
 * pools whose balance moved (or that were never seen, or whose vault could not be read) are followed.
 *
 * It can only make a read later, never lose one: the pool's cursor is a signature, so whenever the pool IS followed everything since the
 * last follow is read. A pool left alone for `maxQuietMs` is followed anyway (a safety net, and it keeps quiet pools' 24-hour figures
 * rolling). A failed balance read follows everything, as without the gate. An entry is committed only after the pool was followed without
 * a missing transaction, so a failed follow is tried again next pass.
 */
import type { Read } from '../rpc.js';
import type { MiPool } from '../types.js';
import { fromBase64 } from './accounts.js';

export type GateCommitment = 'finalized' | 'confirmed';

export interface GateStats {
  /** Pools asked about, pools left alone, pools let through. */
  asked: number;
  skipped: number;
  passed: number;
  /** Balance reads made. */
  reads: number;
}

export class VaultGate {
  private readonly seen = new Map<string, { amount: bigint; followedAt: number }>();
  private readonly staged = new Map<string, bigint>();
  readonly stats: GateStats = { asked: 0, skipped: 0, passed: 0, reads: 0 };

  constructor(private readonly maxQuietMs = 600_000) {}

  /** The pools worth following now, in the order given. */
  async select(rpc: Read, pools: readonly MiPool[], now: number, commitment: GateCommitment = 'finalized'): Promise<MiPool[]> {
    const withVault = pools.filter((p) => p.quoteVault);
    const amounts = new Map<string, bigint | null>();
    try {
      for (let i = 0; i < withVault.length; i += 100) {
        const slice = withVault.slice(i, i + 100);
        const r = (await rpc('getMultipleAccounts', [slice.map((p) => p.quoteVault), { encoding: 'base64', commitment, dataSlice: { offset: 64, length: 8 } }])) as { value?: ({ data: [string, string] } | null)[] };
        this.stats.reads++;
        if (!Array.isArray(r?.value) || r.value.length !== slice.length) throw new Error('malformed answer');
        slice.forEach((p, k) => {
          const v = r.value![k];
          const bytes = v ? fromBase64(v.data[0]) : null;
          amounts.set(p.key, bytes && bytes.length === 8 ? new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true) : null);
        });
      }
    } catch {
      // The balances could not be read: follow everything, exactly as if there were no gate.
      this.stats.asked += pools.length;
      this.stats.passed += pools.length;
      return [...pools];
    }
    const out: MiPool[] = [];
    for (const p of pools) {
      if (!p.quoteVault) {
        out.push(p);
        continue;
      }
      const amount = amounts.get(p.key) ?? null;
      const was = this.seen.get(p.key);
      const changed = amount === null || !was || was.amount !== amount || now - was.followedAt >= this.maxQuietMs;
      if (changed) {
        if (amount !== null) this.staged.set(p.key, amount);
        out.push(p);
      }
    }
    this.stats.asked += pools.length;
    this.stats.passed += out.length;
    this.stats.skipped += pools.length - out.length;
    return out;
  }

  /** Called after a selected pool was followed: `ok` when every transaction it listed was read. */
  settle(poolKey: string, ok: boolean, now: number): void {
    const amount = this.staged.get(poolKey);
    this.staged.delete(poolKey);
    if (ok && amount !== undefined) this.seen.set(poolKey, { amount, followedAt: now });
    else this.seen.delete(poolKey);
  }

  /** Forget everything (tests, or after a long pause). */
  clear(): void {
    this.seen.clear();
    this.staged.clear();
  }

  get size(): number {
    return this.seen.size;
  }
}

const gates = new Map<string, VaultGate>();
/** One gate per name for the life of the process (the worker runs for days; each run of an adapter reuses its gate). */
export const gateFor = (name: string, maxQuietMs?: number): VaultGate => {
  let g = gates.get(name);
  if (!g) {
    g = new VaultGate(maxQuietMs);
    gates.set(name, g);
  }
  return g;
};
