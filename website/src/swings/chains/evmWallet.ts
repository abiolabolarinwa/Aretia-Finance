/**
 * EVM wallet access for Swings. This is a thin abstraction over wallets the user already has
 * (EIP-6963 announcements, or a legacy injected provider). It holds no keys and creates no wallet:
 * every signature happens inside the user's own wallet. The Aretia Wallet extension plugs in by
 * announcing itself through EIP-6963 like any other wallet, or by implementing EvmWalletAdapter.
 */
import { SwingsError } from '../core/types.js';

/** EIP-1193: the one method every injected provider has. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface Eip6963Info {
  uuid: string;
  name: string;
  /** A data: image URI. Anything else is dropped (no remote images from wallet-supplied text). */
  icon: string | null;
  rdns: string;
}

export interface DiscoveredWallet {
  info: Eip6963Info;
  provider: Eip1193Provider;
}

export interface EvmTxRequest {
  from: string;
  to: string;
  data?: string;
  /** Hex quantity, as the wallet expects. */
  value?: string;
  gas?: string;
}

export interface EvmWalletAdapter {
  connect(): Promise<string[]>;
  disconnect(): Promise<void>;
  getAccounts(): Promise<string[]>;
  getChainId(): Promise<number>;
  switchChain(chainId: number): Promise<void>;
  /** Signs without sending. Many wallets do not support this; it throws SwingsError('not-enabled') then. */
  signTransaction(tx: EvmTxRequest): Promise<string>;
  /** The wallet signs and broadcasts; resolves to the transaction hash. */
  sendTransaction(tx: EvmTxRequest): Promise<string>;
  signMessage(message: string, account: string): Promise<string>;
  /** Read-only JSON-RPC through the wallet's own connection to its current chain. */
  request(method: string, params?: unknown[]): Promise<unknown>;
  /**
   * EIP-5792: whether the wallet can send several calls as ONE all-or-nothing batch for this account on this network.
   * Optional; a wallet without it is simply used one transaction at a time.
   */
  supportsBatch?(chainId: number, account: string): Promise<boolean>;
  /**
   * Sends the calls as one batch: one confirmation in the wallet, and either every call happens or none does. Resolves to
   * the hash of the last transaction once the batch is confirmed. Throws SwingsError('rejected') if the person declines,
   * and SwingsError('not-enabled') if the wallet cannot batch after all (the caller then goes one at a time).
   */
  sendBatch?(chainId: number, account: string, calls: EvmTxRequest[]): Promise<string>;
}

// ------------------------------------------------------------------ discovery

type Listener = (event: Event) => void;
interface EventHost {
  addEventListener(type: string, fn: Listener): void;
  removeEventListener(type: string, fn: Listener): void;
  dispatchEvent(event: Event): boolean;
  ethereum?: Eip1193Provider;
}

const safeIcon = (value: unknown): string | null => (typeof value === 'string' && /^data:image\/(png|svg\+xml|webp|jpeg|gif);/.test(value) && value.length < 200_000 ? value : null);

const isProvider = (v: unknown): v is Eip1193Provider => typeof v === 'object' && v !== null && typeof (v as Eip1193Provider).request === 'function';

/**
 * Asks every EIP-6963 wallet to announce itself and collects them for `waitMs`. A legacy
 * `window.ethereum` is added only when it was not already announced, and is labelled as generic:
 * it is never assumed to be the only wallet.
 */
export async function discoverWallets(host: EventHost = window as unknown as EventHost, waitMs = 250): Promise<DiscoveredWallet[]> {
  const found = new Map<string, DiscoveredWallet>();
  const onAnnounce: Listener = (event) => {
    const detail = (event as CustomEvent).detail as { info?: Partial<Eip6963Info>; provider?: unknown } | undefined;
    if (!detail || !detail.info || !isProvider(detail.provider)) return;
    const { uuid, name, rdns } = detail.info;
    if (typeof uuid !== 'string' || typeof name !== 'string' || typeof rdns !== 'string') return;
    found.set(uuid, { info: { uuid, name: name.slice(0, 40), rdns: rdns.slice(0, 80), icon: safeIcon(detail.info.icon) }, provider: detail.provider });
  };
  host.addEventListener('eip6963:announceProvider', onAnnounce);
  host.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise((r) => setTimeout(r, waitMs));
  host.removeEventListener('eip6963:announceProvider', onAnnounce);

  const wallets = [...found.values()];
  const legacy = host.ethereum;
  if (isProvider(legacy) && !wallets.some((w) => w.provider === legacy)) {
    wallets.push({ info: { uuid: 'legacy-injected', name: 'Browser wallet', rdns: 'injected', icon: null }, provider: legacy });
  }
  return wallets;
}

