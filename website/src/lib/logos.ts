export type ProductKey = 'wallet' | 'swap' | 'pay' | 'safesend' | 'market' | 'carbon' | 'marketplace' | 'shield' | 'radar';

export const PRODUCT_NAMES: Record<ProductKey, string> = {
  wallet: 'Aretia Wallet',
  swap: 'Aretia Swap',
  pay: 'Aretia Pay',
  safesend: 'Aretia SafeSend',
  market: 'Aretia Market',
  carbon: 'Aretia Carbon Credit',
  marketplace: 'Aretia Marketplace',
  shield: 'Aretia Shield',
  radar: 'Aretia Radar',
};

/**
 * Six marks in one family. Each is a rounded tile in the brand indigo with a
 * glyph drawn from round-capped "sticks" -- the same construction as the
 * Aretia mark itself -- in white, with one stick picked out in lavender.
 * viewBox is 64x64; stroke 5. Colours are literals so the exported .svg files
 * work anywhere.
 */
export const TILE = '#150681';
export const WHITE = '#ffffff';
export const ACCENT = '#b8b0ff';

const s = (d: string, c = WHITE) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;

export const GLYPHS: Record<ProductKey, string> = {
  // A wallet: body, a slanted flap stick, and a clasp.
  wallet: s('M17 25h30a4 4 0 0 1 4 4v15a4 4 0 0 1-4 4H17a4 4 0 0 1-4-4V29a4 4 0 0 1 4-4Z') + s('M19 25l22-10') + `<circle cx="42" cy="36.5" r="3.4" fill="${ACCENT}"/>`,
  // Two opposing arrows: swapping one thing for another.
  swap: s('M14 24h33M40 16l8 8-8 8') + s('M50 41H17M24 33l-8 8 8 8', ACCENT),
  // The Aretia chevron, doubled: value on its way.
  pay: s('M17 17l15 15-15 15') + s('M33 17l15 15-15 15', ACCENT),
  // A shield with a check: held and checked before it moves.
  safesend: s('M32 11l17 6v14c0 11-7.5 18-17 22-9.5-4-17-11-17-22V17Z') + s('M24 32.5l6 6 10-12', ACCENT),
  // Three sticks rising: a market.
  market: s('M18 48V37') + s('M32 48V25', ACCENT) + s('M46 48V14'),
  // A leaf with its vein: carbon credits.
  carbon: s('M47 15C28 15 16 25 16 39c0 3 .8 6 2 8 14 0 29-8 29-32Z') + s('M20 44l14-14', ACCENT),
  // Candlesticks across a baseline: a marketplace. Alternating highs and lows, as in the supplied mark.
  marketplace:
    `<path d="M8 32h48" fill="none" stroke="${ACCENT}" stroke-width="1.8" stroke-linecap="round"/>` +
    [[15, 25], [23.5, 19], [32, 25], [40.5, 19], [49, 25]].map(([c, y]) => `<rect x="${c! - 3.2}" y="${y}" width="6.4" height="19" rx="1.6" fill="${WHITE}"/>`).join(''),
  // A shield with a bar across it: checked before you sign.
  shield: s('M32 11l17 6v14c0 11-7.5 18-17 22-9.5-4-17-11-17-22V17Z') + s('M32 23v14', ACCENT),
  // A web (spider) chart: two rings, six spokes and a filled reading across them.
  radar:
    `<path d="M32 11L50.2 21.5V42.5L32 53L13.8 42.5V21.5Z M32 21.5L41.1 26.8V37.3L32 42.5L22.9 37.3V26.8Z M32 32L32 11M32 32L50.2 21.5M32 32L50.2 42.5M32 32L32 53M32 32L13.8 42.5M32 32L13.8 21.5" fill="none" stroke="${WHITE}" stroke-opacity=".7" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<path d="M32 16L43.3 25.5L46.7 40.5L32 42L19 39.5L21.6 26Z" fill="${ACCENT}" fill-opacity=".7" stroke="${WHITE}" stroke-width="1.8" stroke-linejoin="round"/>`,
};

export const markSvg = (k: ProductKey, size = 64): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${PRODUCT_NAMES[k]}"><rect width="64" height="64" rx="16" fill="${TILE}"/>${GLYPHS[k]}</svg>`;
