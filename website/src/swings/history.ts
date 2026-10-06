/**
 * Swap history for the Activity tab. Kept only in this browser (localStorage), never sent anywhere, and
 * tied to the wallet address it belongs to so another wallet in the same browser does not see it.
 * Storage can be unavailable (private windows, blocked site data), so every access is guarded and the
 * app works without it.
 */
import type { ChainId, TransactionStatus } from './core/types.js';

export interface HistoryItem {
  id: string;
  at: number;
  account: string;
  chain: ChainId;
  provider: string;
  fromSymbol: string;
  toSymbol: string;
  /** Human-readable amounts, as shown to the user. */
  amountIn: string;
  expectedOut: string;
  txId: string | null;
  status: TransactionStatus;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = 'aretia-swings-history-v1';
const MAX = 100;
const STATUSES: TransactionStatus[] = ['quoting', 'building', 'simulating', 'awaiting-signature', 'submitted', 'confirmed', 'failed', 'rejected', 'expired'];

const valid = (v: unknown): v is HistoryItem => {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.at === 'number' &&
    typeof o.account === 'string' &&
    typeof o.chain === 'string' &&
    typeof o.provider === 'string' &&
    typeof o.fromSymbol === 'string' &&
    typeof o.toSymbol === 'string' &&
    typeof o.amountIn === 'string' &&
    typeof o.expectedOut === 'string' &&
    (o.txId === null || typeof o.txId === 'string') &&
    STATUSES.includes(o.status as TransactionStatus)
  );
};

export class SwapHistory {
  constructor(private readonly storage: StorageLike | null) {}

  private read(): HistoryItem[] {
    try {
      const raw = this.storage?.getItem(KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(valid) : [];
    } catch {
      return [];
    }
  }

  private write(items: HistoryItem[]): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(items.slice(0, MAX)));
    } catch {
      // Not saved: history is a convenience only.
    }
  }

  list(account: string | null): HistoryItem[] {
    if (!account) return [];
    return this.read()
      .filter((i) => i.account.toLowerCase() === account.toLowerCase())
      .sort((a, b) => b.at - a.at);
  }

  /** Adds or replaces by id. */
  save(item: HistoryItem): void {
    this.write([item, ...this.read().filter((i) => i.id !== item.id)]);
  }

  setStatus(id: string, status: TransactionStatus): void {
    this.write(this.read().map((i) => (i.id === id ? { ...i, status } : i)));
  }
}

export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
