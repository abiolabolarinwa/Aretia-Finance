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
  // Two leaves, the larger with a vein, the smaller tucked in front of it: carbon credits.
  carbon:
    `<path d="M26 10C38 21 42 36 28 51C19 50 12 42 13 32C14 24 20 17 26 10Z" fill="${WHITE}"/>` +
    `<path d="M26 19L28 40" fill="none" stroke="${TILE}" stroke-width="2.2" stroke-linecap="round"/>` +
    `<path d="M53 28C53 42 44 51 30 50C29 41 37 30 53 28Z" fill="${ACCENT}" stroke="${TILE}" stroke-width="2.4" stroke-linejoin="round"/>` +
    `<path d="M50 31L36 46" fill="none" stroke="${TILE}" stroke-width="1.8" stroke-linecap="round"/>`,
  // Candlesticks across a baseline: a marketplace. Alternating highs and lows, as in the supplied mark.
  marketplace:
    `<path d="M8 32h48" fill="none" stroke="${ACCENT}" stroke-width="1.8" stroke-linecap="round"/>` +
    [[15, 25], [23.5, 19], [32, 25], [40.5, 19], [49, 25]].map(([c, y]) => `<rect x="${c! - 3.2}" y="${y}" width="6.4" height="19" rx="1.6" fill="${WHITE}"/>`).join(''),
  // A solid shield with a keyhole and a few cracks: held against attack.
  shield:
    `<path d="M32 9L50 15V30C50 41 42.5 49 32 54C21.5 49 14 41 14 30V15Z" fill="${WHITE}"/>` +
    `<circle cx="32" cy="28.5" r="5" fill="${TILE}"/><path d="M29.5 31.5H34.5L36.5 42H27.5Z" fill="${TILE}"/>` +
    `<path d="M15.5 18L21 24.5L18.5 28.5M43.5 13.5L41.5 20M50 33.5L44 36.5M21 47L26 45" fill="none" stroke="${TILE}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  // A web (spider) chart: two rings, six spokes and a filled reading across them.
  radar:
    `<path d="M32 11L50.2 21.5V42.5L32 53L13.8 42.5V21.5Z M32 21.5L41.1 26.8V37.3L32 42.5L22.9 37.3V26.8Z M32 32L32 11M32 32L50.2 21.5M32 32L50.2 42.5M32 32L32 53M32 32L13.8 42.5M32 32L13.8 21.5" fill="none" stroke="${WHITE}" stroke-opacity=".7" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<path d="M32 16L43.3 25.5L46.7 40.5L32 42L19 39.5L21.6 26Z" fill="${ACCENT}" fill-opacity=".7" stroke="${WHITE}" stroke-width="1.8" stroke-linejoin="round"/>`,
};

export const markSvg = (k: ProductKey, size = 64): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${PRODUCT_NAMES[k]}"><rect width="64" height="64" rx="16" fill="${TILE}"/>${GLYPHS[k]}</svg>`;

/** Colours for the bare mark (no tile): a main colour for the white sticks and an accent for the lavender one, each clear on white. */
export const BARE: Record<ProductKey, { main: string; accent: string }> = {
  wallet: { main: '#3a22c8', accent: '#f5a524' },
  swap: { main: '#0f7ae5', accent: '#14b8a6' },
  pay: { main: '#5b3df0', accent: '#ec4899' },
  safesend: { main: '#0f9d58', accent: '#3a22c8' },
  market: { main: '#e11d48', accent: '#3a22c8' },
  carbon: { main: '#16a34a', accent: '#65a30d' },
  marketplace: { main: '#7c3aed', accent: '#f59e0b' },
  shield: { main: '#2563eb', accent: '#10b981' },
  radar: { main: '#0891b2', accent: '#7c3aed' },
};
