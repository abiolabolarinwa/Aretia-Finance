/**
 * Turns a Solana pool address into a `TrackedPool`: which two tokens it holds, in which two token accounts, with what
 * decimals, and which token is priced in which. It reads the pool account and parses it with the same parsers the
 * routers use, so a venue the router can trade is a venue the indexer can follow.
 *
 * Orientation: the quote is the stablecoin if there is one (USDC, then USDT), else wrapped SOL, else the pool's
 * second token. So ACT/USDC is ACT priced in USDC, and SOL/USDC is SOL priced in USDC.
 */
import type * as Web3 from '@solana/web3.js';
import { SwingsError } from '../core/types.js';
import { METEORA_DAMM_V2_PROGRAM, parseDammPool } from '../solana/meteoraDamm.js';
import { METEORA_DLMM_PROGRAM, parseDlmmPair } from '../solana/meteoraDlmm.js';
import { ORCA_WHIRLPOOL_PROGRAM, parseWhirlpool } from '../solana/orcaWhirlpool.js';
import { parsePumpPool, PUMPSWAP_PROGRAM } from '../solana/pumpswap.js';
import { parsePoolState, RAYDIUM_CPMM_PROGRAM, type SolRpc } from '../solana/raydiumCpmm.js';
import type { TrackedPool } from './swaps.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
/** Quote preference, best first. */
const QUOTE_ORDER = [USDC, USDT, WSOL];

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

interface Parsed {
  venue: string;
  mintA: string;
  mintB: string;
  vaultA: string;
  vaultB: string;
}

function parseAny(web3: typeof Web3, owner: string, data: Uint8Array): Parsed | null {
  if (owner === RAYDIUM_CPMM_PROGRAM) {
    const s = parsePoolState(web3, data);
    return s && { venue: 'raydium-cpmm', mintA: s.token0Mint, mintB: s.token1Mint, vaultA: s.token0Vault, vaultB: s.token1Vault };
  }
  if (owner === METEORA_DAMM_V2_PROGRAM) {
    const s = parseDammPool(web3, data);
    return s && { venue: 'meteora-damm-v2', mintA: s.tokenAMint, mintB: s.tokenBMint, vaultA: s.tokenAVault, vaultB: s.tokenBVault };
  }
  if (owner === ORCA_WHIRLPOOL_PROGRAM) {
    const s = parseWhirlpool(web3, data);
    return s && { venue: 'orca-whirlpool', mintA: s.mintA, mintB: s.mintB, vaultA: s.vaultA, vaultB: s.vaultB };
  }
  if (owner === PUMPSWAP_PROGRAM) {
    const s = parsePumpPool(web3, data);
    return s && { venue: 'pumpswap', mintA: s.baseMint, mintB: s.quoteMint, vaultA: s.baseVault, vaultB: s.quoteVault };
  }
  if (owner === METEORA_DLMM_PROGRAM) {
    const s = parseDlmmPair(web3, data);
    return s && { venue: 'meteora-dlmm', mintA: s.mintX, mintB: s.mintY, vaultA: s.reserveX, vaultB: s.reserveY };
  }
  return null;
}

/** Decimals from a mint account (the same offset for the classic Token program and Token-2022). */
const mintDecimals = (data: Uint8Array | null): number | null => (data && data.length >= 82 && data[44]! <= 18 ? data[44]! : null);

export async function resolveSolanaPool(web3: typeof Web3, rpc: SolRpc, address: string): Promise<TrackedPool> {
  const [acc] = (await rpc<{ value: ({ data: [string, string]; owner: string } | null)[] }>('getMultipleAccounts', [[address], { encoding: 'base64', commitment: 'confirmed' }])).value;
  if (!acc) throw new SwingsError('no-route', 'That pool does not exist.');
  const parsed = parseAny(web3, acc.owner, fromBase64(acc.data[0]));
  if (!parsed) throw new SwingsError('invalid', 'That is not a pool on a venue Aretia can follow.');
  const quoteIsA = (() => {
    const rank = (m: string): number => {
      const i = QUOTE_ORDER.indexOf(m);
      return i < 0 ? 99 : i;
    };
    // Lower rank is the better quote. Ties, and pools with no major token, price the first token in the second.
    return rank(parsed.mintA) < rank(parsed.mintB);
  })();
  const base = quoteIsA ? { mint: parsed.mintB, vault: parsed.vaultB } : { mint: parsed.mintA, vault: parsed.vaultA };
  const quote = quoteIsA ? { mint: parsed.mintA, vault: parsed.vaultA } : { mint: parsed.mintB, vault: parsed.vaultB };
  const mints = (await rpc<{ value: ({ data: [string, string] } | null)[] }>('getMultipleAccounts', [[base.mint, quote.mint], { encoding: 'base64', commitment: 'confirmed' }])).value;
  const bd = mintDecimals(mints[0] ? fromBase64(mints[0].data[0]) : null);
  const qd = mintDecimals(mints[1] ? fromBase64(mints[1].data[0]) : null);
  if (bd === null || qd === null) throw new SwingsError('provider-failed', 'The pool\'s token decimals could not be read.');
  return { chain: 'solana', pool: address, venue: parsed.venue, baseMint: base.mint, quoteMint: quote.mint, baseDecimals: bd, quoteDecimals: qd, baseVault: base.vault, quoteVault: quote.vault };
}
