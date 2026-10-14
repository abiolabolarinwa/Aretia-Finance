/**
 * The browser tab's title for a token, written the way trading screens write theirs, so the tab says what is open and
 * the price when you look at it from another tab: "Frank $0.0003613 - Frank Ashford / SOL on Solana / PumpSwap - Aretia Finance".
 */

/** A price in plain digits (no subscript zeros, which tab titles show badly): four significant figures for small prices. */
export function titlePrice(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n <= 0) return '';
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (n >= 1) return `$${n.toFixed(n >= 100 ? 2 : 4).replace(/0+$/, '').replace(/\.$/, '')}`;
  const decimals = Math.min(12, Math.max(4, 3 - Math.floor(Math.log10(n))));
  return `$${n.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '')}`;
}

// eslint-disable-next-line no-control-regex
const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);

/** "Pancakeswap" from "pancakeswap" (and "uniswap" to "Uniswap"); left as it is when it already has capitals. */
const dexName = (d: string): string => (d === d.toLowerCase() ? d.charAt(0).toUpperCase() + d.slice(1) : d);

export interface TitleToken {
  symbol: string;
  name: string;
  quoteSymbol: string;
  chainName: string;
  dex: string | null;
  priceUsd: number | null;
}

/** The tab title for a selected token. */
export function tokenTitle(t: TitleToken, site = 'Aretia Finance'): string {
  const symbol = clean(t.symbol) || 'Token';
  const price = titlePrice(t.priceUsd);
  const name = clean(t.name) || symbol;
  const pair = `${name}${t.quoteSymbol ? ` / ${clean(t.quoteSymbol)}` : ''} on ${t.chainName}${t.dex ? ` / ${dexName(clean(t.dex))}` : ''}`;
  return `${symbol}${price ? ` ${price}` : ''} - ${pair} - ${site}`;
}
