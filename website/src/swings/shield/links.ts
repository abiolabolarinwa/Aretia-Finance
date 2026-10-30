import type { ChainId } from '../core/types.js';

/** Where to read an address on each network's block explorer. */
export const ADDRESS_URL: Readonly<Record<ChainId, string>> = {
  solana: 'https://solscan.io/account/',
  ethereum: 'https://etherscan.io/address/',
  bnb: 'https://bscscan.com/address/',
  polygon: 'https://polygonscan.com/address/',
  base: 'https://basescan.org/address/',
  robinhood: 'https://robinhoodchain.blockscout.com/address/',
};

export const TOKEN_URL: Readonly<Record<ChainId, string>> = {
  solana: 'https://solscan.io/token/',
  ethereum: 'https://etherscan.io/token/',
  bnb: 'https://bscscan.com/token/',
  polygon: 'https://polygonscan.com/token/',
  base: 'https://basescan.org/token/',
  robinhood: 'https://robinhoodchain.blockscout.com/token/',
};

export const addressUrl = (chain: ChainId, address: string): string => ADDRESS_URL[chain] + encodeURIComponent(address);
export const tokenUrl = (chain: ChainId, address: string): string => TOKEN_URL[chain] + encodeURIComponent(address);
