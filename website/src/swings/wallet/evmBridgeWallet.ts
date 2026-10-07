/**
 * The EVM side of the wallet abstraction: any wallet that speaks EIP-1193 (MetaMask, Coinbase Wallet, Rabby, Aretia
 * Wallet when it announces itself through EIP-6963, a Ledger reached through one of those) behind the common
 * `WalletAdapter`. It wraps the existing `EvmWalletAdapter` (evmWallet.ts); it adds the session, the change events and
 * the checks, and holds no key.
 *
 * Reads (balances, token facts) go through a public node for the asset's own chain, never through the wallet, so they do
 * not depend on, or prompt, whatever network the wallet happens to be on.
 */
import { CHAINS, CHAIN_IDS, SwingsError, EVM_NATIVE_ADDRESS, type ChainId } from '../core/types.js';
import type { EvmWalletAdapter } from '../chains/evmWallet.js';
import { readBalance, readErc20, type EvmRead } from '../chains/evmSession.js';
import { NO_CAPABILITIES, type AssetId, type Balance, type SessionChange, type Signature, type SignedTransaction, type TransactionHash, type UnsignedTransaction, type WalletAdapter, type WalletSession } from './types.js';

/** The optional event surface of an EIP-1193 provider. */
export interface EvmEventSource {
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

export interface EvmBridgeOptions {
  /** A node for reading a chain, independent of the wallet. */
  read: (chain: ChainId) => EvmRead;
  events?: EvmEventSource;
  now?: () => number;
}

/** The Swings chain for an EVM chain id, or null if Swings does not support that network. */
export function chainForEvmId(id: number | null): ChainId | null {
  if (id === null) return null;
  return CHAIN_IDS.find((c) => CHAINS[c].evmChainId === id) ?? null;
}

const hexOf = (bytes: Uint8Array): string => '0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const isAddress = (a: unknown): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

export class EvmBridgeWallet implements WalletAdapter {
  readonly chainType = 'evm' as const;
  private accounts: string[] = [];
  private chainId: number | null = null;
  private state: WalletSession['state'] = 'disconnected';
  private connectedAt: number | null = null;
  private revision = 0;
  private readonly listeners = new Set<(change: SessionChange, session: WalletSession) => void>();
  private readonly now: () => number;
  private detach: (() => void) | null = null;

  constructor(
    readonly providerId: string,
    readonly providerName: string,
    private readonly adapter: EvmWalletAdapter,
    private readonly o: EvmBridgeOptions,
  ) {
    this.now = o.now ?? Date.now;
  }

  getSession(): WalletSession {
    const connected = this.state === 'connected';
    return {
      providerId: this.providerId,
      providerName: this.providerName,
      chainType: 'evm',
      address: this.accounts[0] ?? null,
      accounts: [...this.accounts],
      chain: chainForEvmId(this.chainId),
      networkId: this.chainId,
      state: this.state,
      // EVM wallets rarely sign without sending, so that is not claimed. Network switching and events are standard.
      capabilities: connected ? { signMessage: true, signWithoutSending: false, switchNetwork: true, multipleAccounts: true, emitsChanges: Boolean(this.o.events?.on) } : NO_CAPABILITIES,
      connectedAt: this.connectedAt,
      revision: this.revision,
    };
  }

  private emit(change: SessionChange): void {
    this.revision++;
    const s = this.getSession();
    for (const l of [...this.listeners]) l(change, s);
  }

  isConnected(): boolean {
    return this.state === 'connected' && this.accounts.length > 0;
  }

  private attach(): void {
    const ev = this.o.events;
    if (!ev?.on || !ev.removeListener || this.detach) return;
    const onAccounts = (...args: unknown[]): void => {
      const list = Array.isArray(args[0]) ? (args[0] as unknown[]).filter(isAddress).map((a) => a.toLowerCase()) : [];
      const before = this.accounts[0];
      this.accounts = list;
      if (list.length === 0) {
        this.state = 'disconnected';
        this.connectedAt = null;
        return this.emit('disconnected');
      }
      if (list[0] !== before) this.emit('account-changed');
    };
    const onChain = (...args: unknown[]): void => {
      const id = typeof args[0] === 'string' && /^0x[0-9a-fA-F]+$/.test(args[0]) ? Number.parseInt(args[0], 16) : typeof args[0] === 'number' ? args[0] : null;
      if (id === null || id === this.chainId) return;
      this.chainId = id;
      this.emit('network-changed');
    };
    ev.on('accountsChanged', onAccounts);
    ev.on('chainChanged', onChain);
    this.detach = () => {
      ev.removeListener!('accountsChanged', onAccounts);
      ev.removeListener!('chainChanged', onChain);
      this.detach = null;
    };
  }

