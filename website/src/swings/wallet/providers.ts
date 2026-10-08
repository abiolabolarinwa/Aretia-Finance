/**
 * Which wallets the user can connect, said honestly. The list is built from what is actually present in the page
 * (the Aretia Wallet host for Solana, EIP-6963 announcements for EVM) plus a few entries that explain what is NOT
 * available and why, instead of pretending. Nothing here connects anything; it only describes.
 */
import type { DiscoveredWallet } from '../chains/evmWallet.js';
import type { ChainType } from './types.js';

export interface WalletProviderInfo {
  id: string;
  name: string;
  chainType: ChainType;
  kind: 'aretia' | 'eip6963' | 'injected' | 'walletconnect';
  available: boolean;
  /** Why it is not available, or a note for the user. Plain words. */
  note: string | null;
  icon: string | null;
}

export interface ProviderSources {
  /** Whether the Aretia Wallet bridge (the Solana wallet host) is present in this page. */
  aretiaSolanaHost: boolean;
  /** Wallets announced through EIP-6963. */
  evmWallets: readonly DiscoveredWallet[];
  /** Whether a WalletConnect project id is configured for this site. */
  walletConnectConfigured?: boolean;
}

export function listWalletProviders(src: ProviderSources): WalletProviderInfo[] {
  const out: WalletProviderInfo[] = [];
  out.push({
    id: 'aretia-solana',
    name: 'Aretia Wallet (Solana)',
    chainType: 'solana',
    kind: 'aretia',
    available: src.aretiaSolanaHost,
    note: src.aretiaSolanaHost
      ? 'Connect with the Connect wallet button. Phantom, Solflare, Backpack and other Wallet Standard wallets connect here, and Ledger works through any of them that supports it.'
      : 'The Aretia Wallet page is not loaded here, so Solana wallets cannot be connected from this page.',
    icon: null,
  });
  for (const w of src.evmWallets) {
    const injected = w.info.uuid === 'legacy-injected';
    out.push({
      id: injected ? 'evm-injected' : w.info.rdns,
      name: w.info.name,
      chainType: 'evm',
      kind: injected ? 'injected' : 'eip6963',
      available: true,
      note: injected ? 'A browser wallet that did not identify itself. Check which wallet it is before approving.' : null,
      icon: w.info.icon,
    });
  }
  if (src.evmWallets.length === 0) {
    out.push({ id: 'evm-none', name: 'EVM wallet', chainType: 'evm', kind: 'eip6963', available: false, note: 'No EVM wallet was found in this browser. Install one (MetaMask, Coinbase Wallet, Rabby) and reload.', icon: null });
  }
  out.push({
    id: 'walletconnect',
    name: 'WalletConnect',
    chainType: 'evm',
    kind: 'walletconnect',
    available: src.walletConnectConfigured === true,
    note: src.walletConnectConfigured === true ? 'Connect a phone wallet, or a hardware wallet through its app, by scanning a QR code.' : 'WalletConnect is built but not switched on: this site has no WalletConnect project id yet.',
    icon: null,
  });
  return out;
}
