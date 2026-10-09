/**
 * One adapter for every EVM chain (Ethereum, BNB Chain, Polygon, Base): they differ only by chain id,
 * so adding another EVM network is a CHAINS entry, not new code. It never holds keys; the user's wallet
 * signs and broadcasts.
 */
import { CHAINS, EVM_NATIVE_ADDRESS, SwingsError, type ChainAdapter, type ChainId, type PreparedSwap, type TokenRef, type TransactionStatus, type WalletAccount } from '../core/types.js';
import type { EvmTxRequest, EvmWalletAdapter } from './evmWallet.js';

/** What an EVM provider hands the adapter: an optional approval first, then the swap. */
export interface EvmSwapPayload {
  chainId: number;
  taker: string;
  /** Exact-amount ERC-20 approval, present only when the current allowance is too low. */
  approval: { tx: EvmTxRequest; token: string; spender: string; amount: bigint } | null;
  /** Uniswap V4 only: Permit2's own approval for the router, sent after the token approval and before the swap. */
  permit2?: { tx: EvmTxRequest } | null;
  /** The Aretia fee: a transfer of the fee, in the asset being sold, to the fee address, sent just before the swap. */
  fee?: { tx: EvmTxRequest; token: string; amount: bigint; recipient: string } | null;
  swap: EvmTxRequest;
  /**
   * A second swap that follows this one, for a route that has to go through a middle token (for example ETH to VIRTUAL, then
   * VIRTUAL to an agent token). It is built only after this swap is confirmed, from what actually arrived, so it never guesses
   * an amount. The executor sends this swap, waits for it to be confirmed, then asks for the next one.
   */
  nextStep?: () => Promise<EvmSwapPayload>;
}

export const isEvmPayload = (p: unknown): p is EvmSwapPayload => typeof p === 'object' && p !== null && 'swap' in p && 'chainId' in p && 'taker' in p;

const APPROVE_SELECTOR = '0x095ea7b3';
const BALANCE_OF_SELECTOR = '0x70a08231';
const pad32 = (hexNo0x: string): string => hexNo0x.padStart(64, '0');

/** ERC-20 approve(spender, amount) calldata. Exact amounts only: callers never pass "unlimited". */
export function encodeApprove(spender: string, amount: bigint): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(spender)) throw new SwingsError('invalid', 'Invalid spender address.');
  if (amount <= 0n || amount >= 1n << 256n) throw new SwingsError('invalid', 'Invalid approval amount.');
  return APPROVE_SELECTOR + pad32(spender.slice(2).toLowerCase()) + pad32(amount.toString(16));
}

export interface EvmAdapterOptions {
  /** How long to wait for an approval to be mined before giving up (the swap is then not sent). */
  approvalTimeoutMs?: number;
  pollMs?: number;
  /**
   * Read-only JSON-RPC for this chain (balances, receipts). When given, reads do not depend on which
   * network the wallet is currently on and never prompt a network switch. Writes always go through the wallet.
   */
  read?: (method: string, params: unknown[]) => Promise<unknown>;
}

export class EvmChainAdapter implements ChainAdapter {
  readonly chain: ChainId;
  private readonly chainId: number;
  private readonly sent = new Set<string>();
  /** Quotes whose fee has been paid, so a retried swap never pays it twice. */
  private readonly feePaid = new Set<string>();

  constructor(
    chain: ChainId,
    private readonly wallet: EvmWalletAdapter,
    private readonly options: EvmAdapterOptions = {},
  ) {
    const info = CHAINS[chain];
    if (info.kind !== 'evm' || info.evmChainId === null) throw new SwingsError('invalid', `${info.name} is not an EVM chain.`);
    this.chain = chain;
    this.chainId = info.evmChainId;
  }

  private async onRightChain(): Promise<void> {
    if ((await this.wallet.getChainId()) !== this.chainId) await this.wallet.switchChain(this.chainId);
  }