  async connect(): Promise<WalletSession> {
    this.state = 'connecting';
    this.emit('capabilities-changed');
    try {
      const accounts = await this.adapter.connect();
      if (accounts.length === 0) throw new SwingsError('invalid', 'The wallet shared no account.');
      this.accounts = accounts;
      this.chainId = await this.adapter.getChainId();
      this.state = 'connected';
      this.connectedAt = this.now();
    } catch (e) {
      this.state = 'disconnected';
      this.accounts = [];
      this.emit('error');
      throw e;
    }
    this.attach();
    this.emit('connected');
    return this.getSession();
  }

  async restore(): Promise<WalletSession | null> {
    try {
      // eth_accounts lists accounts the user already approved for this page, and never prompts.
      const accounts = await this.adapter.getAccounts();
      if (accounts.length === 0) return null;
      this.accounts = accounts;
      this.chainId = await this.adapter.getChainId();
      this.state = 'connected';
      this.connectedAt = this.now();
      this.attach();
      this.emit('connected');
      return this.getSession();
    } catch {
      return null;
    }
  }

  async disconnect(): Promise<void> {
    this.detach?.();
    await this.adapter.disconnect().catch(() => undefined);
    this.accounts = [];
    this.chainId = null;
    this.state = 'disconnected';
    this.connectedAt = null;
    this.emit('disconnected');
  }

  async refresh(): Promise<WalletSession> {
    if (this.state !== 'connected') return this.getSession();
    const [accounts, chainId] = await Promise.all([this.adapter.getAccounts(), this.adapter.getChainId()]);
    const accountChanged = accounts[0] !== this.accounts[0];
    const networkChanged = chainId !== this.chainId;
    this.accounts = accounts;
    this.chainId = chainId;
    if (accounts.length === 0) {
      this.state = 'disconnected';
      this.connectedAt = null;
      this.emit('disconnected');
    } else if (accountChanged) this.emit('account-changed');
    else if (networkChanged) this.emit('network-changed');
    return this.getSession();
  }

  async getAddress(): Promise<string> {
    const a = this.accounts[0];
    if (!a || this.state !== 'connected') throw new SwingsError('invalid', 'No EVM wallet is connected.');
    return a;
  }

  async getBalance(asset: AssetId): Promise<Balance> {
    if (CHAINS[asset.chain].kind !== 'evm') throw new SwingsError('invalid', 'This wallet only holds EVM assets.');
    const owner = await this.getAddress();
    const read = this.o.read(asset.chain);
    const readAt = this.now();
    if (asset.address.toLowerCase() === EVM_NATIVE_ADDRESS) return { asset, amount: await readBalance(read, owner, EVM_NATIVE_ADDRESS), decimals: CHAINS[asset.chain].nativeDecimals, readAt };
    const facts = await readErc20(read, asset.address);
    if (!facts) throw new SwingsError('invalid', 'That token could not be read on-chain.');
    return { asset, amount: await readBalance(read, owner, asset.address), decimals: facts.decimals, readAt };
  }

  async signTransaction(): Promise<SignedTransaction> {
    throw new SwingsError('not-enabled', 'EVM wallets sign and send in one step. Use sendTransaction.');
  }

  async signMessage(message: Uint8Array): Promise<Signature> {
    return this.adapter.signMessage(hexOf(message), await this.getAddress());
  }

  async sendTransaction(tx: SignedTransaction | UnsignedTransaction): Promise<TransactionHash> {
    if (tx.kind !== 'evm') throw new SwingsError('invalid', 'This wallet can only send EVM transactions.');
    if ('raw' in tx) {
      const hash = await this.adapter.request('eth_sendRawTransaction', [tx.raw]);
      if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new SwingsError('invalid', 'The network returned an invalid transaction hash.');
      return hash;
    }
    // The wallet is asked again, now, who and where it is: a switch made inside the wallet since the quote must not slip through.
    const session = await this.refresh();
    if (!this.isConnected() || !session.address) throw new SwingsError('invalid', 'The wallet is no longer connected.');
    if (tx.tx.from.toLowerCase() !== session.address.toLowerCase()) throw new SwingsError('invalid', 'The wallet account changed since this transaction was built. Nothing was sent.');
    if (session.networkId !== tx.chainId) throw new SwingsError('invalid', 'The wallet is on a different network from this transaction. Nothing was sent.');
    return this.adapter.sendTransaction(tx.tx);
  }

  async switchNetwork(chain: ChainId): Promise<void> {
    const id = CHAINS[chain].evmChainId;
    if (CHAINS[chain].kind !== 'evm' || id === null) throw new SwingsError('invalid', 'That is not an EVM network.');
    await this.adapter.switchChain(id);
    await this.refresh();
    if (this.getSession().networkId !== id) throw new SwingsError('invalid', 'The wallet did not switch networks.');
  }

  onChange(listener: (change: SessionChange, session: WalletSession) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
