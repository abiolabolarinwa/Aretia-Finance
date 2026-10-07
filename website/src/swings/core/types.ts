/**
 * Aretia Swings: provider- and chain-agnostic domain types.
 *
 * Nothing in this file (or in swings/router) may import a specific chain library or provider.
 * Token identity is always `chain + address`; a symbol is display text and never a key.
 */

export type ChainId = 'solana' | 'ethereum' | 'bnb' | 'polygon' | 'base' | 'arbitrum' | 'optimism' | 'avalanche';

export interface ChainInfo {
  id: ChainId;
  name: string;
  kind: 'solana' | 'evm';
  /** EIP-155 chain id; null for non-EVM chains. */
  evmChainId: number | null;
  nativeSymbol: string;
  nativeDecimals: number;
  /**
   * Whether swaps can really be executed on this chain today. This is the single switch the UI reads to
   * say "Enabled" or "Not enabled yet"; flip it only when the whole path (wallet, provider, simulation,
   * fee config) works end to end.
   */
  executionEnabled: boolean;
}

export const CHAINS: Readonly<Record<ChainId, ChainInfo>> = {
  solana: { id: 'solana', name: 'Solana', kind: 'solana', evmChainId: null, nativeSymbol: 'SOL', nativeDecimals: 9, executionEnabled: true },
  ethereum: { id: 'ethereum', name: 'Ethereum', kind: 'evm', evmChainId: 1, nativeSymbol: 'ETH', nativeDecimals: 18, executionEnabled: false },
  bnb: { id: 'bnb', name: 'BNB Chain', kind: 'evm', evmChainId: 56, nativeSymbol: 'BNB', nativeDecimals: 18, executionEnabled: false },
  polygon: { id: 'polygon', name: 'Polygon', kind: 'evm', evmChainId: 137, nativeSymbol: 'POL', nativeDecimals: 18, executionEnabled: false },
  base: { id: 'base', name: 'Base', kind: 'evm', evmChainId: 8453, nativeSymbol: 'ETH', nativeDecimals: 18, executionEnabled: false },
  arbitrum: { id: 'arbitrum', name: 'Arbitrum', kind: 'evm', evmChainId: 42161, nativeSymbol: 'ETH', nativeDecimals: 18, executionEnabled: false },
  optimism: { id: 'optimism', name: 'Optimism', kind: 'evm', evmChainId: 10, nativeSymbol: 'ETH', nativeDecimals: 18, executionEnabled: false },
  avalanche: { id: 'avalanche', name: 'Avalanche', kind: 'evm', evmChainId: 43114, nativeSymbol: 'AVAX', nativeDecimals: 18, executionEnabled: false },
};

export const CHAIN_IDS = Object.keys(CHAINS) as ChainId[];

export const isChainId = (value: unknown): value is ChainId => typeof value === 'string' && value in CHAINS;

/** The conventional placeholder address for an EVM chain's native coin in aggregator APIs. */
export const EVM_NATIVE_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
/** Wrapped SOL mint, used as the native SOL address on Solana. */
export const SOLANA_NATIVE_ADDRESS = 'So11111111111111111111111111111111111111112';

export interface TokenRef {
  chain: ChainId;
  /** Solana mint (base58, case-sensitive) or EVM contract address (lower-case 0x…). */
  address: string;
}

export interface WalletAccount {
  chain: ChainId;
  address: string;
}

// ------------------------------------------------------------------ requests and quotes

export interface SwapRequest {
  chain: ChainId;
  from: TokenRef;
  to: TokenRef;
  /** Raw units of `from`, before any Aretia policy. */
  amountIn: bigint;
  slippageBps: number;
  account: WalletAccount;
  /** Optional execution choices the user made on the review screen. Providers that cannot honour them ignore them. */
  execution?: {
    /** Solana: send privately through Jito, with a tip paid inside the signed transaction. */
    protect?: boolean;
    /** The tip in lamports; a default is used when absent. */
    tipLamports?: number;
  };
}

export interface RouteLeg {
  /** Human label of the venue (for example a DEX name), as reported by the provider. Untrusted text. */
  venue: string;
  from: TokenRef;
  to: TokenRef;
  /** Share of the input sent through this leg, in basis points (10000 = all). */
  shareBps: number;
}

export interface Route {
  legs: RouteLeg[];
}

/** An amount of some asset, always in raw units. `asset` is null when the amount is in the swap's own input token. */
export interface Cost {
  amount: bigint;
  asset: TokenRef | null;
}

/**
 * The four things a user pays, kept apart on purpose so none can hide inside another:
 * the intended swap, network cost, provider cost, and the Aretia ACT buyback.
 */
export interface QuoteCosts {
  /** Gas or priority fees. `null` means the provider did not say; never guessed. */
  network: Cost | null;
  /** Fees charged by the DEX or aggregator. `null` when not itemised (they are then inside the output). */
  provider: Cost | null;
  /** The Aretia ACT buyback allocation. Zero when the policy is off. See AretiaBuybackPolicy. */
  aretiaBuyback: Cost;
}

export interface Quote {
  id: string;
  providerId: string;
  request: SwapRequest;
  /** What the provider will swap. Equal to request.amountIn minus nothing: Aretia policy is separate. */
  inAmount: bigint;
  expectedOut: bigint;
  /** The least the user will accept; below this the swap fails on-chain. */
  minOut: bigint;
  /** Provider-reported price impact in basis points, or null if unknown. */
  priceImpactBps: number | null;
  route: Route;
  costs: QuoteCosts;
  fetchedAt: number;
  expiresAt: number;
  /** Provider's own payload, opaque to the router. Only the provider that made it may read it. */
  raw: unknown;
}

