import { CHAINS, type ChainId } from '../swings/core/types.js';
import { normalizeTokenRef } from '../swings/core/token.js';

/**
 * The wallet page's hash routing, kept in a file of its own. tokenPageCore pulls in the curve, pool and launch code, which the page's first
 * screen does not need; the page only has to know which view the address points at.
 */

/** Markets with a token open: "#/swings/<chain>/<address>", so the address is in the link and the link opens the same token. */
export const marketsHash = (chain: ChainId, address: string): string => `#/swings/${chain}/${CHAINS[chain].kind === 'evm' ? address.toLowerCase() : address}`;

/**
 * Where the wallet page is, as the hash its router reads. A hash in the address wins ("#/send"); with none, a clean token
 * path ("/wallet/<chain>/<address>") means Markets with that token, which is the same as "#/swings/<chain>/<address>".
 */
export function routeHash(pathname: string, hash: string): string {
  if (hash && hash !== '#') return hash;
  const m = /^\/wallet\/([a-z]+)\/([A-Za-z0-9]+)\/?$/.exec(pathname);
  if (!m) return hash;
  const ref = normalizeTokenRef(m[1], m[2]);
  return ref ? marketsHash(ref.chain, ref.address) : hash;
}
