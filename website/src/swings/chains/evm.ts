/**
 * One adapter for every EVM chain (Ethereum, BNB Chain, Polygon, Base): they differ only by chain id,
 * so adding another EVM network is a CHAINS entry, not new code. It never holds keys; the user's wallet
 * signs and broadcasts.
 */
import { noteFeeTx } from '../referrals/feeTxLog.js';
import { RECEIPT_TIMEOUT_MS } from '../router/budget.js';
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

/** How long a fee paid for a swap that was then not sent still counts for a retry of the same swap. */
export const FEE_PAID_WINDOW_MS = 10 * 60_000;
const FEE_PAID_STORAGE_KEY = 'aretia.swings.evmFeePaid';

/** Where "fee already paid" is remembered: sessionStorage in the browser, so a reload or a new quote does not charge again. */
export interface FeePaidStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const sessionStore = (): FeePaidStore | null => {
  try {
    const st = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    return st ? { get: (k) => st.getItem(k), set: (k, v) => st.setItem(k, v) } : null;
  } catch {
    return null;
  }
};

export interface EvmAdapterOptions {
  /** How long to wait for an approval to be mined before giving up (the swap is then not sent). */
  approvalTimeoutMs?: number;
  pollMs?: number;
  /**
   * Read-only JSON-RPC for this chain (balances, receipts). When given, reads do not depend on which
   * network the wallet is currently on and never prompt a network switch. Writes always go through the wallet.
   */
  read?: (method: string, params: unknown[]) => Promise<unknown>;
  /** Defaults to sessionStorage when there is one. */
  feeStore?: FeePaidStore | null;
  now?: () => number;
}

export class EvmChainAdapter implements ChainAdapter {
  readonly chain: ChainId;
  private readonly chainId: number;
  private readonly sent = new Set<string>();
  /**
   * Fees paid on their own whose swap was then not sent, keyed by what was paid (taker, chain, token, amount) rather than by quote:
   * a retry always comes with a new quote, and must not pay again. Kept for FEE_PAID_WINDOW_MS, in sessionStorage when there is one.
   */
  private readonly feePaid = new Map<string, number>();

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

  private feeKey(p: EvmSwapPayload): string | null {
    return p.fee ? `${this.chainId}:${p.taker.toLowerCase()}:${p.fee.token.toLowerCase()}:${p.fee.amount}` : null;
  }

  private feeLedger(): Record<string, number> {
    const now = (this.options.now ?? Date.now)();
    const out: Record<string, number> = {};
    const store = this.options.feeStore === undefined ? sessionStore() : this.options.feeStore;
    let saved: unknown;
    try {
      saved = JSON.parse(store?.get(FEE_PAID_STORAGE_KEY) ?? 'null');
    } catch {
      saved = null;
    }
    for (const [k, at] of [...Object.entries(typeof saved === 'object' && saved !== null ? saved : {}), ...this.feePaid.entries()]) {
      if (typeof at === 'number' && now - at < FEE_PAID_WINDOW_MS) out[k] = at;
    }
    return out;
  }

  private setFeePaid(key: string, paid: boolean): void {
    const ledger = this.feeLedger();
    if (paid) {
      ledger[key] = (this.options.now ?? Date.now)();
      this.feePaid.set(key, ledger[key]);
    } else {
      delete ledger[key];
      this.feePaid.delete(key);
    }
    try {
      (this.options.feeStore === undefined ? sessionStore() : this.options.feeStore)?.set(FEE_PAID_STORAGE_KEY, JSON.stringify(ledger));
    } catch {
      // Storage full or blocked: the in-memory record still covers this page.
    }
  }

  private feeAlreadyPaid(p: EvmSwapPayload): boolean {
    const key = this.feeKey(p);
    return key !== null && key in this.feeLedger();
  }

  private async onRightChain(): Promise<void> {
    if ((await this.wallet.getChainId()) !== this.chainId) await this.wallet.switchChain(this.chainId);
  }

