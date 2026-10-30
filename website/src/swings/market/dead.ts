import type { MarketRow } from './types.js';

/** A price change at or below this counts as the price having gone to nothing. The feeds round a total loss to -100%. */
const WIPED_OUT = -99.5;

/**
 * A token whose price is down about 100% over the last hour, six hours and day has no market left (its pool was emptied or the price
 * fell to zero), so listing it only wastes the reader's time. The five-minute change is left out on purpose: a pool nobody has traded
 * for five minutes reads 0% there, even on a dead token. A window the source did not report counts as "not dead", so a row with
 * missing numbers is never hidden by mistake.
 */
export function isDeadMarket(r: Pick<MarketRow, 'change'>): boolean {
  const { h1, h6, h24 } = r.change;
  return h1 !== null && h6 !== null && h24 !== null && h1 <= WIPED_OUT && h6 <= WIPED_OUT && h24 <= WIPED_OUT;
}
