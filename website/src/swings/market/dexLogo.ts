/**
 * The exchange a pool is on, as a logo instead of a name. The name an index row carries ("Uniswap V3", "Raydium CPMM") is matched
 * to the family; an exchange with no logo file gets its first letter in a circle, and the full name stays in the tooltip.
 */
const LOGOS: [RegExp, string][] = [
  [/uniswap/i, 'uniswap'],
  [/pancake/i, 'pancakeswap'],
  [/sushi/i, 'sushiswap'],
  [/raydium/i, 'raydium'],
  [/orca/i, 'orca'],
  [/aerodrome/i, 'aerodrome'],
  [/quickswap/i, 'quickswap'],
  [/pump/i, 'pump'],
];

/** The logo file of the exchange a venue name belongs to, or null when there is none. */
export function dexLogoSrc(venue: string | undefined | null): string | null {
  if (!venue) return null;
  const hit = LOGOS.find(([re]) => re.test(venue));
  return hit ? `/assets/dex/${hit[1]}.png` : null;
}

/** The letter shown for an exchange with no logo file. */
export const dexInitial = (venue: string): string => (venue.trim()[0] ?? '?').toUpperCase();
