/**
 * Limit orders on Ethereum-style chains: the steps, with every outside dependency passed in so each path can be tested without a network or
 * a wallet. walletOrdersEvm.ts connects it to the page.
 *
 *   loadMarket     read the token, the payment asset, the contract's smallest order, the exchange pool and what the wallet holds
 *   prepare*       work out the numbers, build the transactions, check them, and price the gas
 *   place/cancel   check each transaction against what was approved (an independent inspector), try it, have the wallet send it, wait for the
 *                  receipt, then read the result back from the chain
 * An approval and the order it enables are two transactions. If the second cannot go ahead the approval stays in place for exactly the amount
 * approved and nothing else has happened; the error says so.
 */
import { SwingsError } from '../swings/core/types.js';
import type { EvmTxRequest } from '../swings/chains/evmWallet.js';
import { decodeAbiString } from '../swings/chains/evmSession.js';
import type { EvmFlowDeps } from './walletLaunchEvmFlow';
import { keccak256 } from '../swings/core/keccak.js';
import { SEL as POOL_SEL } from './walletPoolEvmTx';
import { findFactoryNonce } from './walletCurveEvmCore';
import {
  evmLimitPrice,
  evmOrderDisclosures,
  evmOrderTerms,
  parseEvmOrder,
  previewEvmOrder,
  validateEvmOrder,
  type EvmOrderForm,
  type EvmOrderIssue,
  type EvmOrderPreview,
  type EvmOrderRecord,
  type EvmOrdersChain,
  type EvmQuote,
} from './walletOrdersEvmCore';
import type { OrderTerms } from './walletOrdersCore';
import {
  ORDER_CREATED_TOPIC,
  buildProveTx,
  inspectProve,
  provenReadData,
  buildCancelOrderTx,
  buildCreateNativeBuyTx,
  buildCreateOrderTx,
  buildOrderApproveTx,
  inspectCancelOrder,
  inspectCreateOrder,
  inspectOrderApprove,
  minAmountReadData,
  orderReadData,
} from './walletOrdersEvmTx';

export class EvmOrdersError extends Error {
  constructor(
    message: string,
    readonly nothingSent = false,
  ) {
    super(message);
  }
}

export type EvmOrdersProgress = 'checking' | 'proving' | 'confirming-proof' | 'approving' | 'confirming-approve' | 'sending' | 'confirming' | 'verifying' | 'done';

export interface EvmMarket {
  chain: EvmOrdersChain;
  token: string;
  symbol: string;
  decimals: number;
  quote: EvmQuote;
  /** The contract's smallest order for the payment asset, in its base units. 0 means not switched on. */
  minQuote: bigint;
  tokenBalance: bigint;
  /** The payment asset held (for the chain's coin, the coin itself). */
  quoteBalance: bigint;
  coinBalance: bigint;
  /** The orders contract already knows the factory made this token. */
  proven: boolean;
  /** The factory nonce that makes the token's address, found locally; null if the factory did not make it. */
  proofNonce: bigint | null;
}

interface ReviewBase {
  chain: EvmOrdersChain;
  account: string;
  gasCostWei: bigint | null;
  coinBalance: bigint;
  blockers: string[];
}
export interface EvmPlaceReview extends ReviewBase {
  kind: 'place';
  market: EvmMarket;
  terms: OrderTerms;
  preview: EvmOrderPreview;
  disclosures: { severity: 'info' | 'caution'; text: string }[];
  /** Present when the contract has not yet been shown that the factory made this token. Sent first, once per token. */
  proveTx: EvmTxRequest | null;
  /** Present when the contract needs an allowance first. */
  approveTx: EvmTxRequest | null;
  tx: EvmTxRequest;
  /** A buy paid in the chain's own coin, which the contract wraps. */
  isNative: boolean;
}
export interface EvmCancelReview extends ReviewBase {
  kind: 'cancel';
  order: EvmOrderRecord;
  tx: EvmTxRequest;
}
export interface EvmOrdersOutcome {
  hashes: string[];
  id: bigint | null;
  differences: string[];
}
export interface EvmOrderRow {
  record: EvmOrderRecord;
  symbol: string | null;
  decimals: number | null;
  quote: EvmQuote | null;
  limit: bigint | null;
}

