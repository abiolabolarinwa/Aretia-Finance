/**
 * Favourite tokens. Kept in this browser always (so they work before anyone signs in), and joined with the copy saved to
 * the wallet address when the person signs in. A favourite is a pointer to a token, not a recommendation.
 */
import type { StorageLike } from '../history.js';
import { CHAIN_IDS, type ChainId } from '../core/types.js';

export interface Favourite {
  chain: ChainId;
  address: string;
  symbol: string;
  name: string;
  icon: string | null;
  addedAt: number;
}

const KEY = 'aretia-favourites-v1';
const MAX = 500;

const norm = (chain: ChainId, address: string): string => (chain === 'solana' ? address : address.toLowerCase());
const same = (a: { chain: string; address: string }, chain: ChainId, address: string): boolean => a.chain === chain && norm(a.chain as ChainId, a.address) === norm(chain, address);

const valid = (v: unknown): v is Favourite => {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.chain === 'string' && (CHAIN_IDS as readonly string[]).includes(o.chain) && typeof o.address === 'string' && o.address.length >= 20 && typeof o.symbol === 'string' && typeof o.name === 'string' && (o.icon === null || typeof o.icon === 'string') && typeof o.addedAt === 'number';
};

export class FavouriteStore {
  private listeners: (() => void)[] = [];

  constructor(private readonly storage: StorageLike | null) {}

  list(): Favourite[] {
    try {
      const raw = this.storage?.getItem(KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return (Array.isArray(parsed) ? parsed.filter(valid) : []).sort((a, b) => b.addedAt - a.addedAt);
    } catch {
      return [];
    }
  }

  private write(items: Favourite[]): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(items.slice(0, MAX)));
    } catch {
      // not saved: favourites are a convenience
    }
    for (const l of this.listeners) l();
  }

  has(chain: ChainId, address: string): boolean {
    return this.list().some((f) => same(f, chain, address));
  }

  /** Adds the token if it is not a favourite, removes it if it is. Returns whether it is a favourite now. */
  toggle(fav: Omit<Favourite, 'addedAt'>, now: number = Date.now()): boolean {
    const all = this.list();
    if (all.some((f) => same(f, fav.chain, fav.address))) {
      this.write(all.filter((f) => !same(f, fav.chain, fav.address)));
      return false;
    }
    this.write([{ ...fav, addedAt: now }, ...all]);
    return true;
  }

  /** Joins favourites saved to the wallet with these ones; a token in both keeps the earlier date. Returns the ones only this device had. */
  merge(saved: Favourite[]): Favourite[] {
    const local = this.list();
    const joined = new Map<string, Favourite>();
    for (const f of [...saved.filter(valid), ...local]) {
      const k = `${f.chain}:${norm(f.chain, f.address)}`;
      const prev = joined.get(k);
      if (!prev || f.addedAt < prev.addedAt) joined.set(k, f);
    }
    this.write([...joined.values()].sort((a, b) => b.addedAt - a.addedAt));
    return local.filter((f) => !saved.some((s) => same(s, f.chain, f.address)));
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }
}
