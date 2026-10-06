import { isSolanaAddress } from '../../scripts/walletTools.js';
import { hasValidChecksum } from './keccak.js';
import { CHAINS, isChainId, type ChainId, type TokenRef } from './types.js';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** True if `address` is well-formed for `chain`. Does not check that anything exists at it. */
export function isValidAddress(chain: ChainId, address: string): boolean {
  return CHAINS[chain].kind === 'solana' ? isSolanaAddress(address) : EVM_ADDRESS.test(address) && hasValidChecksum(address);
}

/**
 * The one way to build a TokenRef. EVM addresses are lower-cased so the same contract always gets the
 * same key; Solana mints are case-sensitive and left alone. Returns null for anything malformed.
 * Mixed-case EVM addresses must carry a correct EIP-55 checksum; all-lower or all-upper are accepted.
 */
export function normalizeTokenRef(chain: unknown, address: unknown): TokenRef | null {
  if (!isChainId(chain) || typeof address !== 'string') return null;
  const trimmed = address.trim();
  if (!isValidAddress(chain, trimmed)) return null;
  return { chain, address: CHAINS[chain].kind === 'evm' ? trimmed.toLowerCase() : trimmed };
}

/** Stable identity string: `chain:address`. Symbols never take part. */
export const tokenKey = (t: TokenRef): string => `${t.chain}:${t.address}`;

export const sameToken = (a: TokenRef, b: TokenRef): boolean => tokenKey(a) === tokenKey(b);

/** Parses a key made by tokenKey. */
export function parseTokenKey(key: string): TokenRef | null {
  const i = key.indexOf(':');
  return i < 0 ? null : normalizeTokenRef(key.slice(0, i), key.slice(i + 1));
}

/**
 * Guards against fake token metadata: the decimals a token list reports must equal what the mint or
 * contract itself says, because the amount the user typed is converted with them. Returns an error
 * message when they differ, or null when they agree.
 */
export function decimalsMismatch(symbol: string, reported: number, onchain: number): string | null {
  return reported === onchain ? null : `${symbol} reports ${reported} decimals but the token itself uses ${onchain}. The swap was blocked.`;
}
