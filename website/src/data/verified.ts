/**
 * Tokens that carry the "Verified by Aretia" badge. Edited by hand, after the checks are run (website/docs/verified-badge.md).
 * The list is empty until Aretia has actually verified a token: nothing here is a placeholder, and nothing is added on request alone.
 *
 * To add a token: run `node scripts/verify-token.mjs <chain> <address>`, check the project link and the pool by hand, publish the
 * evidence (the script's output and notes) at an https address, then add an entry. An entry that fails the rules in
 * src/lib/verified.ts is skipped, never shown half-formed.
 *
 * Other code reads it with `verifiedFor(VERIFIED, chain, address)` (src/lib/verified.ts) or draws the badge with
 * `verifiedBadge(chain, address)` (src/lib/verifiedBadge.ts), which returns null for a token that is not on the list.
 *
 * Example, for reference (not live):
 *
 *   {
 *     token: '<the token address>',
 *     chain: 'solana',                       // 'solana' | 'bnb' | 'ethereum' | 'polygon'
 *     date: '2026-11-02',                    // the day the checks were run
 *     checked: ['supply-fixed', 'powers-given-up', 'identity-matches', 'pool-locked'],
 *     evidence: 'https://aretiafinance.org/docs/verified/example.txt',
 *     label: 'EXAMPLE',                      // optional
 *   },
 */
import type { VerifiedEntry } from '../lib/verified';

export const VERIFIED: readonly VerifiedEntry[] = [];