  /**
   * Every transaction goes through here: it is bound to this chain by its chainId, and the wallet's network and account are
   * read again right before it is sent, so a switch in the wallet halfway through a swap (between the approval, the fee and the
   * swap, or the steps of a route) stops the swap instead of sending the rest somewhere else.
   */
  private async send(tx: EvmTxRequest, taker: string): Promise<string> {
    const chainId = '0x' + this.chainId.toString(16);
    if (tx.chainId !== undefined && tx.chainId.toLowerCase() !== chainId) throw new SwingsError('invalid', 'The transaction was built for a different network.');
    await this.stillSame(taker);
    return this.wallet.sendTransaction({ ...tx, chainId });
  }

  private async stillSame(taker: string): Promise<void> {
    if ((await this.wallet.getChainId()) !== this.chainId) throw new SwingsError('invalid', `Your wallet switched away from ${CHAINS[this.chain].name}. Nothing more was sent; check your wallet activity, then review the swap again.`);
    const accounts = await this.wallet.getAccounts();
    if (accounts[0]?.toLowerCase() !== taker.toLowerCase()) throw new SwingsError('invalid', 'The connected account changed. Nothing more was sent; review the swap again.');
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

  /**
   * One payload. When the wallet can send an all-or-nothing batch (EIP-5792) everything goes in ONE confirmation: the
   * approval, the Permit2 approval, the Aretia fee and the swap, in that order. Otherwise they go one at a time, each
   * confirmed before the next is sent.
   */
  private async sendOne(p: EvmSwapPayload, quoteId: string): Promise<string> {
    const calls: EvmTxRequest[] = [];
    if (p.approval) calls.push(p.approval.tx);
    if (p.permit2) calls.push(p.permit2.tx);
    const feeDue = !!p.fee && !this.feeAlreadyPaid(p);
    const feeKey = this.feeKey(p);
    if (p.fee && feeDue) calls.push(p.fee.tx);
    calls.push(p.swap);
    if (calls.length > 1 && this.wallet.sendBatch && this.wallet.supportsBatch && (await this.wallet.supportsBatch(this.chainId, p.taker).catch(() => false))) {
      await this.stillSame(p.taker);
      this.sent.add(quoteId);
      try {
        const hash = await this.wallet.sendBatch(this.chainId, p.taker, calls);
        // The swap went with the fee, so a fee paid earlier on its own for it has now been used. (A batch answers a batch id, not a
        // transaction hash, so its receipt cannot be awaited here as the single-swap path does.)
        if (feeKey) this.setFeePaid(feeKey, false);
        return hash;
      } catch (e) {
        // Declined, or failed after it was sent: no fallback (it would ask again, or repeat a failed swap).
        if (!(e instanceof SwingsError && e.code === 'not-enabled')) {
          // Declined, or the wallet never sent it: nothing is out there, so the same swap may be tried again.
          if (e instanceof SwingsError && (e.code === 'rejected' || e.code === 'not-sent')) this.sent.delete(quoteId);
          throw e;
        }
        // The wallet turned out not to batch: nothing was sent, so go one at a time.
        this.sent.delete(quoteId);
      }
    }
    if (p.approval) {
      // Approval first, exact amount, and only continue once it is mined: the swap is never sent on a guess.
      const hash = await this.send(p.approval.tx, p.taker);
      const status = await this.waitForReceipt(hash);
      if (status !== 'confirmed') throw new SwingsError('failed', status === 'failed' ? 'The approval transaction failed. The swap was not sent.' : 'The approval is still pending. The swap was not sent; check your wallet, then get a new quote.');
    }
    if (p.permit2) {
      const hash = await this.send(p.permit2.tx, p.taker);
      const status = await this.waitForReceipt(hash);
      if (status !== 'confirmed') throw new SwingsError('failed', status === 'failed' ? 'The second approval transaction failed. The swap was not sent.' : 'The second approval is still pending. The swap was not sent; check your wallet, then get a new quote.');
    }
    if (p.fee && feeKey && feeDue) {
      // Paid on its own, the fee cannot be taken back if the swap then fails. So the swap is tried on the node first, as it stands now
      // (after any approval above, and however long the person took to confirm): if it would fail, nothing more is sent, fee included.
      await this.swapWouldSucceed(p.swap);
      // The fee is its own transaction, confirmed before the swap is sent, and never sent twice for one quote.
      const hash = await this.send(p.fee.tx, p.taker);
      noteFeeTx(this.chain, hash);
      const status = await this.waitForReceipt(hash);
      if (status !== 'confirmed') throw new SwingsError('failed', status === 'failed' ? 'The fee transaction failed. The swap was not sent.' : 'The fee transaction is still pending. The swap was not sent; check your wallet, then get a new quote.');
      this.setFeePaid(feeKey, true);
      // Time has passed while the fee was confirmed: the swap is tried again before the wallet is asked for it. If it would now fail,
      // the fee stays recorded as paid, so trying the same swap again does not charge it twice.
      await this.swapWouldSucceed(p.swap);
    }
    this.sent.add(quoteId);
    try {
      const hash = await this.send(p.swap, p.taker);
      if (feeKey) this.clearFeeWhenConfirmed(feeKey, hash);
      return hash;
    } catch (e) {
      if (e instanceof SwingsError && e.code === 'rejected') this.sent.delete(quoteId);
      throw e;
    }
  }

  /**
   * Forgets a separately paid fee only once the swap it paid for is confirmed. A swap that reverts on-chain, or is still pending,
   * leaves the fee recorded for its window, so trying again does not charge it twice.
   */
  private clearFeeWhenConfirmed(feeKey: string, hash: string): void {
    void this.waitForReceipt(hash)
      .then((status) => {
        if (status === 'confirmed') this.setFeePaid(feeKey, false);
      })
      .catch(() => undefined);
  }

  /**
   * Whether a sent transaction has been mined. A node that cannot answer is never read as "failed": the public node is asked
   * first, then the wallet's own node, and if neither answers the transaction is simply not confirmed yet. (A public node can
   * refuse the receipt of a transaction it has not seen yet; treating that as a failure told people a swap had failed when
   * it had not.)
   */
  async getStatus(txId: string): Promise<TransactionStatus> {
    let receipt: unknown;
    try {
      receipt = this.options.read ? await this.options.read('eth_getTransactionReceipt', [txId]) : await this.wallet.request('eth_getTransactionReceipt', [txId]);
    } catch {
      try {
        receipt = await this.wallet.request('eth_getTransactionReceipt', [txId]);
      } catch {
        return 'submitted';
      }
    }
    if (receipt === null || receipt === undefined) return 'submitted';
    const status = (receipt as { status?: string }).status;
    return status === '0x1' ? 'confirmed' : 'failed';
  }

  /**
   * Throws when the swap would revert right now. A node a block behind can still miss an approval that was just mined, so a refusal is
   * asked again a few times before it counts. Without a read-only node (tests, older callers) the check is skipped.
   */
  private async swapWouldSucceed(swap: EvmTxRequest): Promise<void> {
    const read = this.options.read;
    if (!read) return;
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await read('eth_call', [{ from: swap.from, to: swap.to, data: swap.data, value: swap.value ?? '0x0' }, 'latest']);
        return;
      } catch (e) {
        last = e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, this.options.pollMs ?? 2_000));
      }
    }
    const why = last instanceof Error ? ` (${last.message.slice(0, 160)})` : '';
    throw new SwingsError('simulation-failed', `The swap would fail on the network right now${why}, so neither the Aretia fee nor the swap was sent. Get a new quote and try again.`);
  }

  private async waitForReceipt(hash: string): Promise<'confirmed' | 'failed' | 'pending'> {
    const deadline = Date.now() + (this.options.approvalTimeoutMs ?? RECEIPT_TIMEOUT_MS);
    while (Date.now() < deadline) {
      const s = await this.getStatus(hash);
      if (s === 'confirmed' || s === 'failed') return s;
      await new Promise((r) => setTimeout(r, this.options.pollMs ?? 2_000));
    }
    return 'pending';
  }
}
