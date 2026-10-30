/**
 * The dashboard's Rising strip: ten tokens whose buyers are growing, each network's best taken in turns, each a link that
 * opens the token in Markets. It reads the same list as the Markets tab and ranks it with the same rule, so the two agree.
 */
import { CHAINS, type ChainId } from '../swings/core/types.js';
import { buyerGrowth, modeRows } from '../swings/market/marketModes.js';
import { compactUsd, formatPrice, type MarketRow } from '../swings/market/types.js';
import { marketsHash } from './tokenPageCore';

const SHOWN = 10;
const WINDOW = 'h1' as const;
const REFRESH_MS = 60_000;

/** The strip's tokens: only those that clear the Rising bar, best first, at most ten. */
export function risingStrip(rows: readonly MarketRow[]): { row: MarketRow; growth: number }[] {
  const ranked = modeRows('rising', WINDOW, rows);
  return ranked.rows.slice(0, Math.min(ranked.count, SHOWN)).map((row) => ({ row, growth: buyerGrowth(row, WINDOW) ?? 0 }));
}

const growthText = (g: number): string => (g >= 10 ? `${Math.round(g)}x` : `${g.toFixed(1)}x`);

export function drawRising(list: HTMLElement, rows: readonly MarketRow[]): void {
  list.textContent = '';
  const strip = risingStrip(rows);
  if (strip.length === 0) {
    const li = document.createElement('li');
    li.className = 'wapp-sub';
    li.textContent = 'No token has clearly rising buyers right now.';
    list.append(li);
    return;
  }
  for (const { row, growth } of strip) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = 'wapp-rise__row';
    a.href = `/wallet${marketsHash(row.chain as ChainId, row.address)}`;
    const name = document.createElement('strong');
    name.textContent = row.symbol;
    const chain = document.createElement('span');
    chain.className = 'wapp-rise__chain';
    chain.textContent = CHAINS[row.chain as ChainId].name;
    const price = document.createElement('span');
    price.className = 'wapp-rise__price';
    price.textContent = `${formatPrice(row.priceUsd)} · ${compactUsd(row.capUsd)}`;
    const g = document.createElement('span');
    g.className = 'wapp-rise__growth';
    g.textContent = `buyers ${growthText(growth)}`;
    a.append(name, chain, price, g);
    li.append(a);
    list.append(li);
  }
}

let lastAt = 0;

/** Loads and draws the strip; skips a second load within a minute. Failure leaves the strip as it was. */
export async function loadRising(list: HTMLElement): Promise<void> {
  if (Date.now() - lastAt < REFRESH_MS && list.childElementCount > 0) return;
  try {
    const res = await fetch(`/api/swings-market?kind=trending&chain=&window=${WINDOW}&recent=1`);
    if (!res.ok) return;
    const body = (await res.json()) as { rows?: MarketRow[] };
    if (!Array.isArray(body.rows)) return;
    lastAt = Date.now();
    drawRising(list, body.rows);
  } catch {
    // Nothing to show is better than a wrong list: the strip keeps what it had.
  }
}
