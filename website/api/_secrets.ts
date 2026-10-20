/**
 * Comparing secrets in constant time. Both sides are hashed first, so neither their contents nor their lengths can be learned
 * from how long a comparison takes.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** True when `given` equals `expected`. A missing or empty expected secret never matches. */
export function sameSecret(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/** True when an `Authorization` header is exactly `Bearer <secret>`. */
export function bearerMatches(authorization: string | null | undefined, secret: string | null | undefined): boolean {
  if (!secret) return false;
  return sameSecret(authorization ?? '', `Bearer ${secret}`);
}
