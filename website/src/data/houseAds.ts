/**
 * Aretia's own adverts for the home-page canvas: shown when no paid sponsor is running (see src/data/sponsors.ts). Each one
 * promotes an Aretia service and links to it. Plain text and a link; nothing is loaded from anywhere else and nothing is tracked.
 *
 * `bg` is the flat page colour and `art` the colour of the framed picture beside the words (#rrggbb). `layout` is 'wide' (a landscape
 * frame with the words under it) or 'tall' (a portrait frame with the words beside it); they alternate to keep the page lively.
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
  layout: 'wide' | 'tall';
}

export const HOUSE_ADS: readonly HouseAd[] = [
  { id: 'marketplace', product: 'marketplace', headline: 'Every market, every chain.', body: 'Browse, rate and trade tokens across nine chains from one wallet.', cta: 'Open Markets', href: '/wallet#/swings', bg: '#e4e7fb', art: '#26168a', layout: 'wide' },
  { id: 'pay', product: 'pay', headline: 'Send to a name, not an address.', body: 'Pay a .sns name and review every detail before you sign.', cta: 'Send with Pay', href: '/wallet#/send', bg: '#f6ecb4', art: '#150681', layout: 'tall' },
  { id: 'carbon', product: 'carbon', headline: 'Climate impact you can verify.', body: 'Carbon credits backed by a registry, then retired on the record.', cta: 'See Carbon Credit', href: '/carboncredit', bg: '#d9f1e3', art: '#0b3b3a', layout: 'wide' },
  { id: 'shield', product: 'shield', headline: 'Check before you sign.', body: 'Every send and every token is checked by Aretia Shield first.', cta: 'Open Shield', href: '/wallet#/shield', bg: '#fbe2e6', art: '#2a1470', layout: 'tall' },
  { id: 'safesend', product: 'safesend', headline: 'Changed your mind? Cancel it.', body: 'Hold a transfer and cancel it before it lands. Not on mainnet yet.', cta: 'How SafeSend works', href: '/features#safesend', bg: '#fbe6d4', art: '#3a1470', layout: 'wide' },
  { id: 'radar', product: 'radar', headline: 'See the signals early.', body: 'Market and wallet signals, and what could not be found shown as unknown.', cta: 'Open Radar', href: '/wallet#/radar', bg: '#dcecf9', art: '#101a66', layout: 'tall' },
  { id: 'advertise', product: null, headline: 'Your brand, right here.', body: 'Reach people while they choose a token. One clear card, no tracking.', cta: 'Advertise with Aretia', href: '/advertise', bg: '#e9e9ef', art: '#26168a', layout: 'wide' },
];
