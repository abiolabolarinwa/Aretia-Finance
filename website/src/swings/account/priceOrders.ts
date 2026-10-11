/**
 * Price orders: "tell me when this token reaches my price so I can buy or sell it". An order is only a watch. It is checked
 * in the page while the page is open, and when the price is reached the person is told; nothing is bought or sold until
 * they open the swap and confirm it themselves. Nothing here is sent anywhere.
 */
import type { StorageLike } from '../history.js';
import type { ChainId } from '../core/types.js';
import { watchKey } from './priceAlerts.js';

const KEY = 'aretia-price-orders-v1';
export const ORDER_MAX = 20;

export type OrderSide = 'buy' | 'sell';

export interface PriceOrder {
  id: string;
  chain: ChainId;
  address: string;
  symbol: string;
  name: string;
  icon: string | null;
  side: OrderSide;
  /** The price in US dollars at which the person wants to be told. */
  targetUsd: number;
  createdAt: number;
  /** Set when the price was reached; the order then stops watching. */
  hitAt: number | null;
  hitPrice: number | null;
}

export type NewPriceOrder = Pick<PriceOrder, 'chain' | 'address' | 'symbol' | 'name' | 'icon' | 'side' | 'targetUsd'>;

/** A buy waits for the price to fall to the target; a sell waits for it to rise to it. */
export const reached = (side: OrderSide, price: number, target: number): boolean => (side === 'buy' ? price <= target : price >= target);

/** Which watching orders the given prices have reached. A token with no usable price is skipped, never read as zero. */
export function evaluateOrders(orders: readonly PriceOrder[], prices: Readonly<Record<string, number | null>>): { order: PriceOrder; price: number }[] {
  const hits: { order: PriceOrder; price: number }[] = [];
  for (const order of orders) {
    if (order.hitAt !== null) continue;
    const price = prices[watchKey(order.chain, order.address)];
    if (price === null || price === undefined || !Number.isFinite(price) || price <= 0) continue;
    if (reached(order.side, price, order.targetUsd)) hits.push({ order, price });
  }
  return hits;
}

/** Reads what a person typed as a price: plain digits with an optional $ and commas. Null if it is not a positive number. */
export function parseTarget(text: string): number | null {
  const n = Number(text.trim().replace(/^\$/, '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function valid(o: unknown): o is PriceOrder {
  if (!o || typeof o !== 'object') return false;
  const v = o as Record<string, unknown>;
  return (
    typeof v.id === 'string' && typeof v.chain === 'string' && typeof v.address === 'string' && typeof v.symbol === 'string' && typeof v.name === 'string' &&
    (v.icon === null || typeof v.icon === 'string') && (v.side === 'buy' || v.side === 'sell') && typeof v.targetUsd === 'number' && v.targetUsd > 0 && Number.isFinite(v.targetUsd) &&
    typeof v.createdAt === 'number' && (v.hitAt === null || typeof v.hitAt === 'number') && (v.hitPrice === null || typeof v.hitPrice === 'number')
  );
}

export class PriceOrderStore {
  private seq = 0;
  constructor(private readonly storage: StorageLike | null, private readonly now: () => number = Date.now) {}

  list(): PriceOrder[] {
    try {
      const raw = this.storage?.getItem(KEY);
      const v: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(v) ? v.filter(valid).slice(0, ORDER_MAX) : [];
    } catch {
      return [];
    }
  }

  private write(items: PriceOrder[]): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(items.slice(0, ORDER_MAX)));
    } catch {
      // not remembered: the orders still work for this visit
    }
  }

  /** Adds one at the top. Returns null if the price is not a positive number or there are already too many. */
  add(n: NewPriceOrder): PriceOrder | null {
    const items = this.list();
    if (!(n.targetUsd > 0) || !Number.isFinite(n.targetUsd) || items.length >= ORDER_MAX) return null;
    const at = this.now();
    const order: PriceOrder = { ...n, id: `${at.toString(36)}-${(this.seq++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`, createdAt: at, hitAt: null, hitPrice: null };
    this.write([order, ...items]);
    return order;
  }

  remove(id: string): void {
    this.write(this.list().filter((o) => o.id !== id));
  }

  markHit(id: string, price: number): void {
    this.write(this.list().map((o) => (o.id === id && o.hitAt === null ? { ...o, hitAt: this.now(), hitPrice: price } : o)));
  }

  watching(): PriceOrder[] {
    return this.list().filter((o) => o.hitAt === null);
  }
}
