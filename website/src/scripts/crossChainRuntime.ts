/**
 * The shared machinery behind the Move USDC and Plan tabs: one wallet session manager, one gateway, one execution store
 * (with the optional server recovery copy), one set of settlement providers and one orchestrator, so both tabs see the
 * same moves and never hold two different views of the user's wallet.
 */
import { CHAINS, EVM_NATIVE_ADDRESS, type ChainId } from '../swings/core/types.js';
import { EvmSession, publicRead, readBalance } from '../swings/chains/evmSession.js';
import { SolanaContextWallet, aretiaWalletHost } from '../swings/wallet/solanaContextWallet.js';
import { CCTP_USDC } from '../swings/settlement/cctp.js';
import { rpcCall, loadWeb3 } from './walletSend';
import { EvmBridgeWallet, type EvmEventSource } from '../swings/wallet/evmBridgeWallet.js';
import { WalletSessionManager } from '../swings/wallet/sessionManager.js';
import { cctpProviders } from '../swings/settlement/cctp.js';
import { SettlementQuoteEngine } from '../swings/settlement/engine.js';
import { CrossChainOrchestrator } from '../swings/orchestrator/orchestrator.js';
import { StorageExecutionStore } from '../swings/orchestrator/store.js';
import { solanaSignatureStatus, WalletExecutionGateway } from '../swings/orchestrator/walletGateway.js';
import { mirroredExecutionStore, RecordMirror } from '../swings/orchestrator/remote.js';
import { runtime } from '../swings/runtime.js';

const COPY_KEY = 'aretia-swings-recovery-copy';

export function createCrossChainRuntime(evm: EvmSession, isEnabled: (chain: ChainId) => boolean, solanaAddress: () => string | null) {
  const reader = (chain: ChainId) => publicRead(chain);
  const wallets = new WalletSessionManager(null);
  const gateway = new WalletExecutionGateway(wallets, reader, async (r) => window.confirm(`Your wallet is on ${r.from ? CHAINS[r.from].name : 'another network'}. Switch it to ${CHAINS[r.to].name}? Nothing is sent by switching.`), solanaSignatureStatus(rpcCall));
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
  const providers = cctpProviders({ read: reader, solana: { rpc: rpcCall, web3: loadWeb3 } });
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

  /** Makes the page's connected Solana wallet known to the session manager (no prompt: it is already connected). */
  async function adoptSolana(): Promise<void> {
    const host = aretiaWalletHost();
    if (!host || !solanaAddress()) return;
    const wallet = new SolanaContextWallet(host, { rpc: rpcCall });
    await wallet.restore();
    wallets.add(wallet);
    if (!wallets.active) wallets.setActive(wallet.providerId);
  }

  async function adoptWallets(): Promise<void> {
    await adoptWallet();
    await adoptSolana();
  }

  /** The connected account for a chain, or null when no wallet of that kind is connected. */
  const accountFor = (chain: ChainId): string | null => (CHAINS[chain].kind === 'solana' ? solanaAddress() : evm.account);

  /** USDC the account holds on a chain, in raw units, or null if it cannot be read (never read as zero). */
  async function usdcBalance(chain: ChainId, owner: string): Promise<bigint | null> {
    try {
      if (CHAINS[chain].kind === 'solana') {
        const r = await rpcCall<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>('getTokenAccountsByOwner', [owner, { mint: CCTP_USDC.solana }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
        return r.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
      }
      return await readBalance(reader(chain), owner, CCTP_USDC[chain]!);
    } catch {
      return null;
    }
  }

  /** The network's own coin the account holds (pays the claim fee), in raw units, or null if unreadable. */
  async function nativeBalance(chain: ChainId, owner: string): Promise<bigint | null> {
    try {
      if (CHAINS[chain].kind === 'solana') return BigInt((await rpcCall<{ value: number }>('getBalance', [owner, { commitment: 'confirmed' }])).value);
      return await readBalance(reader(chain), owner, EVM_NATIVE_ADDRESS);
    } catch {
      return null;
    }
  }

  return { evm, isEnabled, reader, wallets, gateway, local, mirror, store, providers, engine, orchestrator, adoptWallet: adoptWallets, accountFor, usdcBalance, nativeBalance, solanaAddress, copyOn, setCopy, state };
}

export type CrossChainRuntime = ReturnType<typeof createCrossChainRuntime>;