const GAS_MARGIN_NUM = 12n;
const GAS_MARGIN_DEN = 10n;
const asBig = (v: unknown): bigint | null => (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : null);
const wordOf = (v: unknown): bigint | null => (typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) ? BigInt(v) : null);
const pad = (a: string): string => a.slice(2).toLowerCase().padStart(64, '0');
const enc = new TextEncoder();
const sel = (sig: string): string =>
  '0x' +
  [...keccak256(enc.encode(sig))]
    .slice(0, 4)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
const SEL = { decimals: sel('decimals()'), symbol: sel('symbol()'), balanceOf: sel('balanceOf(address)'), allowance: sel('allowance(address,address)') };

/** The contract's own refusals, by their error selector, in words. The node reports them as hex data inside its message. */
const ERROR_WORDS: [string, string][] = [
  ['NotALaunchToken()', 'this is not an Aretia Launch token'],
  ['QuoteNotEnabled()', 'orders in this payment asset are not switched on'],
  ['BelowMinimum()', 'the order is smaller than the minimum'],
  ['Paused()', 'orders are paused'],
  ['TokenTakesAFee()', 'this token takes a fee on transfer, which orders do not support'],
  ['ZeroAmount()', 'the amount is zero'],
  ['SameToken()', 'the token and the payment asset are the same'],
  ['NotOwner()', 'only the order’s owner can do this'],
  ['NoSuchOrder()', 'there is no such order'],
].map(([sig, words]) => [sel(sig!).slice(2), words!]);
const REASONS: [RegExp, string][] = [
  [/allowance|insufficient allowance/i, ': the approval is missing'],
  [/OutOfFunds|insufficient funds|exceeds balance/i, ': your wallet holds less than the amount plus the network fee'],
];
function reasonOf(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const lower = text.toLowerCase();
  for (const [selector, words] of ERROR_WORDS) if (lower.includes(selector)) return `: ${words}`;
  for (const [re, words] of REASONS) if (re.test(text)) return words;
  return '';
}

export class EvmOrdersFlow {
  constructor(private readonly d: EvmFlowDeps) {}

  private sleep = (ms: number) => (this.d.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);
  private call = (to: string, data: string): Promise<unknown> => this.d.read('eth_call', [{ to, data }, 'latest']);

  // ---------------------------------------------------------------- reading

  async loadMarket(chain: EvmOrdersChain, owner: string, token: string, quote: EvmQuote): Promise<EvmMarket | { problem: string }> {
    const code = await this.d.read('eth_getCode', [token, 'latest']);
    if (typeof code !== 'string' || code === '0x') return { problem: 'There is no token at that address on this network.' };
    const orderCode = await this.d.read('eth_getCode', [chain.orders, 'latest']);
    if (typeof orderCode !== 'string' || orderCode === '0x') return { problem: 'The Aretia orders contract is not on this network at the address this page expects.' };
    let reads: unknown[];
    try {
      reads = await Promise.all([
        this.call(token, SEL.decimals),
        this.call(token, SEL.symbol),
        this.call(token, SEL.balanceOf + pad(owner)),
        this.call(chain.orders, minAmountReadData(quote.address)),
        this.call(quote.address, SEL.balanceOf + pad(owner)),
        this.d.read('eth_getBalance', [owner, 'latest']),
        this.call(chain.orders, provenReadData(token)),
        this.d.read('eth_getTransactionCount', [chain.factory, 'latest']),
      ]);
    } catch {
      return { problem: 'That address is not a token this page can read.' };
    }
    const [dec, sym, held, min, qBal, coin, provenWord, factoryCount] = reads;
    const decimals = wordOf(dec);
    const symbol = decodeAbiString(sym);
    const tokenBalance = wordOf(held);
    const minQuote = wordOf(min);
    const quoteBalance = wordOf(qBal);
    const coinBalance = asBig(coin);
    if (decimals === null || decimals > 36n || symbol === null || tokenBalance === null || minQuote === null || quoteBalance === null || coinBalance === null)
      return { problem: 'That address is not a token this page can read.' };
    if (minQuote === 0n) return { problem: `Limit orders in ${quote.symbol} are not switched on.` };
    const proven = wordOf(provenWord) === 1n;
    const count = asBig(factoryCount);
    // Only the factory's own tokens can have orders: the contract is shown the factory made one by the token's address.
    const proofNonce = proven || count === null ? null : findFactoryNonce(chain.factory, token, count);
    if (!proven && proofNonce === null) return { problem: 'This token was not made by Aretia’s token factory, so it cannot have limit orders.' };
    // An order can only ever fill if the token has a real pool against the payment asset on the exchange the contract uses.
    const pair = await this.pool(chain, token, quote.address);
    if (!pair) return { problem: `This token has no ${quote.symbol} pool on ${chain.name}, so an order in ${quote.symbol} could never fill.` };
    return {
      chain,
      token: token.toLowerCase(),
      symbol,
      decimals: Number(decimals),
      quote,
      minQuote,
      tokenBalance,
      quoteBalance: quote.native ? coinBalance : quoteBalance,
      coinBalance,
      proven,
      proofNonce,
    };
  }