// ------------------------------------------------------------------ adapter

const hex = (n: number): string => '0x' + n.toString(16);
/**
 * What a wallet needs to add a network it does not have yet. These are each chain's own public endpoints and explorers;
 * the wallet shows them to the user, who approves or declines. Swap reads and simulation never use these.
 */
export const CHAIN_ADD_PARAMS: Readonly<Record<number, { chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: string[]; blockExplorerUrls: string[] }>> = {
  56: { chainName: 'BNB Smart Chain', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: ['https://bsc-dataseed.binance.org'], blockExplorerUrls: ['https://bscscan.com'] },
  137: { chainName: 'Polygon', nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 }, rpcUrls: ['https://polygon-rpc.com'], blockExplorerUrls: ['https://polygonscan.com'] },
  8453: { chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] },
  42161: { chainName: 'Arbitrum One', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://arb1.arbitrum.io/rpc'], blockExplorerUrls: ['https://arbiscan.io'] },
  10: { chainName: 'OP Mainnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.optimism.io'], blockExplorerUrls: ['https://optimistic.etherscan.io'] },
  43114: { chainName: 'Avalanche C-Chain', nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 }, rpcUrls: ['https://api.avax.network/ext/bc/C/rpc'], blockExplorerUrls: ['https://snowtrace.io'] },
  // Robinhood Chain, as Robinhood's own docs give it: chain ID 4663, ETH for gas, its public RPC and Blockscout explorer.
  4663: { chainName: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'], blockExplorerUrls: ['https://robinhoodchain.blockscout.com'] },
};

const isUserRejection = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { code?: number }).code === 4001;

/** EvmWalletAdapter over any EIP-1193 provider. */
export class Eip1193WalletAdapter implements EvmWalletAdapter {
  constructor(private readonly provider: Eip1193Provider) {}

  request(method: string, params: unknown[] = []): Promise<unknown> {
    return this.provider.request({ method, params });
  }

  async connect(): Promise<string[]> {
    try {
      return this.addresses(await this.request('eth_requestAccounts'));
    } catch (e) {
      if (isUserRejection(e)) throw new SwingsError('rejected', 'The wallet connection was declined.');
      throw e;
    }
  }

  /** The page only forgets the wallet. EIP-1193 has no standard disconnect; permissions stay in the wallet. */
  async disconnect(): Promise<void> {}

  async getAccounts(): Promise<string[]> {
    return this.addresses(await this.request('eth_accounts'));
  }

  async getChainId(): Promise<number> {
    const id = await this.request('eth_chainId');
    const n = typeof id === 'string' ? Number.parseInt(id, 16) : Number.NaN;
    if (!Number.isInteger(n) || n <= 0) throw new SwingsError('invalid', 'The wallet returned an invalid chain id.');
    return n;
  }

  async switchChain(chainId: number): Promise<void> {
    try {
      await this.request('wallet_switchEthereumChain', [{ chainId: hex(chainId) }]);
    } catch (e) {
      if (isUserRejection(e)) throw new SwingsError('rejected', 'The network switch was declined.');
      // 4902: the wallet does not know this network. Offer to add it, from the parameters Aretia holds for it, and nothing else.
      const params = (e as { code?: number }).code === 4902 ? CHAIN_ADD_PARAMS[chainId] : undefined;
      if (!params) throw new SwingsError('invalid', 'Your wallet could not switch to that network. Add it in the wallet and try again.');
      try {
        await this.request('wallet_addEthereumChain', [{ chainId: hex(chainId), ...params }]);
      } catch (e2) {
        if (isUserRejection(e2)) throw new SwingsError('rejected', 'Adding the network was declined.');
        throw new SwingsError('invalid', 'Your wallet could not add that network. Add it in the wallet and try again.');
      }
    }
    // Do not trust the switch call: confirm the wallet is really on the chain the swap was built for.
    if ((await this.getChainId()) !== chainId) throw new SwingsError('invalid', 'The wallet did not switch networks.');
  }