  async getBalance(account: WalletAccount, token: TokenRef): Promise<bigint> {
    if (account.chain !== this.chain || token.chain !== this.chain) throw new SwingsError('invalid', `Not a ${CHAINS[this.chain].name} account or token.`);
    const read = this.options.read;
    if (!read) await this.onRightChain();
    const call = (m: string, p: unknown[]): Promise<unknown> => (read ? read(m, p) : this.wallet.request(m, p));
    const raw =
      token.address === EVM_NATIVE_ADDRESS
        ? await call('eth_getBalance', [account.address, 'latest'])
        : await call('eth_call', [{ to: token.address, data: BALANCE_OF_SELECTOR + pad32(account.address.slice(2).toLowerCase()) }, 'latest']);
    if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]*$/.test(raw)) throw new SwingsError('invalid', 'The wallet returned an invalid balance.');
    return raw === '0x' ? 0n : BigInt(raw);
  }

  async signAndSubmit(prepared: PreparedSwap): Promise<string> {
    if (prepared.chain !== this.chain || !isEvmPayload(prepared.payload)) throw new SwingsError('invalid', 'This transaction is not for this network.');
    if (!prepared.simulation.ok) throw new SwingsError('simulation-failed', 'This swap failed its checks and was not sent.');
    let p: EvmSwapPayload = prepared.payload;
    if (p.chainId !== this.chainId) throw new SwingsError('invalid', 'The transaction was built for a different network.');
    if (this.sent.has(prepared.quoteId)) throw new SwingsError('invalid', 'This swap was already sent. Check your activity before trying again.');

    await this.onRightChain();
    const accounts = await this.wallet.getAccounts();
    if (accounts[0]?.toLowerCase() !== p.taker.toLowerCase()) throw new SwingsError('invalid', 'The connected account changed. Review the swap again.');

    let hash = await this.sendOne(p, prepared.quoteId);
    // A route through a middle token: the first swap must be confirmed, then the next one is built from what arrived.
    for (let step = 2; p.nextStep; step++) {
      const status = await this.waitForReceipt(hash);
      if (status !== 'confirmed') throw new SwingsError('failed', status === 'failed' ? `Step ${step - 1} of the route failed, so the next step was not sent.` : `Step ${step - 1} of the route is still pending, so the next step was not sent. Check your wallet; once it confirms you will hold the middle token.`);
      let next: EvmSwapPayload;
      try {
        next = await p.nextStep();
      } catch (e) {
        throw new SwingsError('failed', `Step ${step - 1} of the route went through, but step ${step} could not be prepared: ${e instanceof Error ? e.message : 'it was refused'} You now hold the middle token from step ${step - 1}; you can swap it again from there.`);
      }
      if (next.chainId !== this.chainId || next.taker.toLowerCase() !== p.taker.toLowerCase()) throw new SwingsError('invalid', 'The next step of the route is for a different network or account. It was not sent.');
      p = next;
      hash = await this.sendOne(p, `${prepared.quoteId}#${step}`);
    }
    return hash;
  }

  /** One payload, in order: approval, Permit2 approval, the Aretia fee, then the swap. Each is confirmed before the next is sent. */
  private async sendOne(p: EvmSwapPayload, quoteId: string): Promise<string> {
    if (p.approval) {
      // Approval first, exact amount, and only continue once it is mined: the swap is never sent on a guess.
      const hash = await this.wallet.sendTransaction(p.approval.tx);
      const status = await this.waitForReceipt(hash);
      if (status !== 'confirmed') throw new SwingsError('failed', status === 'failed' ? 'The approval transaction failed. The swap was not sent.' : 'The approval is still pending. The swap was not sent; check your wallet, then get a new quote.');
    }
    if (p.permit2) {
      const hash = await this.wallet.sendTransaction(p.permit2.tx);
      const status = await this.waitForReceipt(hash);
      if (status !== 'confirmed') throw new SwingsError('failed', status === 'failed' ? 'The second approval transaction failed. The swap was not sent.' : 'The second approval is still pending. The swap was not sent; check your wallet, then get a new quote.');
    }
    if (p.fee && !this.feePaid.has(quoteId)) {
      // The fee is its own transaction, confirmed before the swap is sent, and never sent twice for one quote.
      const hash = await this.wallet.sendTransaction(p.fee.tx);
      const status = await this.waitForReceipt(hash);
      if (status !== 'confirmed') throw new SwingsError('failed', status === 'failed' ? 'The fee transaction failed. The swap was not sent.' : 'The fee transaction is still pending. The swap was not sent; check your wallet, then get a new quote.');
      this.feePaid.add(quoteId);
    }
    this.sent.add(quoteId);
    try {
      return await this.wallet.sendTransaction(p.swap);
    } catch (e) {
      if (e instanceof SwingsError && e.code === 'rejected') this.sent.delete(quoteId);
      throw e;
    }
  }

  async getStatus(txId: string): Promise<TransactionStatus> {
    const receipt = this.options.read ? await this.options.read('eth_getTransactionReceipt', [txId]) : await this.wallet.request('eth_getTransactionReceipt', [txId]);
    if (receipt === null || receipt === undefined) return 'submitted';
    const status = (receipt as { status?: string }).status;
    return status === '0x1' ? 'confirmed' : 'failed';
  }

  private async waitForReceipt(hash: string): Promise<'confirmed' | 'failed' | 'pending'> {
    const deadline = Date.now() + (this.options.approvalTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      const s = await this.getStatus(hash);
      if (s === 'confirmed' || s === 'failed') return s;
      await new Promise((r) => setTimeout(r, this.options.pollMs ?? 2_000));
    }
    return 'pending';
  }
}