  /** True when the exchange has a pair for the two tokens with something on both sides. */
  private async pool(chain: EvmOrdersChain, a: string, b: string): Promise<boolean> {
    try {
      const got = await this.call(chain.pairFactory, POOL_SEL.getPair + pad(a) + pad(b));
      if (typeof got !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(got)) return false;
      const pair = '0x' + got.slice(26).toLowerCase();
      if (/^0x0{40}$/.test(pair)) return false;
      const res = await this.call(pair, POOL_SEL.getReserves);
      if (typeof res !== 'string' || !/^0x[0-9a-fA-F]{192}$/.test(res)) return false;
      return BigInt('0x' + res.slice(2, 66)) > 0n && BigInt('0x' + res.slice(66, 130)) > 0n;
    } catch {
      return false;
    }
  }

  async allowanceOf(token: string, owner: string, chain: EvmOrdersChain): Promise<bigint> {
    return wordOf(await this.call(token, SEL.allowance + pad(owner) + pad(chain.orders))) ?? 0n;
  }

  /** The owner's open orders: found by the creation events that name them, then read from the contract. Anything malformed is left out. */
  async listOrders(chain: EvmOrdersChain, owner: string): Promise<EvmOrderRow[]> {
    const logs = (await this.d.read('eth_getLogs', [
      { address: chain.orders, fromBlock: '0x' + chain.fromBlock.toString(16), toBlock: 'latest', topics: [ORDER_CREATED_TOPIC, null, '0x' + pad(owner)] },
    ])) as { topics?: string[] }[];
    const rows: EvmOrderRow[] = [];
    const meta = new Map<string, { symbol: string | null; decimals: number | null }>();
    for (const l of Array.isArray(logs) ? logs : []) {
      const idWord = l.topics?.[1];
      const id = typeof idWord === 'string' && /^0x[0-9a-fA-F]{64}$/.test(idWord) ? BigInt(idWord) : null;
      if (id === null) continue;
      const record = parseEvmOrder(id, await this.call(chain.orders, orderReadData(id)));
      if (!record || record.owner !== owner.toLowerCase() || record.inRemaining === 0n) continue;
      if (!meta.has(record.launchToken)) {
        try {
          const [dec, sym] = await Promise.all([this.call(record.launchToken, SEL.decimals), this.call(record.launchToken, SEL.symbol)]);
          const dv = wordOf(dec);
          meta.set(record.launchToken, { symbol: decodeAbiString(sym), decimals: dv === null ? null : Number(dv) });
        } catch {
          meta.set(record.launchToken, { symbol: null, decimals: null });
        }
      }
      const m = meta.get(record.launchToken)!;
      const quote = chain.quotes.find((q) => q.address === record.quoteToken) ?? null;
      rows.push({ record, symbol: m.symbol, decimals: m.decimals, quote, limit: m.decimals === null || !quote ? null : evmLimitPrice(record, m.decimals) });
    }
    return rows;
  }

  private async gasPrice(): Promise<bigint | null> {
    return asBig(await this.d.read('eth_gasPrice', []));
  }

