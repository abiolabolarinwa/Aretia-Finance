/**
 * Launch Box's Verified badge. It uses the verified-tokens data module (src/data/verified.ts) when that file exists in the build, and shows no
 * badge when it does not. The module is found at build time, so Launch Box never breaks because of it.
 */
import type { LaunchChain } from '../swings/launchbox/core.js';

type Check = (chain: LaunchChain, address: string) => boolean;

const modules = import.meta.glob('../data/verified.ts', { eager: true }) as Record<string, Record<string, unknown>>;

/** The module's `isVerified(chain, address)`, or null when there is no module or it has no such function. */
export function verifiedChecker(mods: Record<string, Record<string, unknown>> = modules): Check | null {
  const mod = Object.values(mods)[0];
  const fn = mod?.isVerified;
  if (typeof fn !== 'function') return null;
  return (chain, address) => {
    try {
      return (fn as (c: string, a: string) => unknown)(chain, address) === true;
    } catch {
      return false;
    }
  };
}
