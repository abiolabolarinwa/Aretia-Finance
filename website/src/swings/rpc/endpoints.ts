/**
 * The free public nodes the server-side RPC Pool shares its work among, per network. Server side only: unlike the lists the browser
 * uses (chains/evmSession.ts), these do not have to answer browsers (CORS), so more of them qualify.
 *
 * Each was probed on 2026-10-31 for a block-number read, an old block and a one-thousand-block `eth_getLogs` (Solana: slot, signatures
 * for an address, token accounts). A node that failed, wanted a key, or could not serve a method is listed only where it still serves
 * something the others cannot; the pool learns per node and per method which requests a node refuses and stops sending them there, so
 * a listed node that turns out limited costs a refusal or two, not a failure. Public nodes change their terms: re-probe now and then.
 * Not listed because they asked for a key or were down when probed: Ankr, BlockPi, LlamaRPC, 1RPC (logs), Omniatech, dRPC on BNB.
 */
import type { EndpointInput } from './pool.js';

export type FreeEvmChain = 'ethereum' | 'bnb' | 'polygon' | 'base' | 'robinhood';

export const FREE_EVM_RPC: Readonly<Record<FreeEvmChain, readonly EndpointInput[]>> = {
  ethereum: [
    { url: 'https://ethereum-rpc.publicnode.com', weight: 2 },
    'https://ethereum.publicnode.com',
    'https://rpc.mevblocker.io',
    'https://gateway.tenderly.co/public/mainnet',
    { url: 'https://eth.drpc.org', weight: 0.5 },
    { url: 'https://eth-mainnet.public.blastapi.io', weight: 0.5 },
  ],
  bnb: [
    { url: 'https://bsc-rpc.publicnode.com', weight: 2 },
    { url: 'https://bsc-dataseed.binance.org', weight: 0.3 },
    'https://bsc-dataseed1.defibit.io',
    'https://bsc-dataseed1.ninicoin.io',
    { url: 'https://bsc-mainnet.public.blastapi.io', weight: 0.5 },
  ],
  polygon: [{ url: 'https://polygon-bor-rpc.publicnode.com', weight: 2 }, 'https://gateway.tenderly.co/public/polygon', { url: 'https://polygon.drpc.org', weight: 0.5 }],
  base: [{ url: 'https://base-rpc.publicnode.com', weight: 2 }, 'https://gateway.tenderly.co/public/base', 'https://mainnet.base.org', { url: 'https://base.drpc.org', weight: 0.5 }],
  robinhood: ['https://robinhood-rpc.publicnode.com', 'https://rpc.mainnet.chain.robinhood.com'],
};

/** Solana. The public node of the Solana Foundation serves indexed reads but is strict; publicnode refuses those (the pool learns that). */
export const FREE_SOLANA_RPC: readonly EndpointInput[] = [
  { url: 'https://solana-rpc.publicnode.com', weight: 2 },
  { url: 'https://api.mainnet-beta.solana.com', weight: 1.5, rps: 3 },
  { url: 'https://solana.api.pocket.network', weight: 0.3, rps: 2 },
];
