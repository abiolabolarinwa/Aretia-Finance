import { initLaunch } from './walletLaunch';
import { initPool } from './walletPool';
import { initCurve } from './walletCurve';
import { initOrders } from './walletOrders';
import { initAretiaPool } from './walletAretiaPool';
import { initLaunchHub, type LaunchHub } from './walletLaunchHub';
import { initLaunchBox } from './walletLaunchBox';
import { initYourPools } from './walletYourPools';
import { mountLaunchFeatured } from './walletFeatured';
import type { EvmSession } from '../swings/chains/evmSession.js';

/**
 * Everything behind the Launch and Launch Box pages. It is a separate file so the wallet page can show balances and let the
 * visitor connect before any of this has been downloaded: walletApp loads it right after the first screen is drawn.
 */
export interface LaunchClusterHost {
  getAddress(): string | null;
  refreshWallet(): void;
  /** The Ethereum-style account: the connected wallet's, or one already allowed on this page. */
  getEvmAccount(): string | null;
  ensureEvmWallet(): Promise<NonNullable<EvmSession['adapter']>>;
  /** The connected wallet's own account object, for the adapter handed to the launch flow. */
  evmSessionAccount(): string | null;
}

export interface LaunchCluster {
  onShowLaunch(): void;
  onShowLaunchBox(): void;
  onWalletChange(): void;
}

export function initLaunchCluster(host: LaunchClusterHost): LaunchCluster {
  const base = { getAddress: host.getAddress, refreshWallet: host.refreshWallet };
  const pool = initPool(base);
  const curve = initCurve(base);
  const orders = initOrders(base);
  const aretiaPool = initAretiaPool(base);
  let launchHub: LaunchHub | null = null;
  // Featured launches on the Launch page (drawn only while something is featured today).
  mountLaunchFeatured();
  const yourPools = initYourPools({
    ...base,
    onSolana: () => launch.getNetwork() === 'solana',
    evm: { network: () => launch.getNetwork(), getAccount: host.getEvmAccount, connect: async () => ({ adapter: await host.ensureEvmWallet() }) },
  });
  const launch = initLaunch({
    ...base,
    // One plain sign-in message, to prove who is uploading a token picture. Never a transaction.
    signMessage: async (message) => {
      const ctx = window.AretiaWallet?.getWalletContextState() as { signMessage?: (m: Uint8Array) => Promise<Uint8Array> } | undefined;
      if (!ctx?.signMessage) throw new Error('Your wallet cannot sign a message, so a picture cannot be uploaded with it.');
      return btoa(String.fromCharCode(...(await ctx.signMessage(new TextEncoder().encode(message)))));
    },
    onNetwork: (n) => {
      curve.setActive(n === 'solana');
      orders.setActive(n === 'solana');
      aretiaPool.setActive(n === 'solana');
    },
    offerPool: (mint) => pool.offer(mint),
    offerCurve: curve.present ? (mint) => curve.offer(mint) : undefined,
    evm: {
      getAccount: host.getEvmAccount,
      connect: async () => {
        const adapter = await host.ensureEvmWallet();
        return { adapter, account: host.evmSessionAccount() };
      },
    },
  });
  const launchBox = initLaunchBox({ goLaunch: () => (location.hash = '#/launch') });

  return {
    onShowLaunchBox: () => launchBox.onShow(),
    onShowLaunch() {
      launch.onShow();
      pool.onShow();
      curve.onShow();
      orders.onShow();
      launchHub ??= initLaunchHub(launch, {
        curveOn: curve.present,
        onPools: () => yourPools.onShow(),
        resetAll: () => {
          launch.onWalletChange();
          pool.onWalletChange();
          curve.onWalletChange();
          orders.onWalletChange();
        },
      });
      launchHub?.onShow();
    },
    onWalletChange() {
      launch.onWalletChange();
      yourPools.onWalletChange();
      pool.onWalletChange();
      curve.onWalletChange();
      orders.onWalletChange();
    },
  };
}
