/**
 * The Solana side of the wallet abstraction. Aretia Wallet already hosts every Solana wallet (Phantom, Solflare,
 * Backpack and any other Wallet Standard wallet, and Ledger through them) behind `window.AretiaWallet`, so this adapter
 * does not connect to wallets itself: it wraps that host. A user connects a wallet with the wallet page's own connect
 * button, and Swings sees the result. That is on purpose: one wallet system, not two.
 *
 * It never sees a private key. Signing goes through the host's `signTransaction` / `signMessage`, and a returned
 * transaction is checked against the one that was asked for before it is trusted.
 */
import type * as Web3 from '@solana/web3.js';
import { SwingsError, SOLANA_NATIVE_ADDRESS } from '../core/types.js';
import type { SolRpc } from '../solana/raydiumCpmm.js';
import { NO_CAPABILITIES, type AssetId, type Balance, type SessionChange, type Signature, type SignedTransaction, type TransactionHash, type UnsignedTransaction, type WalletAdapter, type WalletCapabilities, type WalletSession } from './types.js';

/** The wallet-adapter context object Aretia Wallet exposes. Everything is optional: wallets differ. */
export interface SolanaSigningContext {
  signTransaction?: (tx: Web3.Transaction | Web3.VersionedTransaction) => Promise<Web3.Transaction | Web3.VersionedTransaction>;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}

export interface SolanaWalletState {
  account: { address: string } | null;
  connecting: boolean;
  walletName: string | null;
}

/** What the adapter needs from whatever hosts the Solana wallet. `aretiaWalletHost` is the real one; tests use fakes. */
export interface SolanaWalletHost {
  state(): SolanaWalletState;
  context(): SolanaSigningContext | null;
  subscribe(listener: () => void): () => void;
  disconnect(): Promise<void>;
  /** Asks the host to open its connect screen. The user chooses the wallet there; the host reports the result via state. */
  requestConnect(): void;
}

interface AretiaWalletGlobal {
  getState(): SolanaWalletState & { walletIcon?: string | null };
  disconnect(): Promise<void>;
  subscribe(fn: (s: SolanaWalletState) => void): () => void;
  getWalletContextState(): unknown;
}

/** The real host: the wallet page's own bridge. Returns null where there is no such bridge (for example a plain page). */
export function aretiaWalletHost(win: { AretiaWallet?: AretiaWalletGlobal; document?: Document } = window as unknown as { AretiaWallet?: AretiaWalletGlobal; document?: Document }): SolanaWalletHost | null {
  const w = win.AretiaWallet;
  if (!w) return null;
  return {
    state: () => w.getState(),
    context: () => (w.getWalletContextState() as SolanaSigningContext | null) ?? null,
    subscribe: (fn) => w.subscribe(() => fn()),
    disconnect: () => w.disconnect(),
    requestConnect: () => win.document?.querySelector<HTMLButtonElement>('[data-aretia-wallet-mount] button')?.click(),
  };
}

export interface SolanaWalletOptions {
  rpc: SolRpc;
  now?: () => number;
  /** How long `connect()` waits for the user to pick a wallet. */
  connectTimeoutMs?: number;
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

const messageBytes = (tx: Web3.Transaction | Web3.VersionedTransaction): Uint8Array => ('version' in tx ? tx.message.serialize() : tx.serializeMessage());

const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

export class SolanaContextWallet implements WalletAdapter {
  readonly providerId = 'aretia-solana';
  readonly chainType = 'solana' as const;
  private revision = 0;
  private last = '';
  private connectedAt: number | null = null;
  private readonly now: () => number;
  private readonly timeout: number;

  constructor(
    private readonly host: SolanaWalletHost,
    private readonly o: SolanaWalletOptions,
  ) {
    this.now = o.now ?? Date.now;
    this.timeout = o.connectTimeoutMs ?? 120_000;
  }

  get providerName(): string {
    return this.host.state().walletName ?? 'Aretia Wallet';
  }

  private capabilities(): WalletCapabilities {
    const ctx = this.host.context();
    if (!ctx || !this.host.state().account) return NO_CAPABILITIES;
    return { signMessage: typeof ctx.signMessage === 'function', signWithoutSending: typeof ctx.signTransaction === 'function', switchNetwork: false, multipleAccounts: false, emitsChanges: true };
  }

  getSession(): WalletSession {
    const st = this.host.state();
    const address = st.account?.address ?? null;
    const state = address ? 'connected' : st.connecting ? 'connecting' : 'disconnected';
    const fingerprint = `${state}|${address}`;
    if (fingerprint !== this.last) {
      this.last = fingerprint;
      this.revision++;
      this.connectedAt = address ? this.now() : null;
    }
    return { providerId: this.providerId, providerName: this.providerName, chainType: 'solana', address, accounts: address ? [address] : [], chain: 'solana', networkId: null, state, capabilities: this.capabilities(), connectedAt: this.connectedAt, revision: this.revision };
  }

