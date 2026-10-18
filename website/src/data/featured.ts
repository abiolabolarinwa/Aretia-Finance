/**
 * The featured launches showing inside the Aretia web wallet (the Markets list and the Launch page) right now. Edited by hand when a placement is agreed.
 * The list is empty until one is: while it is, the strip is not drawn at all. An item stops showing on its own after its last day
 * (and can be deleted later). It also needs to pass the rules in src/lib/featured.ts, or it is skipped, never shown half-formed.
 *
 * Nothing is charged automatically. A placement is agreed and priced in writing first (see the "Get featured" form at /featured).
 *
 * Example, for reference (not live):
 *
 *   {
 *     id: 'example-2026-11',
 *     token: '<the token address>',
 *     chain: 'solana',                       // 'solana' | 'bnb' | 'ethereum' | 'polygon'
 *     title: 'Example Token',                // up to 60 characters
 *     blurb: 'One plain line about what it is.',   // up to 140 characters
 *     image: '/assets/featured/example.png', // optional, https or under /assets/featured/
 *     from: '2026-11-01',
 *     to: '2026-11-14',
 *   },
 */
import type { FeaturedItem } from '../lib/featured';

export const FEATURED: readonly FeaturedItem[] = [];
