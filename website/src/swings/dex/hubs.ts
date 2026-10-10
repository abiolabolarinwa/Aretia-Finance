/**
 * Intermediate tokens the router may hop through on each chain: the wrapped native coin and the main stablecoins.
 * Real token contracts, lower-case. `npm run test:live` reads each one's symbol and decimals from the chain, so a
 * wrong address fails a test instead of reaching a user. This list only widens route search; it never changes a
 * user's chosen tokens.
 */
import type { ChainId } from '../core/types.js';
import { WRAPPED_NATIVE } from './entries.js';

export interface HubToken {
  address: string;
  symbol: string;
  decimals: number;
}

export const HUB_TOKENS: Readonly<Partial<Record<ChainId, readonly HubToken[]>>> = {
  ethereum: [
    { address: WRAPPED_NATIVE.ethereum, symbol: 'WETH', decimals: 18 },
    { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6 },
    { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', decimals: 6 },
    { address: '0x6b175474e89094c44da98b954eedeac495271d0f', symbol: 'DAI', decimals: 18 },
  ],
  bnb: [
    { address: WRAPPED_NATIVE.bnb, symbol: 'WBNB', decimals: 18 },
    { address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT', decimals: 18 },
    { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', symbol: 'USDC', decimals: 18 },
  ],
  polygon: [
    { address: WRAPPED_NATIVE.polygon, symbol: 'WMATIC', decimals: 18 },
    { address: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', symbol: 'USDC', decimals: 6 },
    { address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', symbol: 'USDC', decimals: 6 },
    { address: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', symbol: 'USDT', decimals: 6 },
  ],
  base: [
    { address: WRAPPED_NATIVE.base, symbol: 'WETH', decimals: 18 },
    { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
  ],
  arbitrum: [
    { address: WRAPPED_NATIVE.arbitrum, symbol: 'WETH', decimals: 18 },
    { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', decimals: 6 },
    { address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', symbol: 'USDT', decimals: 6 },
  ],
  optimism: [
    { address: WRAPPED_NATIVE.optimism, symbol: 'WETH', decimals: 18 },
    { address: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', symbol: 'USDC', decimals: 6 },
    { address: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', symbol: 'USDT', decimals: 6 },
  ],
  // Robinhood Chain: wrapped ether only, which Uniswap's own V3 router and V4 position manager name as their WETH. Its stablecoins are
  // not listed until each address has been read from the chain.
  robinhood: [{ address: WRAPPED_NATIVE.robinhood, symbol: 'WETH', decimals: 18 }],
  avalanche: [
    { address: WRAPPED_NATIVE.avalanche, symbol: 'WAVAX', decimals: 18 },
    { address: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', symbol: 'USDC', decimals: 6 },
    { address: '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', symbol: 'USDT', decimals: 6 },
  ],
};