  async refresh(): Promise<WalletSession> {
    return this.getSession();
  }

  isConnected(): boolean {
    return this.host.state().account !== null;
  }

  async connect(): Promise<WalletSession> {
    if (this.isConnected()) return this.getSession();
    this.host.requestConnect();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new SwingsError('rejected', 'No wallet was connected. Choose a wallet in the connect screen and approve it.'));
      }, this.timeout);
      const off = this.host.subscribe(() => {
        if (this.host.state().account) {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });
    return this.getSession();
  }

  async restore(): Promise<WalletSession | null> {
    return this.isConnected() ? this.getSession() : null;
  }

  async disconnect(): Promise<void> {
    await this.host.disconnect();
    this.getSession();
  }

  async getAddress(): Promise<string> {
    const a = this.host.state().account?.address;
    if (!a) throw new SwingsError('invalid', 'No Solana wallet is connected.');
    return a;
  }

  async getBalance(asset: AssetId): Promise<Balance> {
    if (asset.chain !== 'solana') throw new SwingsError('invalid', 'This wallet only holds Solana assets.');
    const owner = await this.getAddress();
    const readAt = this.now();
    if (asset.address === SOLANA_NATIVE_ADDRESS) {
      const r = await this.o.rpc<{ value: number }>('getBalance', [owner, { commitment: 'confirmed' }]);
      return { asset, amount: BigInt(r.value), decimals: 9, readAt };
    }
    const accounts = await this.o.rpc<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string; decimals: number } } } } } }[] }>('getTokenAccountsByOwner', [owner, { mint: asset.address }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    if (accounts.value.length === 0) {
      const supply = await this.o.rpc<{ value: { decimals: number } }>('getTokenSupply', [asset.address]);
      return { asset, amount: 0n, decimals: supply.value.decimals, readAt };
    }
    let total = 0n;
    for (const a of accounts.value) total += BigInt(a.account.data.parsed.info.tokenAmount.amount);
    return { asset, amount: total, decimals: accounts.value[0]!.account.data.parsed.info.tokenAmount.decimals, readAt };
  }

  async signTransaction(tx: UnsignedTransaction): Promise<SignedTransaction> {
    if (tx.kind !== 'solana') throw new SwingsError('invalid', 'This wallet can only sign Solana transactions.');
    const ctx = this.host.context();
    if (!this.isConnected() || !ctx?.signTransaction) throw new SwingsError('not-enabled', 'The connected wallet cannot sign from this page.');
    let signed: Web3.Transaction | Web3.VersionedTransaction;
    try {
      signed = await ctx.signTransaction(tx.transaction);
    } catch (e) {
      throw new SwingsError('rejected', e instanceof Error && e.message ? `The wallet did not sign: ${e.message.slice(0, 120)}` : 'The wallet did not sign.');
    }
    // The wallet must hand back the transaction that was asked for, not a different one.
    if (!bytesEqual(messageBytes(signed), messageBytes(tx.transaction))) throw new SwingsError('invalid', 'The wallet returned a different transaction from the one shown. Nothing was sent.');
    return { kind: 'solana', transaction: signed, serialized: signed.serialize() };
  }

  async signMessage(message: Uint8Array): Promise<Signature> {
    const ctx = this.host.context();
    if (!this.isConnected() || !ctx?.signMessage) throw new SwingsError('not-enabled', 'The connected wallet cannot sign messages from this page.');
    try {
      return await ctx.signMessage(message);
    } catch {
      throw new SwingsError('rejected', 'The message was not signed.');
    }
  }

  async sendTransaction(tx: SignedTransaction | UnsignedTransaction): Promise<TransactionHash> {
    const signed = 'serialized' in tx ? tx : await this.signTransaction(tx as UnsignedTransaction);
    if (signed.kind !== 'solana' || !('serialized' in signed)) throw new SwingsError('invalid', 'This wallet can only send Solana transactions.');
    // preflight stays on so the network refuses a transaction that cannot succeed before it costs a fee.
    return this.o.rpc<string>('sendTransaction', [toBase64(signed.serialized), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]);
  }

  async switchNetwork(): Promise<void> {
    throw new SwingsError('not-enabled', 'Solana wallets stay on one network. Nothing to switch.');
  }

  onChange(listener: (change: SessionChange, session: WalletSession) => void): () => void {
    let previous = this.getSession();
    return this.host.subscribe(() => {
      const next = this.getSession();
      const was = previous;
      previous = next;
      if (next.state === was.state && next.address === was.address) return;
      const change: SessionChange = next.state === 'connected' && was.state !== 'connected' ? 'connected' : next.state !== 'connected' && was.state === 'connected' ? 'disconnected' : 'account-changed';
      listener(change, next);
    });
  }
}
