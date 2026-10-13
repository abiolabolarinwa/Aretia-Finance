/**
 * Which messages a person is owed right now. Pure: given what they watch (favourites with a baseline, price orders) and
 * today's prices, it says what to send and what to remember afterwards. The same rules as the page's own alerts: a
 * favourite is reported when it has moved the chosen percentage from its baseline (and then the baseline moves), and a
 * price order is reported once, when its price is reached.
 */
import type { ChainId } from '../core/types.js';
import { evaluateMoves, watchKey, type WatchedPrice } from '../account/priceAlerts.js';
import { evaluateOrders, type PriceOrder } from '../account/priceOrders.js';
import { formatPrice } from '../market/types.js';

export interface WatchedFavourite {
  chain: ChainId;
  address: string;
  symbol: string;
  icon: string | null;
}

export interface OwnerWatch {
  movePct: number;
  favourites: readonly WatchedFavourite[];
  orders: readonly PriceOrder[];
  /** Baselines kept from earlier runs, by `watchKey`. */
  baselines: Readonly<Record<string, number>>;
}

export interface PlannedMessage {
  kind: 'move' | 'order';
  title: string;
  body: string;
  /** A path on this site that opens the token's page. */
  url: string;
}

export interface OwnerPlan {
  messages: PlannedMessage[];
  /** The baselines to keep (replaces what was kept). */
  baselines: Record<string, number>;
  /** Orders whose price was reached, to be marked so they are not sent again. */
  hitOrders: { id: string; price: number }[];
}

/** More than this many messages in one run is shown as one line: a busy market must not flood a phone. */
export const MAX_MESSAGES_PER_RUN = 5;

export function planForOwner(w: OwnerWatch, prices: Readonly<Record<string, number | null>>, now: number, max = MAX_MESSAGES_PER_RUN): OwnerPlan {
  const items: WatchedPrice[] = w.favourites.map((f) => ({ chain: f.chain, address: f.address, symbol: f.symbol, icon: f.icon, priceUsd: prices[watchKey(f.chain, f.address)] ?? null }));
  const moves = evaluateMoves(items, w.baselines, w.movePct, now);
  const hits = evaluateOrders(w.orders, prices);

  const all: PlannedMessage[] = [
    ...hits.map(({ order, price }): PlannedMessage => ({ kind: 'order', title: `${order.symbol} reached ${formatPrice(order.targetUsd)}`, body: `Your ${order.side} price. Now ${formatPrice(price)}.`, url: '/wallet#/swings' })),
    ...moves.alerts.map((a): PlannedMessage => ({ kind: 'move', title: `${a.symbol} ${a.movePct > 0 ? '▲ +' : '▼ '}${a.movePct.toFixed(1)}%`, body: `${formatPrice(a.price)}, was ${formatPrice(a.baseline)}`, url: '/wallet#/favourites' })),
  ];
  const messages = all.slice(0, max);
  if (all.length > max) messages.push({ kind: 'move', title: `${all.length - max} more price alerts`, body: 'Open Aretia to see all of them.', url: '/wallet#/favourites' });
  return { messages, baselines: moves.baselines, hitOrders: hits.map((h) => ({ id: h.order.id, price: h.price })) };
}

/** The plain text sent to Telegram: a bell, the title, the numbers, and a link. */
export function telegramText(m: PlannedMessage, origin: string): string {
  return `🔔 ${m.title}\n${m.body}\n${origin}${m.url}`;
}
