/**
 * Names that pretend to be a well-known token. Anyone can call a token "USDC" or "Aretia"; only the real address may carry the
 * name without a warning. The list of real addresses is short on purpose: a token that is missing gets a warning it does not
 * deserve, which is the safe way to be wrong.
 */
import type { ChainId } from '../core/types.js';
import { majorsOf } from '../charts/pool.js';
import { reservedNameClaim } from './safeText.js';

/** Aretia's own token (ACT) on Solana. */
export const ACT_MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';

/** Well-known tokens beyond each chain's stablecoins and wrapped native coin (charts/pool.ts `majorsOf`). Lower-case. */
const KNOWN_EXTRA: Readonly<Partial<Record<ChainId, readonly string[]>>> = {
  solana: [ACT_MINT, '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs' /* Wormhole WETH */, '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh' /* Wormhole WBTC */, 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij' /* cbBTC */].map((a) => a.toLowerCase()),
  ethereum: ['0x2260fac5e5542a773aa44fbcfedf7c193bc2c599' /* WBTC */, '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf' /* cbBTC */],
  bnb: ['0x2170ed0880ac9a755fd29b2688956bd959f933f8' /* ETH */, '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c' /* BTCB */, '0x570a5d26f7765ecb712c0924e4de545b89fd43df' /* SOL */],
  polygon: ['0x7ceb23fd6bc0add59e62ac25578270cff1b9f619' /* WETH */, '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6' /* WBTC */, '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063' /* DAI */],
};

/** Whether the address is one of the well-known tokens Aretia lists by address. */
export function isKnownToken(chain: ChainId, address: string): boolean {
  const a = address.toLowerCase();
  return majorsOf(chain).has(a) || (KNOWN_EXTRA[chain] ?? []).includes(a);
}

/**
 * A warning for a token whose name or symbol is a well-known token's (after undoing look-alike letters) at an address that is
 * not that token's. Null when there is nothing to say.
 */
export function impersonationWarning(chain: ChainId, address: string, symbol: string | null | undefined, name: string | null | undefined): string | null {
  const claim = reservedNameClaim(symbol, name);
  if (!claim || isKnownToken(chain, address)) return null;
  return claim === 'ARETIA'
    ? 'This token uses the Aretia name, but it is not Aretia’s token. Anyone can name a token anything: check the address before you buy.'
    : `This token calls itself ${claim}, but this address is not the ${claim} Aretia knows. Anyone can name a token anything: check the address before you buy.`;
}
