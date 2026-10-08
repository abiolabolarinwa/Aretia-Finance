/**
 * The wallet domain of Aretia Swings: one interface every wallet sits behind, and the session that describes a
 * connected wallet. Nothing here holds, creates, exports or stores keys or seed phrases: every signature happens inside
 * the user's own wallet, and Swings only ever sees public addresses and the signed result.
 *
 * Why one interface: the router, the execution engine and the UI should not care whether the user is on Phantom,
 * MetaMask, Aretia Wallet or a hardware wallet behind any of them. They ask a `WalletAdapter` for an address, a
 * balance, a signature, and they check the wallet's session before they trust any of it.
 *
 * How this relates to what already exists (it reuses, it does not duplicate):
 *  - Solana: the Aretia Wallet page already hosts every Solana wallet (Wallet Standard wallets such as Phantom,
 *    Solflare, Backpack, and Ledger through them) behind `window.AretiaWallet`. `SolanaContextWallet` wraps that.
 *  - EVM: `evmWallet.ts` already discovers EIP-6963 wallets and speaks EIP-1193. `EvmBridgeWallet` wraps that.
 */
import type * as Web3 from '@solana/web3.js';
import type { ChainId, TokenRef } from '../core/types.js';
import type { EvmTxRequest } from '../chains/evmWallet.js';

export type ChainType = 'solana' | 'evm';

/** An asset on a chain. The native coin is the conventional native address (see `isNativeAsset`). */
export type AssetId = TokenRef;

export interface Balance {
  asset: AssetId;
  /** Raw units. */
  amount: bigint;
  decimals: number;
  /** Ms epoch when it was read. A balance is a reading, not a fact: it goes stale. */
  readAt: number;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** What a wallet can do. Anything it cannot do is false, never assumed. */
export interface WalletCapabilities {
  signMessage: boolean;
  /** Can sign a transaction and hand it back without sending it. Most EVM wallets cannot. */
  signWithoutSending: boolean;
  /** The wallet can be asked to change network (EVM). Solana wallets sit on one cluster. */
  switchNetwork: boolean;
  /** The wallet exposes more than one account to the page. */
  multipleAccounts: boolean;
  /** The wallet announces account and network changes, so the session can be kept fresh without polling. */
  emitsChanges: boolean;
}

export interface WalletSession {
  /** A stable id for the provider: 'aretia-solana', or the EIP-6963 `rdns`. */
  providerId: string;
  providerName: string;
  chainType: ChainType;
  /** The active account on the active chain. Null while disconnected. */
  address: string | null;
  /** Every account the wallet exposes to the page, active first. */
  accounts: string[];
  /** The Swings chain the wallet is on. Null if the wallet is on a network Swings does not support. */
  chain: ChainId | null;
  /** The wallet's own network id: the EVM chain id, or null on Solana (one cluster). */
  networkId: number | null;
  state: ConnectionState;
  capabilities: WalletCapabilities;
  connectedAt: number | null;
  /** Bumped on every change, so a consumer can tell that what it read earlier is no longer current. */
  revision: number;
}

export type UnsignedTransaction =
  | { kind: 'solana'; transaction: Web3.VersionedTransaction | Web3.Transaction }
  | { kind: 'evm'; tx: EvmTxRequest; chainId: number };

export type SignedTransaction =
  | { kind: 'solana'; transaction: Web3.VersionedTransaction | Web3.Transaction; serialized: Uint8Array }
  | { kind: 'evm'; raw: string };

export type TransactionHash = string;
export type Signature = Uint8Array | string;

/** Why the session changed. */
export type SessionChange = 'connected' | 'disconnected' | 'account-changed' | 'network-changed' | 'capabilities-changed' | 'error';

export interface WalletAdapter {
  readonly providerId: string;
  readonly providerName: string;
  readonly chainType: ChainType;

  /** Asks the wallet to connect (the wallet shows its own prompt). Resolves to the session. */
  connect(): Promise<WalletSession>;
  /**
   * Reattaches to a wallet that is already authorised for this page (after a reload) WITHOUT showing any prompt.
   * Resolves to the session if the wallet is still connected, or null if it is not (never a prompt, never an error).
   */
  restore(): Promise<WalletSession | null>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  /** The latest session the adapter knows (kept current by the wallet's own change events). It is a snapshot. */
  getSession(): WalletSession;
  /** Asks the wallet again for its account and network, and returns the fresh session. Call it before trusting a snapshot. */
  refresh(): Promise<WalletSession>;
  getAddress(): Promise<string>;
  getBalance(asset: AssetId): Promise<Balance>;

  /** Signs without sending. Throws SwingsError('not-enabled') when the wallet cannot (see capabilities). */
  signTransaction(tx: UnsignedTransaction): Promise<SignedTransaction>;
  signMessage(message: Uint8Array): Promise<Signature>;
  /**
   * Sends. Given a signed transaction it submits it; given an unsigned EVM transaction the wallet signs and
   * broadcasts in one step (that is how EVM wallets work). Resolves to the transaction id; it does NOT mean confirmed.
   */
  sendTransaction(tx: SignedTransaction | UnsignedTransaction): Promise<TransactionHash>;

  /** Asks the wallet to change network. Only called after the user confirmed (see ensureNetwork). */
  switchNetwork(chain: ChainId): Promise<void>;

  /** Subscribes to changes the wallet reports. Returns the unsubscribe function. */
  onChange(listener: (change: SessionChange, session: WalletSession) => void): () => void;
}

export const NO_CAPABILITIES: WalletCapabilities = { signMessage: false, signWithoutSending: false, switchNetwork: false, multipleAccounts: false, emitsChanges: false };
