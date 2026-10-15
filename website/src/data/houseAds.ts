/**
 * Aretia's own adverts for the home-page canvas: shown when no paid sponsor is running (see src/data/sponsors.ts). Each one
 * promotes an Aretia service and links to it. Plain text and a link; nothing is loaded from anywhere else and nothing is tracked.
 *
 * `colors` are four #rrggbb values, lightest to darkest, blended into the background.
 */
import type { ProductKey } from '../lib/logos';

export interface HouseAd {
  id: string;
  product: ProductKey | null;
  headline: string;
  body: string;
  cta: string;
  href: string;
  colors: readonly [string, string, string, string];
}

export const HOUSE_ADS: readonly HouseAd[] = [
  { id: 'marketplace', product: 'marketplace', headline: 'Every market, every chain.', body: 'Browse, rate and trade tokens across nine chains from one wallet.', cta: 'Open Markets', href: '/wallet#/swings', colors: ['#efe9ff', '#a58bff', '#5b3df0', '#1c1160'] },
  { id: 'pay', product: 'pay', headline: 'Send to a name, not an address.', body: 'Pay a .sns name and review every detail before you sign.', cta: 'Send with Pay', href: '/wallet#/send', colors: ['#e6f3ff', '#7fb4ff', '#3a5bf0', '#150681'] },
  { id: 'carbon', product: 'carbon', headline: 'Climate impact you can verify.', body: 'Carbon credits backed by a registry, then retired on the record.', cta: 'See Carbon Credit', href: '/carboncredit', colors: ['#e9fbf0', '#7fdba0', '#1f9d6a', '#0b3b3a'] },
  { id: 'shield', product: 'shield', headline: 'Check before you sign.', body: 'Every send and every token is checked by Aretia Shield first.', cta: 'Open Shield', href: '/wallet#/shield', colors: ['#fff0f5', '#ff9ac1', '#c13cd8', '#2a1470'] },
  { id: 'safesend', product: 'safesend', headline: 'Changed your mind? Cancel it.', body: 'Hold a transfer and cancel it before it lands. Not on mainnet yet.', cta: 'How SafeSend works', href: '/features#safesend', colors: ['#fff7e6', '#ffc27a', '#f0683a', '#3a1470'] },
  { id: 'radar', product: 'radar', headline: 'See the signals early.', body: 'Market and wallet signals, and what could not be found shown as unknown.', cta: 'Open Radar', href: '/wallet#/radar', colors: ['#e8fbff', '#79d7f0', '#2f7be8', '#101a66'] },
  { id: 'advertise', product: null, headline: 'Your brand, right here.', body: 'Reach people while they choose a token. One clear card, no tracking.', cta: 'Advertise with Aretia', href: '/advertise', colors: ['#f3f3f7', '#b9b6d9', '#6a5fc2', '#26168a'] },
];
