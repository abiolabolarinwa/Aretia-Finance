/**
 * Browser-side EVM session: finds the user's wallets (EIP-6963), connects one, and reads token facts
 * from the chain through a read-only public RPC. Holds no keys. Reads (balances, simulation, token
 * symbol and decimals) use the public RPC, so they never depend on, or prompt, the wallet's current network.
 *
 * Data leaving the page for reads: the contract and account addresses go to the chain's public RPC
 * endpoint (publicnode, or the chain's own public node if publicnode will not answer), the same kind of disclosure the Solana path makes.
 */
import { CHAINS, SwingsError, type ChainId } from '../core/types.js';
import { discoverWallets, Eip1193WalletAdapter, type DiscoveredWallet, type Eip1193Provider, type EvmWalletAdapter } from './evmWallet.js';

export const PUBLIC_EVM_RPC: Readonly<Record<Exclude<ChainId, 'solana'>, string>> = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  bnb: 'https://bsc-rpc.publicnode.com',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
  base: 'https://base-rpc.publicnode.com',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  optimism: 'https://optimism-rpc.publicnode.com',
  avalanche: 'https://avalanche-c-chain-rpc.publicnode.com',
  // publicnode, like the other networks. Robinhood's own public endpoint (rpc.mainnet.chain.robinhood.com) is documented as rate-limited
  // and dropped requests intermittently when tested from a browser.
  robinhood: 'https://robinhood-rpc.publicnode.com',
};

/**
 * Tried, in order, when the main node refuses or cannot be reached. publicnode answers HTTP 403 ("archive requests require a
 * personal token") for the receipt of a transaction it has not seen yet, on BNB Chain, Base, Arbitrum and Optimism, which is
 * exactly what a page asks a second after sending a swap. A second node returns the honest "not yet" (null) instead. Each was
 * checked to answer from a browser (CORS) and to return null for an unknown receipt.
 */
export const BACKUP_EVM_RPC: Readonly<Partial<Record<Exclude<ChainId, 'solana'>, readonly string[]>>> = {
  ethereum: ['https://cloudflare-eth.com'],
  bnb: ['https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc.meowrpc.com'],
  base: ['https://mainnet.base.org'],
  optimism: ['https://mainnet.optimism.io'],
  avalanche: ['https://api.avax.network/ext/bc/C/rpc'],
  robinhood: ['https://rpc.mainnet.chain.robinhood.com'],
};

export type EvmRead = (method: string, params: unknown[]) => Promise<unknown>;

/** A node that would not take the request at all (HTTP error). Another node may; this is not an answer about the request. */
class NodeRefused extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/**
 * Public nodes turn away a burst: a handful of requests at once is fine, a dozen are refused (the browser reports that as a
 * network error). Every read through one node shares this small limit, so the risk checks, the lock checks and the token panel
 * cannot swamp it together; a request over the limit simply waits its turn.
 */
export const MAX_CONCURRENT_PER_NODE = 3;
const slots = new Map<string, { active: number; waiting: (() => void)[] }>();

async function withSlot<T>(url: string, run: () => Promise<T>): Promise<T> {
  let q = slots.get(url);
  if (!q) {
    q = { active: 0, waiting: [] };
    slots.set(url, q);
  }
  const queue = q;
  if (queue.active >= MAX_CONCURRENT_PER_NODE) await new Promise<void>((resolve) => queue.waiting.push(resolve));
  queue.active++;
  try {
    return await run();
  } finally {
    queue.active--;
    queue.waiting.shift()?.();
  }
}

export function publicRead(chain: ChainId, fetchImpl: typeof fetch = fetch): EvmRead {
  if (chain === 'solana') throw new SwingsError('invalid', 'Solana has no EVM RPC.');
  const urls = [PUBLIC_EVM_RPC[chain], ...(BACKUP_EVM_RPC[chain] ?? [])];
  let id = 0;
  const once = async (url: string, method: string, params: unknown[]): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: controller.signal });
      if (!res.ok) throw new NodeRefused(res.status);
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (body.error) throw new SwingsError('provider-failed', (body.error.message ?? 'The network node rejected the request.').slice(0, 200));
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  };
  // Reads are idempotent, so trying another node, or the same one again after a drop, is safe. A node that answered the
  // request with an error of its own (a revert, a bad parameter) is not asked again: another node would say the same.
  // Writes never use this function: the wallet sends them.
  return async (method, params) => {
    let refused: NodeRefused | null = null;
    let dropped = false;
    for (const url of urls) {
      try {
        return await withSlot(url, () => once(url, method, params));
      } catch (e) {
        if (e instanceof SwingsError) throw e;
        if (e instanceof NodeRefused) refused = e;
        else dropped = true;
      }
    }
    // Every node was out of reach by network error alone: one more go at the main one, as a single dropped request deserves.
    if (dropped && !refused) return withSlot(urls[0]!, () => once(urls[0]!, method, params));
    if (refused) throw new SwingsError('provider-failed', `The ${CHAINS[chain].name} network node answered ${refused.status}.`);
    throw new SwingsError('provider-failed', `The ${CHAINS[chain].name} network node could not be reached.`);
  };
}