  private lastEstimateFailure = '';
  private async estimate(tx: EvmTxRequest): Promise<bigint | null> {
    this.lastEstimateFailure = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const g = asBig(await this.d.read('eth_estimateGas', [tx]));
        if (g !== null) return (g * GAS_MARGIN_NUM) / GAS_MARGIN_DEN;
        this.lastEstimateFailure = ': the network did not give a number';
      } catch (e) {
        this.lastEstimateFailure = reasonOf(e) || `: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 140)}`;
      }
      if (attempt === 0) await this.sleep(1500);
    }
    return null;
  }

  private async checkChain(chain: EvmOrdersChain, blockers: string[]): Promise<boolean> {
    if (asBig(await this.d.read('eth_chainId', [])) !== BigInt(chain.chainId)) {
      blockers.push('The network node did not answer as the right network. Try again in a moment.');
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- placing

  prepareForm(form: EvmOrderForm, market: EvmMarket): { issues: EvmOrderIssue[]; terms: OrderTerms | null } {
    // A coin-paid buy keeps a little back for gas; the review checks the exact figure.
    const available = form.side === 'buy' ? market.quoteBalance : market.tokenBalance;
    const issues = validateEvmOrder(form, { tokenDecimals: market.decimals, quote: market.quote, minQuote: market.minQuote, available });
    return { issues, terms: issues.length ? null : evmOrderTerms(form, market.decimals, market.quote) };
  }

  async preparePlace(account: string, market: EvmMarket, terms: OrderTerms): Promise<EvmPlaceReview> {
    const { chain, quote } = market;
    const blockers: string[] = [];
    const native = terms.side === 'buy' && quote.native;
    const escrowToken = terms.side === 'buy' ? quote.address : market.token;
    const isBuy = terms.side === 'buy';
    const proveTx: EvmTxRequest | null = !market.proven && market.proofNonce !== null ? buildProveTx(account, chain, market.token, market.proofNonce) : null;
    let approveTx: EvmTxRequest | null = null;
    let gasCostWei: bigint | null = null;
    let coinBalance = 0n;
    const tx: EvmTxRequest = native
      ? buildCreateNativeBuyTx(account, chain, { launchToken: market.token, wei: terms.amountIn, minOut: terms.minOut })
      : buildCreateOrderTx(account, chain, { launchToken: market.token, quoteToken: quote.address, isBuy, amountIn: terms.amountIn, minOut: terms.minOut });
    try {
      if (await this.checkChain(chain, blockers)) {
        coinBalance = asBig(await this.d.read('eth_getBalance', [account, 'latest'])) ?? 0n;
        const gasEstimates: bigint[] = [];
        const price = await this.gasPrice();
        if (proveTx) {
          const g = await this.estimate(proveTx);
          if (g === null) blockers.push(`The network would not accept the proof, so nothing was sent${this.lastEstimateFailure}.`);
          else gasEstimates.push(g);
        }
        if (!native) {
          const allowance = await this.allowanceOf(escrowToken, account, chain);
          if (allowance < terms.amountIn) {
            approveTx = buildOrderApproveTx(account, escrowToken, chain, terms.amountIn);
            // With a proof still to send, the approval cannot be estimated against the real state either way: it does not depend on it.
            const g = await this.estimate(approveTx);
            if (g === null) blockers.push(`The network would not accept the approval, so nothing was sent${this.lastEstimateFailure}.`);
            else gasEstimates.push(g);
          }
        }
        // The order itself can only be estimated once the contract may take the money; before that, the estimate would fail for that reason alone.
        if (approveTx === null && proveTx === null) {
          const g = await this.estimate(tx);
          if (g === null) blockers.push(`The network would not accept this order, so nothing was sent${this.lastEstimateFailure}.`);
          else gasEstimates.push(g);
        } else gasEstimates.push(260_000n);
        if (price !== null && gasEstimates.length) {
          gasCostWei = gasEstimates.reduce((a, b) => a + b, 0n) * price;
          const needed = (native ? terms.amountIn : 0n) + gasCostWei;
          if (coinBalance < needed) blockers.push(`You need more ${chain.symbol}: ${native ? 'the amount you are paying plus ' : ''}the network gas.`);
        }
        if (isBuy && !native && terms.amountIn > market.quoteBalance) blockers.push(`More ${quote.symbol} than your wallet holds.`);
        if (!isBuy && terms.amountIn > market.tokenBalance) blockers.push('More than your wallet holds of this token.');
      }
    } catch {
      blockers.push('The network could not be reached to check this order. Try again in a moment.');
    }
    return {
      kind: 'place',
      chain,
      account,
      market,
      terms,
      preview: previewEvmOrder(terms, market.decimals, quote),
      disclosures: evmOrderDisclosures(terms.side, quote, chain),
      proveTx,
      approveTx,
      tx,
      isNative: native,
      gasCostWei,
      coinBalance,
      blockers,
    };
  }

  async place(review: EvmPlaceReview, progress: (p: EvmOrdersProgress) => void = () => undefined): Promise<EvmOrdersOutcome> {
    const { chain, market, terms } = review;
    await this.begin(review, progress);
    const hashes: string[] = [];
    const escrowToken = terms.side === 'buy' ? market.quote.address : market.token;
    if (review.proveTx) {
      const nonce = market.proofNonce;
      if (nonce === null) throw new EvmOrdersError('The proof for this token is missing. Start again.', true);
      hashes.push(
        await this.runTx(review.proveTx, (tx, id) => inspectProve(tx, { chain, from: review.account, token: market.token, factoryNonce: nonce }, id), 'proof', progress, 'proving', 'confirming-proof'),
      );
    }
    if (review.approveTx) {
      hashes.push(
        await this.runTx(
          review.approveTx,
          (tx, id) => inspectOrderApprove(tx, { chain, from: review.account, token: escrowToken, amount: terms.amountIn }, id),
          'approval',
          progress,
          'approving',
          'confirming-approve',
        ),
      );
    }
    const check = {
      chain,
      from: review.account,
      launchToken: market.token,
      quoteToken: market.quote.address,
      isBuy: terms.side === 'buy',
      amountIn: terms.amountIn,
      minOut: terms.minOut,
      native: review.isNative,
    };
    let hash: string;
    try {
      hash = await this.runTx(review.tx, (tx, id) => inspectCreateOrder(tx, check, id), 'order', progress, 'sending', 'confirming');
    } catch (e) {
      if ((review.approveTx || review.proveTx) && e instanceof EvmOrdersError)
        throw new EvmOrdersError(
          review.approveTx
            ? `${e.message} Your approval went through: the orders contract may take exactly ${terms.amountIn} base units of the ${terms.side === 'buy' ? market.quote.symbol : market.symbol}, and nothing else has happened.`
            : `${e.message} The proof went through (it only shows the contract that Aretia’s factory made this token); nothing else has happened.`,
          e.nothingSent,
        );
      throw e;
    }
    hashes.push(hash);
    progress('verifying');
    const differences: string[] = [];
    const id = await this.createdId(hash, chain, review.account);
    if (id === null) differences.push('The new order could not be found in the transaction’s receipt.');
    else {
      const rec = await this.readBack(async () => parseEvmOrder(id, await this.call(chain.orders, orderReadData(id))));
      if (!rec) differences.push('The new order could not be read back from the network.');
      else {
        if (rec.owner !== review.account.toLowerCase()) differences.push('The order names a different owner.');
        if (rec.launchToken !== market.token) differences.push('The order is for a different token.');
        if (rec.quoteToken !== market.quote.address) differences.push('The order is paid in a different asset.');
        if (rec.isBuy !== (terms.side === 'buy')) differences.push('The order is on the wrong side.');
        if (rec.inTotal !== terms.amountIn || rec.inRemaining !== terms.amountIn) differences.push('The order holds a different amount than you approved.');
        if (rec.minOutRemaining !== terms.minOut) differences.push('The order’s price is not the one you approved.');
      }
    }
    progress('done');
    return { hashes, id, differences };
  }

  private async createdId(hash: string, chain: EvmOrdersChain, owner: string): Promise<bigint | null> {
    for (let i = 0; i < 4; i++) {
      try {
        const r = (await this.d.read('eth_getTransactionReceipt', [hash])) as { logs?: { address?: string; topics?: string[] }[] } | null;
        for (const l of r?.logs ?? []) {
          const t = l.topics ?? [];
          if (l.address?.toLowerCase() === chain.orders && t[0]?.toLowerCase() === ORDER_CREATED_TOPIC && t[2]?.toLowerCase() === '0x' + pad(owner) && /^0x[0-9a-fA-F]{64}$/.test(t[1] ?? ''))
            return BigInt(t[1]!);
        }
      } catch {
        // try again
      }
      await this.sleep(1000);
    }
    return null;
  }

  // ---------------------------------------------------------------- cancelling

  async prepareCancel(chain: EvmOrdersChain, account: string, record: EvmOrderRecord): Promise<EvmCancelReview> {
    const blockers: string[] = [];
    const tx = buildCancelOrderTx(account, chain, record.id);
    let gasCostWei: bigint | null = null;
    let coinBalance = 0n;
    if (record.owner !== account.toLowerCase()) blockers.push('This order belongs to a different account.');
    try {
      if (await this.checkChain(chain, blockers)) {
        coinBalance = asBig(await this.d.read('eth_getBalance', [account, 'latest'])) ?? 0n;
        const gas = await this.estimate(tx);
        const price = await this.gasPrice();
        if (gas === null || price === null) blockers.push(`The network would not accept this cancel, so nothing was sent${this.lastEstimateFailure}.`);
        else {
          gasCostWei = gas * price;
          if (coinBalance < gasCostWei) blockers.push(`You need more ${chain.symbol} for the network gas.`);
        }
      }
    } catch {
      blockers.push('The network could not be reached to check this cancel. Try again in a moment.');
    }
    return { kind: 'cancel', chain, account, order: record, tx, gasCostWei, coinBalance, blockers };
  }

  async cancel(review: EvmCancelReview, progress: (p: EvmOrdersProgress) => void = () => undefined): Promise<EvmOrdersOutcome> {
    const { chain, order } = review;
    await this.begin(review, progress);
    const hash = await this.runTx(review.tx, (tx, id) => inspectCancelOrder(tx, { chain, from: review.account, id: order.id }, id), 'cancel', progress, 'sending', 'confirming');
    progress('verifying');
    const differences: string[] = [];
    let gone = false;
    for (let i = 0; i < 6 && !gone; i++) {
      const rec = parseEvmOrder(order.id, await this.call(chain.orders, orderReadData(order.id)));
      gone = rec === null || rec.inRemaining === 0n;
      if (!gone) await this.sleep(1000);
    }
    if (!gone) differences.push('The order is still there after the cancel confirmed.');
    progress('done');
    return { hashes: [hash], id: order.id, differences };
  }

  // ---------------------------------------------------------------- shared

  private async begin(review: ReviewBase, progress: (p: EvmOrdersProgress) => void): Promise<void> {
    if (review.blockers.length > 0) throw new EvmOrdersError(review.blockers.join(' '), true);
    progress('checking');
    const account = (await this.d.adapter.getAccounts())[0];
    if (!account || account.toLowerCase() !== review.account.toLowerCase()) throw new EvmOrdersError('The account selected in your wallet changed. Start again.', true);
    if ((await this.d.adapter.getChainId()) !== review.chain.chainId) {
      try {
        await this.d.adapter.switchChain(review.chain.chainId);
      } catch (e) {
        throw new EvmOrdersError(e instanceof Error ? e.message : 'Your wallet could not switch networks.', true);
      }
    }
  }

  private async receipt(hash: string): Promise<{ status?: string } | null> {
    const deadline = this.d.now() + 180_000;
    while (this.d.now() < deadline) {
      try {
        const r = (await this.d.read('eth_getTransactionReceipt', [hash])) as { status?: string } | null;
        if (r) return r;
      } catch {
        // not answered yet
      }
      await this.sleep(2_000);
    }
    return null;
  }

  private async runTx(
    tx: EvmTxRequest,
    inspect: (tx: EvmTxRequest, walletChainId: number) => string[],
    what: string,
    progress: (p: EvmOrdersProgress) => void,
    signing: EvmOrdersProgress,
    confirming: EvmOrdersProgress,
  ): Promise<string> {
    const problems = inspect(tx, await this.d.adapter.getChainId());
    if (problems.length > 0) throw new EvmOrdersError(`Not signing: ${problems.join(' ')}`, true);
    try {
      await this.d.read('eth_call', [{ from: tx.from, to: tx.to, data: tx.data, value: tx.value }, 'latest']);
    } catch (e) {
      throw new EvmOrdersError(`The network would refuse the ${what}, so nothing was sent${reasonOf(e)}.`, true);
    }
    progress(signing);
    let hash: string;
    try {
      hash = await this.d.adapter.sendTransaction(tx);
    } catch (e) {
      const rejected = e instanceof SwingsError && e.code === 'rejected';
      throw new EvmOrdersError(
        rejected ? 'You closed the wallet without approving.' : `The ${what} was not sent: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 160)}`,
        false,
      );
    }
    progress(confirming);
    const r = await this.receipt(hash);
    if (!r) throw new EvmOrdersError(`The ${what} was sent but has not confirmed yet. Check ${hash} on an explorer before trying again.`);
    if (r.status !== '0x1') throw new EvmOrdersError(`The ${what} failed on the network; nothing from it took effect. (${hash})`);
    return hash;
  }

  private async readBack<T>(read: () => Promise<T | null>): Promise<T | null> {
    for (let i = 0; i < 6; i++) {
      try {
        const v = await read();
        if (v) return v;
      } catch {
        // try again
      }
      await this.sleep(1000);
    }
    return null;
  }
}
