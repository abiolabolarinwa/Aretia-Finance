/**
 * The chain registry of the Market Indexer. Configuration, not code: a chain is a row here, and what the indexer does on it
 * follows from the adapters registered for it (dexes.ts). A chain is only called supported when an adapter with evidence exists.
 */
import { CHAINS, type ChainId } from '../core/types.js';
import { HUB_TOKENS } from '../dex/hubs.js';
import { WRAPPED_NATIVE } from '../dex/entries.js';
import { PUBLIC_EVM_RPC, BACKUP_EVM_RPC } from '../chains/evmSession.js';

/** The networks the indexer covers. Robinhood Chain needs migration 0019 (the tables' chain check) before its adapter is switched on. */
export const MI_CHAINS = ['solana', 'ethereum', 'base', 'bnb', 'polygon', 'robinhood'] as const satisfies readonly ChainId[];
export type MiChain = (typeof MI_CHAINS)[number];
export const isMiChain = (v: unknown): v is MiChain => typeof v === 'string' && (MI_CHAINS as readonly string[]).includes(v);

export type EvmMiChain = Exclude<MiChain, 'solana'>;
export const EVM_MI_CHAINS = MI_CHAINS.filter((c): c is EvmMiChain => c !== 'solana');

export interface QuoteToken {
  address: string;
  symbol: string;
  decimals: number;
  /** 'usd': one token is one dollar for ranking purposes (a major stablecoin). 'native': the chain's wrapped native coin. */
  role: 'usd' | 'native';
}

export interface MiChainConfig {
  id: MiChain;
  name: string;
  kind: 'solana' | 'evm';
  /** Blocks a log must be buried under before it is trusted. Deeper where a chain reorganises more. */
  confirmations: number;
  /** Blocks read per getLogs call at most. */
  maxRange: number;
  /** Pool addresses per getLogs call. Public nodes allow 10; a paid node can take more (MI_ADDRESS_BATCH_<CHAIN>). */
  addressBatch: number;
  /** On the first run, how many blocks back to start. */
  lookback: number;
  quoteTokens: readonly QuoteToken[];
  rpcUrls: readonly string[];
}

const USD_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'USDG']);

/** Uniswap V4 pools hold the chain's own coin as address zero; it is the native quote just as the wrapped coin is. */
export const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';

const quotesOf = (chain: EvmMiChain): QuoteToken[] => [
  ...(HUB_TOKENS[chain] ?? []).map((h) => ({
    address: h.address,
    symbol: h.symbol,
    decimals: h.decimals,
    role: (h.address === WRAPPED_NATIVE[chain] ? 'native' : USD_SYMBOLS.has(h.symbol) ? 'usd' : 'native') as QuoteToken['role'],
  })),
  { address: NATIVE_ADDRESS, symbol: CHAINS[chain].nativeSymbol, decimals: CHAINS[chain].nativeDecimals, role: 'native' as const },
];

/** Reorg-safety depth per chain. Conservative; an operator can raise it with MI_CONFIRMATIONS_<CHAIN>. */
const CONFIRMATIONS: Readonly<Record<EvmMiChain, number>> = { ethereum: 12, bnb: 15, polygon: 64, base: 10, robinhood: 20 };
const MAX_RANGE: Readonly<Record<EvmMiChain, number>> = { ethereum: 500, bnb: 1000, polygon: 1000, base: 1000, robinhood: 1000 };

const SOLANA_QUOTES: readonly QuoteToken[] = [
  { address: 'So11111111111111111111111111111111111111112', symbol: 'WSOL', decimals: 9, role: 'native' },
  { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6, role: 'usd' },
  { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', decimals: 6, role: 'usd' },
];
const SOLANA_PUBLIC_RPC = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];

export function chainConfig(chain: MiChain, env: Record<string, string | undefined> = {}): MiChainConfig {
  if (chain === 'solana') {
    const own = (env.MI_RPC_SOLANA ?? env.SOLANA_RPC_URL)?.trim();
    // Only finalized transactions are read, so there is no confirmation depth; `lookback` is seconds of history to read on the first run.
    return { id: 'solana', name: CHAINS.solana.name, kind: 'solana', confirmations: 0, maxRange: 0, addressBatch: 0, lookback: 3_600, quoteTokens: SOLANA_QUOTES, rpcUrls: [...(own && /^https:\/\/[^\s]+$/.test(own) ? [own] : []), ...SOLANA_PUBLIC_RPC] };
  }
  const upper = chain.toUpperCase();
  // MI_RPC_<CHAIN> wins; otherwise the node the token registry already uses (EVM_RPC_<CHAIN>) is reused.
  const override = (env[`MI_RPC_${upper}`] ?? env[`EVM_RPC_${upper}`])?.trim();
  const confirmations = Number(env[`MI_CONFIRMATIONS_${upper}`]);
  const batch = Number(env[`MI_ADDRESS_BATCH_${upper}`]);
  return {
    id: chain,
    name: CHAINS[chain].name,
    kind: 'evm',
    confirmations: Number.isInteger(confirmations) && confirmations >= 0 && confirmations <= 1000 ? confirmations : CONFIRMATIONS[chain],
    maxRange: MAX_RANGE[chain],
    addressBatch: Number.isInteger(batch) && batch >= 1 && batch <= 200 ? batch : 10,
    lookback: 300,
    quoteTokens: quotesOf(chain),
    // A configured node comes first (server-side secret, may carry a key); the public ones are the fallback.
    rpcUrls: [...(override && /^https:\/\/[^\s]+$/.test(override) ? [override] : []), PUBLIC_EVM_RPC[chain], ...(BACKUP_EVM_RPC[chain] ?? [])],
  };
}

export function quoteOf(chain: MiChain, address: string, env: Record<string, string | undefined> = {}): QuoteToken | null {
  return chainConfig(chain, env).quoteTokens.find((q) => q.address === address.toLowerCase()) ?? null;
}