/** Decodes an ABI-encoded string, or a bytes32 used as a string (older tokens such as MKR). Returns null if malformed. */
export function decodeAbiString(hex: unknown): string | null {
  if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) return null;
  const bytes = hex.slice(2);
  const toText = (h: string): string => {
    let s = '';
    for (let i = 0; i < h.length; i += 2) {
      const c = Number.parseInt(h.slice(i, i + 2), 16);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  if (bytes.length === 64) return toText(bytes) || null;
  if (bytes.length < 128) return null;
  const length = Number.parseInt(bytes.slice(64, 128), 16);
  if (!Number.isInteger(length) || length < 0 || length > 256 || bytes.length < 128 + length * 2) return null;
  return toText(bytes.slice(128, 128 + length * 2)) || null;
}

export interface Erc20Facts {
  symbol: string;
  name: string;
  decimals: number;
}

/** Reads symbol, name and decimals from the contract itself. Null if the address is not a readable ERC-20. */
export async function readErc20(read: EvmRead, address: string): Promise<Erc20Facts | null> {
  try {
    const code = await read('eth_getCode', [address, 'latest']);
    if (typeof code !== 'string' || code === '0x') return null;
    const decimalsHex = await read('eth_call', [{ to: address, data: '0x313ce567' }, 'latest']);
    const decimals = typeof decimalsHex === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(decimalsHex) ? Number.parseInt(decimalsHex, 16) : Number.NaN;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
    const [symbol, name] = await Promise.all([read('eth_call', [{ to: address, data: '0x95d89b41' }, 'latest']).then(decodeAbiString, () => null), read('eth_call', [{ to: address, data: '0x06fdde03' }, 'latest']).then(decodeAbiString, () => null)]);
    return { symbol: (symbol ?? address.slice(0, 6)).slice(0, 20), name: (name ?? '').slice(0, 60), decimals };
  } catch {
    return null;
  }
}

interface EventHost {
  addEventListener(type: string, fn: (e: Event) => void): void;
  removeEventListener(type: string, fn: (e: Event) => void): void;
  dispatchEvent(event: Event): boolean;
  ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
}

/** One connected EVM wallet at a time. */
export class EvmSession {
  wallets: DiscoveredWallet[] = [];
  adapter: EvmWalletAdapter | null = null;
  walletName: string | null = null;
  account: string | null = null;
  /** The provider of the connected wallet, kept so a wallet that has its own session (WalletConnect) can be closed. */
  provider: Eip1193Provider | null = null;
  /**
   * True while the connected wallet shares no account: it has locked itself (MetaMask does after a period of
   * inactivity) or the site's access was removed. The page keeps the wallet and offers to unlock it, instead of
   * still showing the old account as connected.
   */
  locked = false;
  /** Called when the wallet reports a lock, an account switch or a network change. `accountChanged` is true when the account differs from before. */
  onChange: ((change: { account: string | null; accountChanged: boolean }) => void) | null = null;
  private unwatch: (() => void) | null = null;

  constructor(private readonly host?: EventHost) {}

  async discover(): Promise<DiscoveredWallet[]> {
    this.wallets = await discoverWallets(this.host);
    return this.wallets;
  }

  async connect(uuid: string): Promise<string> {
    const w = this.wallets.find((x) => x.info.uuid === uuid);
    if (!w) throw new SwingsError('invalid', 'That wallet is no longer available.');
    const adapter = new Eip1193WalletAdapter(w.provider);
    const accounts = await adapter.connect();
    const first = accounts[0];
    if (!first) throw new SwingsError('invalid', 'The wallet shared no account.');
    this.adapter = adapter;
    this.provider = w.provider;
    this.walletName = w.info.name;
    this.account = first;
    this.locked = false;
    this.watch(w.provider);
    return first;
  }

  /** Follows the wallet's own events, so a lock or an account switch inside the wallet shows on the page at once. */
  private watch(provider: Eip1193Provider): void {
    this.unwatch?.();
    if (typeof provider.on !== 'function') return;
    const onAccounts = (...args: unknown[]): void => {
      const list = Array.isArray(args[0]) ? args[0].filter((a): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)) : [];
      const before = this.account;
      this.account = list[0] ?? null;
      this.locked = this.account === null;
      this.onChange?.({ account: this.account, accountChanged: this.account?.toLowerCase() !== before?.toLowerCase() });
    };
    const onChain = (): void => this.onChange?.({ account: this.account, accountChanged: false });
    provider.on('accountsChanged', onAccounts);
    provider.on('chainChanged', onChain);
    this.unwatch = () => {
      provider.removeListener?.('accountsChanged', onAccounts);
      provider.removeListener?.('chainChanged', onChain);
      this.unwatch = null;
    };
  }

  /** Asks a locked wallet to unlock and share its account again (the wallet opens its own password prompt). */
  async unlock(): Promise<string> {
    if (!this.adapter) throw new SwingsError('invalid', 'There is no wallet to unlock. Connect one first.');
    const first = (await this.adapter.connect())[0];
    if (!first) throw new SwingsError('invalid', 'The wallet shared no account.');
    this.account = first;
    this.locked = false;
    return first;
  }

  /**
   * Picks up a wallet the person has already connected to this site, without asking again: `eth_accounts` only answers
   * with accounts the wallet has already shared, and never opens a prompt. The wallet whose name matches `preferName`
   * (the one connected in the sidebar) is tried first. Returns the account, or null when none was shared yet.
   */
  async resume(preferName: string | null): Promise<string | null> {
    if (this.account) return this.account;
    const found = this.wallets.length > 0 ? this.wallets : await this.discover();
    const want = (preferName ?? '').trim().toLowerCase();
    const ordered = [...found].sort((a, b) => Number(b.info.name.toLowerCase() === want) - Number(a.info.name.toLowerCase() === want));
    for (const w of ordered) {
      // Only the wallet that is connected in the sidebar is reused; another one stays a choice for the person to make.
      if (want && w.info.name.toLowerCase() !== want) continue;
      try {
        const adapter = new Eip1193WalletAdapter(w.provider);
        const first = (await adapter.getAccounts())[0];
        if (!first) continue;
        this.adapter = adapter;
        this.provider = w.provider;
        this.walletName = w.info.name;
        this.account = first;
        this.locked = false;
        this.watch(w.provider);
        return first;
      } catch {
        // a wallet that cannot answer stays a manual choice
      }
    }
    return null;
  }

  async disconnect(): Promise<void> {
    await this.adapter?.disconnect();
    const closable = this.provider as { disconnect?: () => Promise<void> } | null;
    try {
      await closable?.disconnect?.();
    } catch {
      // The page forgets the wallet either way.
    }
    this.unwatch?.();
    this.provider = null;
    this.adapter = null;
    this.walletName = null;
    this.account = null;
    this.locked = false;
  }

  /** Re-reads the account the wallet has selected, so a switch inside the wallet is noticed before signing. */
  async refreshAccount(): Promise<string | null> {
    if (!this.adapter) return null;
    this.account = (await this.adapter.getAccounts())[0] ?? null;
    this.locked = this.account === null;
    return this.account;
  }
}

/** Balance of the native coin (token = the 0xeee… placeholder) or of an ERC-20, read through a public node. */
export async function readBalance(read: EvmRead, account: string, token: string): Promise<bigint> {
  const native = token.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const raw = native ? await read('eth_getBalance', [account, 'latest']) : await read('eth_call', [{ to: token, data: '0x70a08231' + account.slice(2).toLowerCase().padStart(64, '0') }, 'latest']);
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]*$/.test(raw)) throw new SwingsError('invalid', 'The network node returned an invalid balance.');
  return raw === '0x' ? 0n : BigInt(raw);
}

/**
 * Whether the account can pay the network fee. Selling the native coin needs the amount plus the fee;
 * selling a token needs only the fee in the native coin. Returns a plain-language problem, or null.
 */
export function evmGasProblem(args: { nativeBalance: bigint; networkFee: bigint | null; sellsNative: boolean; amountIn: bigint; nativeSymbol: string }): string | null {
  if (args.networkFee === null) return null;
  const need = args.networkFee + (args.sellsNative ? args.amountIn : 0n);
  return args.nativeBalance < need ? `You need more ${args.nativeSymbol} to pay the network fee for this swap.` : null;
}
