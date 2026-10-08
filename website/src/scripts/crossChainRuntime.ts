/**
 * The shared machinery behind the Move USDC and Plan tabs: one wallet session manager, one gateway, one execution store
 * (with the optional server recovery copy), one set of settlement providers and one orchestrator, so both tabs see the
 * same moves and never hold two different views of the user's wallet.
 */
import { CHAINS, type ChainId } from '../swings/core/types.js';
import { EvmSession, publicRead } from '../swings/chains/evmSession.js';
import { EvmBridgeWallet, type EvmEventSource } from '../swings/wallet/evmBridgeWallet.js';
import { WalletSessionManager } from '../swings/wallet/sessionManager.js';
import { cctpProviders } from '../swings/settlement/cctp.js';
import { SettlementQuoteEngine } from '../swings/settlement/engine.js';
import { CrossChainOrchestrator } from '../swings/orchestrator/orchestrator.js';
import { StorageExecutionStore } from '../swings/orchestrator/store.js';
import { WalletExecutionGateway } from '../swings/orchestrator/walletGateway.js';
import { mirroredExecutionStore, RecordMirror } from '../swings/orchestrator/remote.js';
import { runtime } from '../swings/runtime.js';

const COPY_KEY = 'aretia-swings-recovery-copy';

export function createCrossChainRuntime(evm: EvmSession, isEnabled: (chain: ChainId) => boolean) {
  const reader = (chain: ChainId) => publicRead(chain);
  const wallets = new WalletSessionManager(null);
  const gateway = new WalletExecutionGateway(wallets, reader, async (r) => window.confirm(`Your wallet is on ${r.from ? CHAINS[r.from].name : 'another network'}. Switch it to ${CHAINS[r.to].name}? Nothing is sent by switching.`));
  const local = new StorageExecutionStore(window.localStorage);
  const mirror = new RecordMirror();
  const state = { copyBehind: false };
  const copyOn = (): boolean => {
    try {
      return window.localStorage.getItem(COPY_KEY) === 'on' && runtime.recordsConfigured === true;
    } catch {
      return false;
    }
  };
  const setCopy = (on: boolean): void => {
    try {
      window.localStorage.setItem(COPY_KEY, on ? 'on' : 'off');
    } catch {
      // a convenience only
    }
  };
  const store = mirroredExecutionStore(local, mirror, copyOn, (r) => {
    state.copyBehind = r !== 'saved';
  });
  const providers = cctpProviders({ read: reader });
  const engine = new SettlementQuoteEngine(providers);
  const orchestrator = new CrossChainOrchestrator({ store, providers, gateway });

  /** Makes the page's connected EVM wallet known to the session manager (no prompt: it is already connected). */
  async function adoptWallet(): Promise<void> {
    if (!evm.adapter || !evm.account) return;
    const provider = evm.wallets.find((w) => w.info.name === evm.walletName)?.provider;
    const bridge = new EvmBridgeWallet('evm-page', evm.walletName ?? 'EVM wallet', evm.adapter, { read: reader, events: provider as EvmEventSource | undefined });
    await bridge.restore();
    wallets.add(bridge);
    wallets.setActive('evm-page');
  }

  return { evm, isEnabled, reader, wallets, gateway, local, mirror, store, providers, engine, orchestrator, adoptWallet, copyOn, setCopy, state };
}

export type CrossChainRuntime = ReturnType<typeof createCrossChainRuntime>;