  async signTransaction(tx: EvmTxRequest): Promise<string> {
    try {
      return this.str(await this.request('eth_signTransaction', [tx]));
    } catch (e) {
      if (isUserRejection(e)) throw new SwingsError('rejected', 'The signature was declined.');
      throw new SwingsError('not-enabled', 'This wallet does not offer signing without sending.');
    }
  }

  async sendTransaction(tx: EvmTxRequest): Promise<string> {
    try {
      const hash = this.str(await this.request('eth_sendTransaction', [tx]));
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new SwingsError('invalid', 'The wallet returned an invalid transaction hash.');
      return hash;
    } catch (e) {
      if (isUserRejection(e)) throw new SwingsError('rejected', 'The transaction was declined in your wallet.');
      throw e;
    }
  }

  async supportsBatch(chainId: number, account: string): Promise<boolean> {
    try {
      const caps = (await this.request('wallet_getCapabilities', [account, [hex(chainId)]])) as Record<string, { atomic?: { status?: string } }> | null;
      const status = caps?.[hex(chainId)]?.atomic?.status;
      return status === 'supported' || status === 'ready';
    } catch {
      return false;
    }
  }

  async sendBatch(chainId: number, account: string, calls: EvmTxRequest[]): Promise<string> {
    let id: string;
    try {
      const res = await this.request('wallet_sendCalls', [
        {
          version: '2.0.0',
          chainId: hex(chainId),
          from: account,
          // All or nothing: a half-done batch (a fee paid and no swap) is never acceptable.
          atomicRequired: true,
          calls: calls.map((c) => ({ to: c.to, ...(c.data ? { data: c.data } : {}), value: c.value ?? '0x0' })),
        },
      ]);
      const got = typeof res === 'string' ? res : (res as { id?: unknown } | null)?.id;
      if (typeof got !== 'string' || got.length === 0) throw new SwingsError('not-enabled', 'The wallet did not accept the batch.');
      id = got;
    } catch (e) {
      if (isUserRejection(e)) throw new SwingsError('rejected', 'The transaction was declined in your wallet.');
      if (e instanceof SwingsError) throw e;
      // Any other refusal (method unknown, atomic batching not available): the caller falls back to one at a time.
      throw new SwingsError('not-enabled', 'The wallet cannot send these together.');
    }
    // The wallet reports progress by id: 1xx pending, 2xx confirmed, 4xx/5xx failed.
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const res = (await this.request('wallet_getCallsStatus', [id])) as { status?: number; receipts?: { transactionHash?: string; status?: string }[] } | null;
      const code = res?.status ?? 100;
      if (code >= 200 && code < 300) {
        const receipts = res?.receipts ?? [];
        const last = receipts[receipts.length - 1]?.transactionHash;
        if (receipts.some((r) => r.status === '0x0')) throw new SwingsError('failed', 'The transaction failed. Nothing was spent except the network fee.');
        if (typeof last === 'string' && /^0x[0-9a-fA-F]{64}$/.test(last)) return last;
        throw new SwingsError('invalid', 'The wallet confirmed the batch but did not report its transaction.');
      }
      if (code >= 400) throw new SwingsError('failed', 'The transaction failed. Nothing was swapped.');
      await new Promise((r) => setTimeout(r, 1_500));
    }
    throw new SwingsError('failed', 'The transaction is still pending. Check your wallet before trying again.');
  }

  async signMessage(message: string, account: string): Promise<string> {
    try {
      return this.str(await this.request('personal_sign', [message, account]));
    } catch (e) {
      if (isUserRejection(e)) throw new SwingsError('rejected', 'The signature was declined.');
      throw e;
    }
  }

  private addresses(v: unknown): string[] {
    if (!Array.isArray(v)) throw new SwingsError('invalid', 'The wallet returned no accounts.');
    return v.filter((a): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)).map((a) => a.toLowerCase());
  }

  private str(v: unknown): string {
    if (typeof v !== 'string') throw new SwingsError('invalid', 'The wallet returned an unexpected response.');
    return v;
  }
}
