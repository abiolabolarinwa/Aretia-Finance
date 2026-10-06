/**
 * Browser-side EVM session: finds the user's wallets (EIP-6963), connects one, and reads token facts
 * from the chain through a read-only public RPC. Holds no keys. Reads (balances, simulation, token
 * symbol and decimals) use the public RPC, so they never depend on, or prompt, the wallet's current network.
 *
 * Data leaving the page for reads: the contract and account addresses go to the chain's public RPC
 * endpoint (publicnode), the same kind of disclosure the Solana path makes.
 */
import { CHAINS, SwingsError, type ChainId } from '../core/types.js';
import { discoverWallets, Eip1193WalletAdapter, type DiscoveredWallet, type EvmWalletAdapter } from './evmWallet.js';

export const PUBLIC_EVM_RPC: Readonly<Record<Exclude<ChainId, 'solana'>, string>> = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  bnb: 'https://bsc-rpc.publicnode.com',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
  base: 'https://base-rpc.publicnode.com',
};

export type EvmRead = (method: string, params: unknown[]) => Promise<unknown>;

export function publicRead(chain: ChainId, fetchImpl: typeof fetch = fetch): EvmRead {
  if (chain === 'solana') throw new SwingsError('invalid', 'Solana has no EVM RPC.');
  const url = PUBLIC_EVM_RPC[chain];
  let id = 0;
  const once = async (method: string, params: unknown[]): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: controller.signal });
      if (!res.ok) throw new SwingsError('provider-failed', `The ${CHAINS[chain].name} network node answered ${res.status}.`);
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (body.error) throw new SwingsError('provider-failed', (body.error.message ?? 'The network node rejected the request.').slice(0, 200));
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  };
  // Reads are idempotent, so one retry after a timeout or network drop is safe. A node that answered with
  // an error is not retried. Writes never use this function: the wallet sends them.
  return async (method, params) => {
    try {
      return await once(method, params);
    } catch (e) {
      if (e instanceof SwingsError) throw e;
      return once(method, params);
    }
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
    this.walletName = w.info.name;
    this.account = first;
    return first;
  }

  async disconnect(): Promise<void> {
    await this.adapter?.disconnect();
    this.adapter = null;
    this.walletName = null;
    this.account = null;
  }

  /** Re-reads the account the wallet has selected, so a switch inside the wallet is noticed before signing. */
  async refreshAccount(): Promise<string | null> {
    if (!this.adapter) return null;
    this.account = (await this.adapter.getAccounts())[0] ?? null;
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