// ------------------------------------------------------------------ execution

export type TransactionStatus =
  | 'quoting'
  | 'building'
  | 'simulating'
  | 'awaiting-signature'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'rejected'
  | 'expired';

export const isTerminal = (s: TransactionStatus): boolean => s === 'confirmed' || s === 'failed' || s === 'rejected' || s === 'expired';

export interface SwapExecution {
  id: string;
  quoteId: string;
  chain: ChainId;
  status: TransactionStatus;
  /** Signature (Solana) or hash (EVM), once submitted. */
  txId?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
}

export interface SimulationReport {
  ok: boolean;
  /** Plain-language reasons the swap must not proceed. Empty when ok. */
  blockers: string[];
  /** Things the user should know but that do not stop the swap. */
  warnings: string[];
}

/** A transaction ready for the wallet to sign. Opaque to the router; only its chain adapter reads it. */
export interface PreparedSwap {
  quoteId: string;
  chain: ChainId;
  payload: unknown;
  simulation: SimulationReport;
  preparedAt: number;
}

// ------------------------------------------------------------------ provider and chain interfaces

export class SwingsError extends Error {
  constructor(
    readonly code: 'no-route' | 'provider-failed' | 'expired' | 'invalid' | 'config-missing' | 'not-enabled' | 'rejected' | 'simulation-failed' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'SwingsError';
  }
}

/** A source of executable swaps (a DEX or aggregator). It builds transactions; it never signs or sends. */
export interface DexProvider {
  readonly id: string;
  readonly name: string;
  supports(chain: ChainId): boolean;
  /** True when this provider can carry the Aretia ACT buyback inside the transaction it builds. Aggregator routes cannot. */
  readonly executesBuyback?: boolean;
  getQuote(request: SwapRequest, signal?: AbortSignal): Promise<Quote>;
  /** Builds and checks the transaction for a quote. Throws SwingsError if the quote cannot be executed safely. */
  buildTransaction(quote: Quote): Promise<PreparedSwap>;
}

/** Everything chain-specific the router needs: balances, signing and submission, and status tracking. */
export interface ChainAdapter {
  readonly chain: ChainId;
  /** Raw balance of a token (or the native coin) for an account. */
  getBalance(account: WalletAccount, token: TokenRef): Promise<bigint>;
  /** Asks the user's own wallet to sign, then submits. Resolves to the transaction id. Never retries. */
  signAndSubmit(prepared: PreparedSwap): Promise<string>;
  /** Looks up a submitted transaction. */
  getStatus(txId: string): Promise<TransactionStatus>;
}

// ------------------------------------------------------------------ fee policy

export type FeeMode = 'BUYBACK';

export interface AretiaBuybackPolicy {
  enabled: boolean;
  /** Basis points of the qualifying transaction value (55 = 0.55%). */
  rateBps: number;
  asset: 'ACT';
  mode: FeeMode;
}

export interface AretiaChainFeeConfig {
  chainId: ChainId;
  /** Where treasury-bound funds go. Never defaulted: unset means unset. */
  treasuryAddress?: string;
  /** The contract or account that performs the ACT buyback. */
  buybackExecutorAddress?: string;
  enabled: boolean;
}

export interface AretiaFeeConfig {
  policy: AretiaBuybackPolicy;
  chains: Readonly<Record<ChainId, AretiaChainFeeConfig>>;
}

// ------------------------------------------------------------------ token registry and risk

export type RiskStatus = 'established' | 'new' | 'unverified' | 'verified' | 'elevated' | 'high' | 'restricted' | 'unknown';

export type SignalState = 'ok' | 'warn' | 'bad' | 'unavailable';

export interface RiskSignal {
  id: string;
  label: string;
  state: SignalState;
  /** Evidence in plain words, for example "Mint authority is set". */
  detail: string;
  /** Points added to the risk score when state is warn/bad. Zero for ok/unavailable. */
  weight: number;
}

export interface TokenRisk {
  /** 0 (fewest concerns found) to 100 (most). Null when too few signals were available to score. */
  score: number | null;
  status: RiskStatus;
  signals: RiskSignal[];
  /** Signals that could not be evaluated. Listed, never guessed. */
  unavailable: string[];
  assessedAt: number;
}

export type DiscoveryStatus = 'discovered' | 'tradable';

export interface TokenRecord {
  ref: TokenRef;
  symbol: string;
  name: string;
  decimals: number;
  logo: string | null;
  /** When Aretia first detected it, and from which source. Never invented. */
  firstDetectedAt: number;
  discoverySource: string;
  /** On-chain creation time when known. */
  createdAt: number | null;
  /** When the first trading pool appeared, from the discovery source. Not the same as token creation. */
  firstPoolAt: number | null;
  discoveryStatus: DiscoveryStatus;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  holderCount: number | null;
  pools: { venue: string; address: string }[];
  /** Contract/program facts (owner, authorities, proxy). Untrusted until checked. */
  metadata: Record<string, string | number | boolean | null>;
  verified: boolean;
  /** How far the symbol/name/decimals can be trusted: 'onchain' beats 'api'. */
  metadataConfidence: 'onchain' | 'api' | 'unknown';
  risk: TokenRisk | null;
  updatedAt: number;
}
