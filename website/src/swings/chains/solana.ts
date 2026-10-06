/**
 * Solana, as a ChainAdapter. Delegates to the wallet's existing RPC proxy and signing flow through
 * injected functions (wired in swings/live.ts), so nothing here talks to a key or a network directly.
 */
import { SOLANA_NATIVE_ADDRESS, SwingsError, type ChainAdapter, type PreparedSwap, type TokenRef, type TransactionStatus, type WalletAccount } from '../core/types.js';

export interface SolanaDeps {
  rpc<T>(method: string, params: unknown[]): Promise<T>;
  /** Asks the connected wallet to sign the plan and submits it; resolves to the signature. */
  signAndSubmit(payload: unknown): Promise<string>;
}

interface TokenAccounts {
  value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[];
}

export class SolanaChainAdapter implements ChainAdapter {
  readonly chain = 'solana' as const;
  private submitted = new Set<string>();

  constructor(private readonly deps: SolanaDeps) {}

  async getBalance(account: WalletAccount, token: TokenRef): Promise<bigint> {
    if (account.chain !== 'solana' || token.chain !== 'solana') throw new SwingsError('invalid', 'Not a Solana account or token.');
    if (token.address === SOLANA_NATIVE_ADDRESS) {
      const r = await this.deps.rpc<{ value: number }>('getBalance', [account.address, { commitment: 'confirmed' }]);
      return BigInt(r.value);
    }
    const r = await this.deps.rpc<TokenAccounts>('getTokenAccountsByOwner', [account.address, { mint: token.address }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    return r.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }

  /** Signs and sends once. A quote that was already sent is refused: no duplicate execution, no silent retry. */
  async signAndSubmit(prepared: PreparedSwap): Promise<string> {
    if (prepared.chain !== 'solana') throw new SwingsError('invalid', 'This transaction is not for Solana.');
    if (!prepared.simulation.ok) throw new SwingsError('simulation-failed', 'This swap failed its checks and was not sent.');
    if (this.submitted.has(prepared.quoteId)) throw new SwingsError('invalid', 'This swap was already sent. Check your activity before trying again.');
    this.submitted.add(prepared.quoteId);
    try {
      return await this.deps.signAndSubmit(prepared.payload);
    } catch (e) {
      // Rejected in the wallet: nothing was sent, so the user may try again with the same quote.
      if (/reject|denied|declin|cancel/i.test(e instanceof Error ? e.message : '')) this.submitted.delete(prepared.quoteId);
      throw e;
    }
  }

  async getStatus(txId: string): Promise<TransactionStatus> {
    const r = await this.deps.rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>('getSignatureStatuses', [[txId], { searchTransactionHistory: true }]);
    const s = r.value[0];
    if (!s) return 'submitted';
    if (s.err !== null) return 'failed';
    return s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' ? 'confirmed' : 'submitted';
  }
}
