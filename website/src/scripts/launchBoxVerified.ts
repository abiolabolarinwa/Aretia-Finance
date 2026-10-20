/**
 * Launch Box's Verified badge. It reads the same list and the same rules as every other badge on the site: `verifiedFor(VERIFIED, …)`
 * from src/lib/verified.ts, so an entry that fails a rule (a missing check, a bad date, a bad evidence link) never shows a badge.
 */
import type { LaunchChain } from '../swings/launchbox/core.js';
import { VERIFIED } from '../data/verified';
import { verifiedFor, type VerifiedEntry } from '../lib/verified';

type Check = (chain: LaunchChain, address: string) => boolean;

/** Whether a token carries the badge, from `list` (the site's list by default). */
export function verifiedChecker(list: readonly VerifiedEntry[] = VERIFIED, now: () => number = Date.now): Check {
  return (chain, address) => verifiedFor(list, chain, address, now()) !== null;
}
