export type ProductKey = 'wallet' | 'swap' | 'pay' | 'safesend' | 'market' | 'carbon' | 'swings' | 'shield' | 'radar';

export const PRODUCT_NAMES: Record<ProductKey, string> = {
  wallet: 'Aretia Wallet',
  swap: 'Aretia Swap',
  pay: 'Aretia Pay',
  safesend: 'Aretia SafeSend',
  market: 'Aretia Market',
  carbon: 'Aretia Carbon Credit',
  swings: 'Aretia Swings',
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
  // A swing's arc between two posts: value carried across chains.
  swings: s('M14 16h36') + s('M22 16l6 25M42 16l-6 25') + s('M22 46h20', ACCENT),
  // A shield with a bar across it: checked before you sign.
  shield: s('M32 11l17 6v14c0 11-7.5 18-17 22-9.5-4-17-11-17-22V17Z') + s('M32 23v14', ACCENT),
  // A radar sweep: concentric arcs and a blip.
  radar: s('M13 42a22 22 0 0 1 38 0') + s('M22 42a12 12 0 0 1 20 0', ACCENT) + `<circle cx="32" cy="46" r="3.4" fill="${WHITE}"/>`,
};

export const markSvg = (k: ProductKey, size = 64): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${PRODUCT_NAMES[k]}"><rect width="64" height="64" rx="16" fill="${TILE}"/>${GLYPHS[k]}</svg>`;
