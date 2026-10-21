/**
 * Remembers that Aretia's fee for a move was paid on its own (an EVM source sends it as a separate transaction before the burn)
 * while the burn that it paid for has not confirmed yet. A retry of the same move, even under a new quote and a new execution
 * (for example after the burn failed, was declined, or the quote expired in between), then does not charge the fee again.
 *
 * Keyed by what was paid for, not by quote: source chain, sender and amount entered. An entry is written once the fee transaction
 * confirms and removed only when the burn it paid for confirms; otherwise it lapses after MOVE_FEE_PAID_WINDOW_MS. Kept in
 * sessionStorage when there is one (it survives a reload of the tab), and in memory as well. Only the owner's own tab reads it: a
 * forged entry could only skip a fee, never send anything anywhere.
 */
import type { SettlementIntent } from '../settlement/types.js';

/** How long a fee paid for a move whose burn did not confirm still counts for a retry of the same move. */
export const MOVE_FEE_PAID_WINDOW_MS = 30 * 60_000;
const STORAGE_KEY = 'aretia.swings.moveFeePaid';

export interface FeeLedgerStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const sessionStore = (): FeeLedgerStore | null => {
  try {
    const st = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    return st ? { get: (k) => st.getItem(k), set: (k, v) => st.setItem(k, v) } : null;
  } catch {
    return null;
  }
};

interface Entry {
  at: number;
  hash: string;
}

/** The key a paid fee is remembered under: what was paid for, never which quote paid it. */
export const moveFeeKey = (intent: Pick<SettlementIntent, 'sourceChain' | 'sender' | 'sourceAmount'>): string => `${intent.sourceChain}:${intent.sourceChain === 'solana' ? intent.sender : intent.sender.toLowerCase()}:${intent.sourceAmount}`;

export class MoveFeeLedger {
  private readonly memory = new Map<string, Entry>();
  private readonly store: FeeLedgerStore | null;

  /** `store` undefined = sessionStorage when there is one; null = memory only. */
  constructor(store?: FeeLedgerStore | null, private readonly now: () => number = Date.now) {
    this.store = store === undefined ? sessionStore() : store;
  }

  private read(): Record<string, Entry> {
    const t = this.now();
    let saved: unknown;
    try {
      saved = JSON.parse(this.store?.get(STORAGE_KEY) ?? 'null');
    } catch {
      saved = null;
    }
    const out: Record<string, Entry> = {};
    for (const [k, v] of [...Object.entries(typeof saved === 'object' && saved !== null ? (saved as Record<string, unknown>) : {}), ...this.memory.entries()]) {
      const e = v as Partial<Entry> | null;
      if (e && typeof e.at === 'number' && typeof e.hash === 'string' && t - e.at < MOVE_FEE_PAID_WINDOW_MS) out[k] = { at: e.at, hash: e.hash };
    }
    return out;
  }

  private write(all: Record<string, Entry>): void {
    try {
      this.store?.set(STORAGE_KEY, JSON.stringify(all));
    } catch {
      // Storage full or blocked: the in-memory record still covers this page.
    }
  }

  /** The fee transaction already paid for this move, if one is remembered and still within its window. */
  paid(key: string): string | null {
    return this.read()[key]?.hash ?? null;
  }

  markPaid(key: string, hash: string): void {
    const all = this.read();
    all[key] = { at: this.now(), hash };
    this.memory.set(key, all[key]);
    this.write(all);
  }

  /** Called only when the burn the fee paid for has confirmed. */
  clear(key: string): void {
    const all = this.read();
    delete all[key];
    this.memory.delete(key);
    this.write(all);
  }
}
