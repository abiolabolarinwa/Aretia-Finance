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
  /**
   * Leave this token out of Uniswap V4 two-pool routes. Set only where the real routers were seen to refuse them (see the
   * Robinhood entry); V2 and V3 routes still use it.
   */
  skipV4?: boolean;
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
  // Robinhood Chain. Both addresses are in Robinhood's own token contracts list, and USDG's is in Paxos's documentation too; symbol,
  // name and decimals were read from the chain. USDG (Global Dollar, issued by Paxos) is the only stablecoin Robinhood lists: it
  // lists no USDC or USDT, so none is added.
  // skipV4 on USDG: a V4 route of two pools through USDG (native ETH, then USDG, then a stock token) was priced by the V4 quoter but
  // reverted, with no reason, on the real Universal Router, for 3 of 3 tokens tried (SPY, NVDA, BB) and on both Universal Routers
  // Robinhood lists, while single-pool V4 routes and two-hop V3 routes through USDG are accepted. Until the cause is known, V4 does
  // not route through USDG. Remove the flag, and run robinhood.live.ts, to try again.
  robinhood: [
    { address: WRAPPED_NATIVE.robinhood, symbol: 'WETH', decimals: 18 },
    { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', decimals: 6, skipV4: true },
  ],
  avalanche: [
    { address: WRAPPED_NATIVE.avalanche, symbol: 'WAVAX', decimals: 18 },
    { address: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', symbol: 'USDC', decimals: 6 },
    { address: '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', symbol: 'USDT', decimals: 6 },
  ],
};
