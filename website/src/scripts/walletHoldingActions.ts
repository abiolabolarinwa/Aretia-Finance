/**
 * "Buy more" and "Sell" on a dashboard holding. Both open the swap with the token chosen: Buy as the token to receive, Sell as the token
 * to pay with. The dashboard only describes the token and fires an event; the swap page does the rest.
 */
import { CHAIN_IDS, EVM_NATIVE_ADDRESS, isChainId, type ChainId } from '../swings/core/types.js';

export const SWAP_TOKEN_EVENT = 'aretia:swap-token';

export interface SwapTokenRequest {
  chain: ChainId;
  /** The contract address, the mint on Solana, or the native placeholder for a network's own coin. */
  address: string;
  symbol: string;
  name: string;
  icon: string | null;
  /** Null when the dashboard does not know it; the swap reads it from the chain. */
  decimals: number | null;
  side: 'buy' | 'sell';
}

const EVM_MINT = /^([a-z0-9]+):(native|0x[0-9a-fA-F]{40})$/;

/**
 * Which network and address a dashboard holding is. Ethereum-style holdings are keyed `<network>:native` or `<network>:<contract>`;
 * anything else is a Solana mint. Null for a key that is neither.
 */
export function swapTargetFor(h: { mint: string }): { chain: ChainId; address: string } | null {
  const m = EVM_MINT.exec(h.mint);
  if (m) {
    const chain = m[1]!;
    if (!isChainId(chain) || chain === 'solana') return null;
    return { chain, address: m[2] === 'native' ? EVM_NATIVE_ADDRESS : m[2]!.toLowerCase() };
  }
  // A Solana mint is base58, 32 to 44 characters.
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(h.mint) ? { chain: 'solana', address: h.mint } : null;
}

export function swapRequestFor(h: { mint: string; symbol: string; name: string; icon: string | null; decimals: number | null }, side: 'buy' | 'sell'): SwapTokenRequest | null {
  const t = swapTargetFor(h);
  if (!t || !CHAIN_IDS.includes(t.chain)) return null;
  return { ...t, symbol: h.symbol, name: h.name, icon: h.icon, decimals: h.decimals, side };
}

export function requestSwap(req: SwapTokenRequest): void {
  window.dispatchEvent(new CustomEvent<SwapTokenRequest>(SWAP_TOKEN_EVENT, { detail: req }));
}
