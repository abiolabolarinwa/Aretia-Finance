/**
 * The orchestrator's connection to the user's real wallet. Every send goes through the same checks as a swap:
 * the wallet must be connected, on the right network, and be the account the quote names; the transaction must call
 * only addresses the provider declared; the wallet is re-read just before signing. Any failure means nothing is signed.
 */
import { SwingsError, type ChainId } from '../core/types.js';
import type { EvmRead } from '../chains/evmSession.js';
import type { SettlementTransaction } from '../settlement/types.js';
import { ensureNetwork, verifyBeforeExecute, type NetworkSwitchRequest } from '../wallet/safety.js';
import type { WalletSessionManager } from '../wallet/sessionManager.js';
import type { ExecutionGateway } from './orchestrator.js';

export class WalletExecutionGateway implements ExecutionGateway {
  constructor(
    private readonly wallets: WalletSessionManager,
    private readonly read: (chain: ChainId) => EvmRead,
    /** Asks the user before the wallet is moved to another network. Without it a wrong network is simply refused. */
    private readonly confirmSwitch?: (request: NetworkSwitchRequest) => Promise<boolean>,
    /** Where a Solana transaction stands. Without it Solana confirmations are refused rather than guessed. */
    private readonly solanaStatus?: (signature: string) => Promise<'confirmed' | 'failed' | 'pending'>,
  ) {}

  async send(tx: SettlementTransaction, expect: { address: string; allowedDestinations: readonly string[] }): Promise<string> {
    if (expect.allowedDestinations.length === 0) throw new SwingsError('invalid', 'The provider declared no addresses this transaction may call, so it is refused.');
    const lease = this.wallets.lease(tx.chain);
    const same = tx.unsigned.kind === 'evm' ? lease.address.toLowerCase() === expect.address.toLowerCase() : lease.address === expect.address;
    if (!same) throw new SwingsError('invalid', 'The connected wallet is not the account this settlement was made for. Connect that account to continue.');
    if (this.confirmSwitch && tx.unsigned.kind === 'evm') {
      const w = this.wallets.walletFor(tx.chain);
      if (w && w.getSession().chain !== tx.chain) await ensureNetwork(w, tx.chain, this.confirmSwitch);
    }
    const fresh = this.wallets.lease(tx.chain);
    const wallet = await this.wallets.redeem(fresh, { allowedDestinations: expect.allowedDestinations });
    const problems = await verifyBeforeExecute(wallet, { address: expect.address, chain: tx.chain, allowedDestinations: expect.allowedDestinations, revision: fresh.revision }, tx.unsigned);
    if (problems.length > 0) throw new SwingsError('invalid', problems[0]!);
    return wallet.sendTransaction(tx.unsigned);
  }

  async confirmation(chain: ChainId, hash: string): Promise<'confirmed' | 'failed' | 'pending'> {
    if (chain === 'solana') {
      if (!this.solanaStatus) throw new SwingsError('invalid', 'Solana confirmations are not available here.');
      return this.solanaStatus(hash);
    }
    const receipt = (await this.read(chain)('eth_getTransactionReceipt', [hash])) as { status?: string } | null;
    if (!receipt) return 'pending';
    return receipt.status === '0x1' ? 'confirmed' : 'failed';
  }
}

type SolRpcCall = <T>(method: string, params: unknown[]) => Promise<T>;

/** Reads a Solana transaction's outcome. "Confirmed" needs the cluster to say confirmed or finalized and no error. */
export function solanaSignatureStatus(rpc: SolRpcCall): (signature: string) => Promise<'confirmed' | 'failed' | 'pending'> {
  return async (signature) => {
    const r = await rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
    const s = r.value[0];
    if (!s) return 'pending';
    if (s.err) return 'failed';
    return s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' ? 'confirmed' : 'pending';
  };
}
