/**
 * The sponsors showing in the wallet right now. This list is edited by hand: when a sponsorship is agreed, add an entry;
 * when it ends, it stops showing on its own after its last day (and can be deleted later).
 *
 * Each entry is checked before it is shown (see src/lib/sponsors.ts): an https link, short text, valid dates. An entry
 * that fails a check is skipped, never shown half-formed. While the list is empty the slots show Aretia's own
 * "Sponsor space" card, which points to /advertise. On the home page, while no sponsor is running for 'home-canvas', Aretia's
 * own adverts (src/data/houseAds.ts) fill the background; once one runs, only sponsors show there.
 *
 * Example, for reference (not live):
 *
 *   {
 *     id: 'example-2026-11',
 *     advertiser: 'Example Climate Fund',
 *     headline: 'Fund a verified project',
 *     body: 'Back a registry-listed reforestation project directly.',
 *     cta: 'See the project',
 *     href: 'https://example.org/project',
 *     image: '/assets/sponsors/example.png',   // optional, https or under /assets/sponsors/
 *     slots: ['token-panel', 'market-footer', 'home-canvas'],   // 'home-canvas' is the full-page background of the home page
 *     gradient: ['#ffffff', '#ffcc00', '#ff6600', '#330000'],   // optional, home-canvas only: 2 to 4 colours, light to dark
 *     chains: ['solana'],                        // optional: only beside tokens on these chains
 *     from: '2026-11-01',
 *     to: '2026-11-30',
 *   },
 */
import type { Sponsor } from '../lib/sponsors';

export const SPONSORS: readonly Sponsor[] = [];
