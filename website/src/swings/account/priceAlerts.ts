/**
 * Price alerts for favourite tokens. A favourite has a baseline price: the price when it was starred, or when it last
 * raised an alert. When the price has moved from that baseline by at least the chosen percentage, an alert is raised and
 * the baseline moves to the new price, so a token alerts again only after a further move of the same size.
 *
 * Everything here is pure or browser-local. Alerts are worked out in the page while it is open: nothing watches prices
 * for a closed page, and nothing is sent anywhere.
 */
import type { StorageLike } from '../history.js';
import type { ChainId } from '../core/types.js';

export const PCT_CHOICES = [2, 5, 10, 20] as const;
export const DEFAULT_PCT = 5;
const KEY = 'aretia-alerts-v1';
const LOG_MAX = 20;

export interface WatchedPrice {
  chain: ChainId;
  address: string;
  symbol: string;
  icon: string | null;
  /** Null when the source did not give a price: such a token is skipped, never treated as zero. */
  priceUsd: number | null;
}

export interface PriceAlert {
  key: string;
  chain: ChainId;
  address: string;
  symbol: string;
  icon: string | null;
  price: number;
  baseline: number;
  /** Signed percentage move from the baseline. */
  movePct: number;
  at: number;
}

export const watchKey = (chain: string, address: string): string => `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`;

/**
 * Compares each watched token's price with its baseline. A token seen for the first time gets a baseline and no alert.
 * Baselines of tokens that are no longer watched are dropped. Alerts come back largest move first.
 */
export function evaluateMoves(items: readonly WatchedPrice[], baselines: Readonly<Record<string, number>>, pct: number, now: number): { alerts: PriceAlert[]; baselines: Record<string, number> } {
  const next: Record<string, number> = {};
  const alerts: PriceAlert[] = [];
  for (const it of items) {
    const key = watchKey(it.chain, it.address);
    const base = baselines[key];
    const price = it.priceUsd;
    if (price === null || !Number.isFinite(price) || price <= 0) {
      // No usable price now: keep what we had, say nothing.
      if (base !== undefined) next[key] = base;
      continue;
    }
    if (base === undefined || !(base > 0)) {
      next[key] = price;
      continue;
    }
    const move = ((price - base) / base) * 100;
    if (Math.abs(move) >= pct) {
      alerts.push({ key, chain: it.chain, address: it.address, symbol: it.symbol, icon: it.icon, price, baseline: base, movePct: move, at: now });
      next[key] = price;
    } else next[key] = base;
  }
  alerts.sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct));
  return { alerts, baselines: next };
}

interface Saved {
  pct: number;
  baselines: Record<string, number>;
  log: PriceAlert[];
}

/** The person's alert choice, the baselines and the recent alerts, kept in this browser. */
export class AlertStore {
  constructor(private readonly storage: StorageLike | null) {}

  private read(): Saved {
    try {
      const raw = this.storage?.getItem(KEY);
      const v = raw ? (JSON.parse(raw) as Partial<Saved>) : {};
      const pct = typeof v.pct === 'number' && (PCT_CHOICES as readonly number[]).includes(v.pct) ? v.pct : DEFAULT_PCT;
      const baselines: Record<string, number> = {};
      if (v.baselines && typeof v.baselines === 'object') for (const [k, n] of Object.entries(v.baselines)) if (typeof n === 'number' && n > 0 && Number.isFinite(n)) baselines[k] = n;
      const log = Array.isArray(v.log) ? v.log.filter((a): a is PriceAlert => !!a && typeof a.key === 'string' && typeof a.movePct === 'number' && typeof a.price === 'number' && typeof a.at === 'number').slice(0, LOG_MAX) : [];
      return { pct, baselines, log };
    } catch {
      return { pct: DEFAULT_PCT, baselines: {}, log: [] };
    }
  }

  private write(s: Saved): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(s));
    } catch {
      // not remembered: alerts still work for this visit
    }
  }

  pct(): number {
    return this.read().pct;
  }

  setPct(pct: number): void {
    if (!(PCT_CHOICES as readonly number[]).includes(pct)) return;
    this.write({ ...this.read(), pct });
  }

  baselines(): Record<string, number> {
    return this.read().baselines;
  }

  /** A newly starred token starts watching from the price it has now. */
  startWatching(chain: string, address: string, price: number | null): void {
    if (price === null || !(price > 0)) return;
    const s = this.read();
    s.baselines[watchKey(chain, address)] = price;
    this.write(s);
  }

  stopWatching(chain: string, address: string): void {
    const s = this.read();
    delete s.baselines[watchKey(chain, address)];
    this.write(s);
  }

  /** Saves the outcome of one round of checks. */
  record(baselines: Record<string, number>, alerts: readonly PriceAlert[]): void {
    const s = this.read();
    this.write({ ...s, baselines, log: [...alerts, ...s.log].slice(0, LOG_MAX) });
  }

  log(): PriceAlert[] {
    return this.read().log;
  }
}
