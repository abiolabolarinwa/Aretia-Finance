/**
 * WalletConnect for EVM: lets a phone wallet, or a hardware wallet reached through a phone or desktop app, connect by
 * QR code. It adds a wallet to the same EIP-1193 path every other EVM wallet uses, so every safety check (right account,
 * right network, declared destinations, no silent network switch) applies unchanged. Aretia holds no key.
 *
 * Needs a WalletConnect project id (free, from the WalletConnect Cloud dashboard). The id is public by design: it
 * identifies the site, it is not a secret. Without one, WalletConnect is not offered at all.
 *
 * The WalletConnect library is large, so it is loaded only when the user asks to use it (or already has a saved session).
 */
import { CHAINS, CHAIN_IDS, SwingsError } from '../core/types.js';
import type { Eip1193Provider } from '../chains/evmWallet.js';
import type { EvmSession } from '../chains/evmSession.js';

export const WALLETCONNECT_UUID = 'walletconnect';

/** The parts of WalletConnect's provider that Aretia uses. */
export interface WcProvider extends Eip1193Provider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  readonly session?: unknown;
  readonly accounts: string[];
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface WcConfig {
  projectId: string;
  /** EVM chain ids the user may use. The first connection asks only for Ethereum; the rest are optional. */
  chains: number[];
  metadata: { name: string; description: string; url: string; icons: string[] };
}

export type WcLoader = (config: WcConfig) => Promise<WcProvider>;

/** A real WalletConnect project id is 32 hex characters. */
export const isProjectId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);

export const supportedEvmIds = (): number[] => CHAIN_IDS.flatMap((c) => (CHAINS[c].evmChainId !== null ? [CHAINS[c].evmChainId!] : []));

const defaultLoader: WcLoader = async (config) => {
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
  const optional = config.chains.filter((id) => id !== 1);
  return (await EthereumProvider.init({ projectId: config.projectId, chains: [1], optionalChains: optional as [number, ...number[]], showQrModal: true, metadata: config.metadata })) as unknown as WcProvider;
};

/**
 * The provider handed to the rest of Swings: a request for accounts connects first (showing the QR code) when there is
 * no saved session, and uses the saved session without any prompt when there is one. Everything else passes through.
 */
export function asEip1193(wc: WcProvider): WcProvider {
  return {
    get session() {
      return wc.session;
    },
    get accounts() {
      return wc.accounts;
    },
    connect: () => wc.connect(),
    disconnect: () => wc.disconnect(),
    on: wc.on?.bind(wc),
    removeListener: wc.removeListener?.bind(wc),
    async request(args) {
      if (args.method === 'eth_requestAccounts') {
        if (!wc.session) await wc.connect();
        return wc.accounts;
      }
      return wc.request(args);
    },
  };
}

const metadata = (): WcConfig['metadata'] => ({ name: 'Aretia Wallet', description: 'Aretia Swings: swap, move and buy crypto from your own wallet.', url: 'https://aretiafinance.org', icons: [] });

/** Starts a WalletConnect session (QR code) and connects it as the page's EVM wallet. Resolves to the account. */
export async function connectWalletConnect(evm: EvmSession, projectId: string, loader: WcLoader = defaultLoader): Promise<string> {
  if (!isProjectId(projectId)) throw new SwingsError('config-missing', 'WalletConnect is not set up for this site yet.');
  let wc: WcProvider;
  try {
    wc = asEip1193(await loader({ projectId, chains: supportedEvmIds(), metadata: metadata() }));
  } catch {
    throw new SwingsError('provider-failed', 'WalletConnect could not be loaded. Check your connection and try again.');
  }
  evm.wallets = [...evm.wallets.filter((w) => w.info.uuid !== WALLETCONNECT_UUID), { info: { uuid: WALLETCONNECT_UUID, name: 'WalletConnect', icon: null, rdns: 'com.walletconnect' }, provider: wc }];
  return evm.connect(WALLETCONNECT_UUID);
}

/** True if the browser holds a saved WalletConnect session worth restoring (checked without loading the library). */
export function hasSavedSession(storage: Pick<Storage, 'length' | 'key'> = window.localStorage): boolean {
  try {
    for (let i = 0; i < storage.length; i++) if (storage.key(i)?.startsWith('wc@2:')) return true;
  } catch {
    // storage blocked: nothing to restore
  }
  return false;
}

/** Reconnects a saved session without any prompt. Resolves to the account, or null when there is nothing to restore. */
export async function restoreWalletConnect(evm: EvmSession, projectId: string, loader: WcLoader = defaultLoader): Promise<string | null> {
  if (!isProjectId(projectId)) return null;
  let wc: WcProvider;
  try {
    wc = asEip1193(await loader({ projectId, chains: supportedEvmIds(), metadata: metadata() }));
  } catch {
    return null;
  }
  if (!wc.session) return null;
  evm.wallets = [...evm.wallets.filter((w) => w.info.uuid !== WALLETCONNECT_UUID), { info: { uuid: WALLETCONNECT_UUID, name: 'WalletConnect', icon: null, rdns: 'com.walletconnect' }, provider: wc }];
  try {
    return await evm.connect(WALLETCONNECT_UUID);
  } catch {
    return null;
  }
}
