/**
 * Aretia's own adverts for the home-page canvas: shown when no paid sponsor is running (see src/data/sponsors.ts). They
 * promote Aretia's services and the chains and markets Aretia works with. Plain text and a link; nothing is tracked.
 *
 * - Naming a coin or a chain here is not an endorsement by it, and none of them is an advertiser. The copy says only what
 *   Aretia does (browse, rate, trade, check), never what the coin or chain will do.
 * - `chart` art is a made-up illustration (see src/lib/adArt.ts) and is captioned as one. Never put real prices on it.
 * - `image` is for a photograph (for example from Unsplash). It must be an https address; give the photographer in `credit`.
 *
 * `bg` is the flat page colour and `art` the colour of the framed picture beside the words (#rrggbb). `layout` is 'wide' (a
 * landscape frame with the words under it), 'tall' (a portrait frame with the words beside it) or 'duo' (two frames, one above the
 * other, with the words beside them) or 'poster' (one picture that fills the whole canvas, with the words over its empty left side).
 */
import type { ProductKey } from '../lib/logos';

export interface HouseAd {
  id: string;
  product: ProductKey | null;
  headline: string;
  body: string;
  cta: string;
  href: string;
  bg: string;
  art: string;
  layout: 'wide' | 'tall' | 'duo' | 'poster';
  chart?: { seed: number; style: 'candles' | 'line'; up: boolean };
  /** A round mark on the picture: a symbol, or a logo file. */
  mark?: { text?: string; logo?: string; label: string; bg: string; fg?: string };
  image?: { src: string; alt: string; credit?: string };
}

export const HOUSE_ADS: readonly HouseAd[] = [
  { id: 'treasury', product: null, headline: 'Aretia Treasury', body: 'Managing climate needs financing: weather forecasting, flood alerting and earthquake detection, funded by every ACT transfer.', cta: 'Explore the Treasury', href: '/details', bg: '#c4d7e6', art: '#c4d7e6', layout: 'poster', image: { src: '/images/hero/treasury.webp', alt: 'A firefighting helicopter dropping water, a warning siren and a weathervane, in rounded frames' } },
  { id: 'charts', product: null, headline: 'Read the chart before you trade.', body: 'Every token in Markets opens with its chart and its Aretia rating, side by side.', cta: 'Open Markets', href: '/wallet#/swings', bg: '#e4e7fb', art: '#26168a', layout: 'wide', chart: { seed: 21, style: 'candles', up: true } },
  { id: 'bitcoin', product: null, headline: 'Bitcoin, on the chains you already use.', body: 'Find wrapped Bitcoin markets on Solana, Ethereum and more, and check each token before you trade it.', cta: 'Find a market', href: '/wallet#/swings', bg: '#fbe9d0', art: '#2b1a05', layout: 'tall', chart: { seed: 8, style: 'line', up: true }, mark: { text: '₿', label: 'Bitcoin symbol', bg: '#f7931a', fg: '#ffffff' } },
  { id: 'solana', product: null, headline: 'Solana moves fast. Check before you sign.', body: 'Trade Solana tokens with the rating, the liquidity and the safety check beside every one.', cta: 'Open Markets', href: '/wallet#/swings', bg: '#e6e3fb', art: '#14102e', layout: 'duo', chart: { seed: 33, style: 'line', up: true }, mark: { logo: '/assets/chains/solana.png', label: 'Solana', bg: '#ffffff' } },
  { id: 'ethereum', product: null, headline: 'Ethereum and its layers, in one wallet.', body: 'Ethereum, Base, Arbitrum and Optimism together: one balance view, one swap screen.', cta: 'Open Aretia Wallet', href: '/wallet', bg: '#e8ecf6', art: '#1b2540', layout: 'wide', chart: { seed: 14, style: 'candles', up: false }, mark: { logo: '/assets/chains/ethereum.png', label: 'Ethereum', bg: '#ffffff' } },
  { id: 'pay', product: 'pay', headline: 'Send to a name, not an address.', body: 'Pay a .sns name and review every detail before you sign.', cta: 'Send with Pay', href: '/wallet#/send', bg: '#f6ecb4', art: '#150681', layout: 'tall' },
  { id: 'new-tokens', product: null, headline: 'Watch new tokens as they appear.', body: 'The wallet island shows newly created tokens on every chain, with their price and liquidity.', cta: 'See what is new', href: '/wallet#/swings', bg: '#d9f1e3', art: '#0b3b3a', layout: 'duo', chart: { seed: 47, style: 'candles', up: true }, mark: { text: 'NEW', label: 'New', bg: '#ffffff', fg: '#0b3b3a' } },
  { id: 'carbon', product: 'carbon', headline: 'Climate impact you can verify.', body: 'Carbon credits backed by a registry, then retired on the record.', cta: 'See Carbon Credit', href: '/carboncredit', bg: '#dcefd9', art: '#123b22', layout: 'wide' },
  { id: 'shield', product: 'shield', headline: 'Check before you sign.', body: 'Every send and every token is checked by Aretia Shield first.', cta: 'Open Shield', href: '/wallet#/shield', bg: '#fbe2e6', art: '#2a1470', layout: 'tall' },
  { id: 'radar', product: 'radar', headline: 'See the signals early.', body: 'Market and wallet signals, and what could not be found shown as unknown.', cta: 'Open Radar', href: '/wallet#/radar', bg: '#dcecf9', art: '#101a66', layout: 'wide', chart: { seed: 5, style: 'line', up: true } },
  { id: 'advertise', product: null, headline: 'Your brand, right here.', body: 'Reach people while they choose a token. One clear card, no tracking.', cta: 'Advertise with Aretia', href: '/advertise', bg: '#e9e9ef', art: '#26168a', layout: 'tall' },
];
