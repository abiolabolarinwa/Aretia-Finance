/**
 * Aretia Pool on Ethereum-style chains: the steps of opening, trading and managing a pool, with every outside dependency passed in so each
 * path can be tested without a network or a wallet. walletAretiaPoolEvm.ts connects it to the page.
 *
 *   loadToken / loadPool / loadPosition   read from the chain (and prove the factory made the token), without asking the wallet anything
 *   prepare*                              work out the numbers from the pool as it is now, build the transactions, refuse anything wrong
 *   run                                   for each transaction: check it against what was approved (independent inspector), simulate it,
 *                                         make sure the wallet is on the right account and network, have the wallet send it, wait for the
 *                                         receipt; then read the result back and list any difference from what was approved
 *
 * Before anything is built the page also reads the pool contract's own `factory`, `feeRecipient` and `creationFee` and refuses a contract
 * whose values differ from this page's constants. An approval and the action it enables are two transactions; if the second cannot go ahead
 * the approval stays in place for exactly the tokens approved and nothing else has happened; the error says so.
 */
import { SwingsError } from '../swings/core/types.js';
import { decodeAbiString } from '../swings/chains/evmSession.js';
import type { EvmTxRequest } from '../swings/chains/evmWallet.js';
import type { EvmFlowDeps } from './walletLaunchEvmFlow';
import { createAddress, findFactoryNonce } from './walletCurveEvmCore';
import {
  POOL_DEADLINE_SECS,
  POOL_SLIPPAGE_BPS_DEFAULT,
  evmMaxIn,
  evmMinOut,
  openingMath,
  parsePoolReturn,
  parsePositionReturn,
  poolClaimable,
  poolProblems,
  poolQuoteAdd,
  poolQuoteBuy,
  poolQuoteRemove,
  poolQuoteSell,
  type EvmPoolBuyQuote,
  type EvmPoolChain,
  type EvmPoolConfig,
  type EvmPoolSellQuote,
  type EvmPoolState,
  type EvmPoolToken,
  type EvmPosition,
} from './walletAretiaPoolEvmCore';
import {
  POOL_SEL,
  buildAddTx,
  buildApproveTx,
  buildBuyTx,
  buildClaimTx,
  buildCreateTx,
  buildLockTx,
  buildRecipientTx,
  buildRemoveTx,
  buildSellTx,
  buildTransferTx,
  inspectAdd,
  inspectApprove,
  inspectBuy,
  inspectClaim,
  inspectCreate,
  inspectLock,
  inspectRecipient,
  inspectRemove,
  inspectSell,
  inspectTransfer,
  poolReadData,
  positionReadData,
} from './walletAretiaPoolEvmTx';

export interface EvmPoolFlowDeps extends EvmFlowDeps {
  /** Unix seconds. */
  nowSeconds(): number;
}

export class EvmPoolError extends Error {
  constructor(
    message: string,
    readonly nothingSent = false,
  ) {
    super(message);
  }
}

export type EvmPoolKind = 'create' | 'buy' | 'sell' | 'add' | 'remove' | 'claim' | 'lock' | 'transfer' | 'recipient';

/** One transaction of an action, with the independent check that must pass before it is signed. */
export interface PoolStep {
  what: string;
  tx: EvmTxRequest;
  inspect: (tx: EvmTxRequest, walletChainId: number) => string[];
  progress: [EvmPoolProgress, EvmPoolProgress];
  /** For an approval: the token and the exact amount the allowance must read afterwards. */
  allowance?: { token: string; amount: bigint };
}

export interface EvmPoolReview {
  kind: EvmPoolKind;
  chain: EvmPoolChain;
  account: string;
  token: string;
  steps: PoolStep[];
  /** A rough ceiling for the gas of every transaction in this action, in wei. Null if it could not be estimated. */
  gasCostWei: bigint | null;
  coinBalance: bigint;
  /** Coin that leaves the wallet apart from gas (fee, first buy, purchase, deposit). */
  coinOut: bigint;
  tokensBefore: bigint;
  blockers: string[];
  /** The numbers the person saw, for the read-back check. */
  expect: { minTokensAfter?: bigint; tokensAfter?: bigint; sharesAfter?: bigint; lockedAfter?: bigint; claimedAll?: boolean; poolXAfter?: bigint; recipient?: string | null; positionGone?: boolean; positionAt?: string };
  buyQuote?: EvmPoolBuyQuote | null;
  sellQuote?: EvmPoolSellQuote | null;
  config?: EvmPoolConfig;
  minOut?: bigint;
}

export type EvmPoolProgress = 'checking' | 'approving' | 'confirming-approve' | 'sending' | 'confirming' | 'verifying' | 'done';

export interface EvmPoolOutcome {
  hashes: string[];
  token: string;
  /** Differences between what was approved and what the network shows. Empty means it matches. */
  differences: string[];
  tokensAfter?: bigint;
}

const SEL = { name: '0x06fdde03', symbol: '0x95d89b41', decimals: '0x313ce567', totalSupply: '0x18160ddd', balanceOf: '0x70a08231' } as const;
const asBig = (v: unknown): bigint | null => (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : null);
const wordOf = (v: unknown): bigint | null => (typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) ? BigInt(v) : null);
const addrOf = (v: unknown): string | null => (typeof v === 'string' && /^0x0{24}[0-9a-fA-F]{40}$/.test(v) ? '0x' + v.slice(26).toLowerCase() : null);
const pad = (a: string): string => a.slice(2).toLowerCase().padStart(64, '0');
const GAS_MARGIN_NUM = 12n;
const GAS_MARGIN_DEN = 10n;
const CREATE_GAS_CEILING = 600_000n;
const ACTION_GAS_CEILING = 300_000n;
const APPROVE_GAS_CEILING = 80_000n;

export class EvmPoolFlow {
  constructor(private readonly d: EvmPoolFlowDeps) {}

  /** A deadline for a call built now: POOL_DEADLINE_SECS ahead. */
  private deadline = (): bigint => BigInt(this.d.nowSeconds() + POOL_DEADLINE_SECS);

  private sleep = (ms: number) => (this.d.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);
  private call = (to: string, data: string): Promise<unknown> => this.d.read('eth_call', [{ to, data }, 'latest']);

  // ---------------------------------------------------------------- reading

  /** The token, the holder's balance, and the proof the factory made it. Null if it cannot be read as a token. */
  async loadToken(chain: EvmPoolChain, owner: string, token: string): Promise<EvmPoolToken | null> {
    const code = await this.d.read('eth_getCode', [token, 'latest']);
    if (typeof code !== 'string' || code === '0x') return null;
    let reads: unknown[];
    try {
      reads = await Promise.all([
        this.call(token, SEL.name),
        this.call(token, SEL.symbol),
        this.call(token, SEL.decimals),
        this.call(token, SEL.totalSupply),
        this.call(token, SEL.balanceOf + pad(owner)),
        this.d.read('eth_getTransactionCount', [chain.factory, 'latest']),
      ]);
    } catch {
      return null;
    }
    const [name, symbol, decimals, supply, held, count] = reads;
    const dec = wordOf(decimals);
    const sup = wordOf(supply);
    const bal = wordOf(held);
    const next = asBig(count);
    const n = decodeAbiString(name);
    const s = decodeAbiString(symbol);
    if (dec === null || dec > 36n || sup === null || bal === null || next === null || n === null || s === null) return null;
    return { address: token.toLowerCase(), name: n, symbol: s, decimals: Number(dec), supply: sup, held: bal, factoryNonce: findFactoryNonce(chain.factory, token, next) };
  }

  /** The pool for a token, or null if there is none or its answer is malformed. */
  async loadPool(chain: EvmPoolChain, token: string): Promise<EvmPoolState | null> {
    return parsePoolReturn(await this.call(chain.pool, poolReadData(token)));
  }

  async loadPosition(chain: EvmPoolChain, token: string, owner: string): Promise<EvmPosition | null> {
    return parsePositionReturn(await this.call(chain.pool, positionReadData(token, owner)));
  }

  private async tokenBalance(token: string, who: string): Promise<bigint> {
    return wordOf(await this.call(token, SEL.balanceOf + pad(who))) ?? 0n;
  }
  private async gasPrice(): Promise<bigint | null> {
    return asBig(await this.d.read('eth_gasPrice', []));
  }

  /** The node is the right network, the contract is there, and its fixed values are the ones this page expects. */
  private async checkChain(chain: EvmPoolChain, blockers: string[]): Promise<boolean> {
    if (asBig(await this.d.read('eth_chainId', [])) !== BigInt(chain.chainId)) {
      blockers.push('The network node did not answer as the right network. Try again in a moment.');
      return false;
    }
    const code = await this.d.read('eth_getCode', [chain.pool, 'latest']);
    if (typeof code !== 'string' || code === '0x') {
      blockers.push('The Aretia Pool contract is not on this network at the address this page expects, so nothing was sent.');
      return false;
    }
    const [factory, recipient, fee] = await Promise.all([this.call(chain.pool, POOL_SEL.factory), this.call(chain.pool, POOL_SEL.feeRecipient), this.call(chain.pool, POOL_SEL.creationFee)]);
    if (addrOf(factory) !== chain.factory) blockers.push('The pool contract on the network accepts tokens from a different factory than this page expects, so nothing was sent.');
    if (addrOf(recipient) !== chain.feeAddress) blockers.push('The pool contract on the network pays Aretia’s share to a different address than this page expects, so nothing was sent.');
    if (wordOf(fee) !== chain.creationFee) blockers.push('The pool contract on the network charges a different creation fee than this page shows, so nothing was sent.');
    return blockers.length === 0;
  }

  private lastEstimateFailure = '';

  /** The gas a transaction needs, or null. One failed estimate is tried a second time before it is believed. */
  private async estimate(tx: EvmTxRequest): Promise<bigint | null> {
    this.lastEstimateFailure = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const g = asBig(await this.d.read('eth_estimateGas', [tx]));
        if (g !== null) return (g * GAS_MARGIN_NUM) / GAS_MARGIN_DEN;
        this.lastEstimateFailure = ': the network did not give a number';
      } catch (e) {
        const words = reasonOf(e);
        this.lastEstimateFailure = words || `: ${(e instanceof Error ? e.message : String(e)).split(String.fromCharCode(10))[0]!.slice(0, 140)}`;
      }
      if (attempt === 0) await this.sleep(1500);
    }
    return null;
  }

  /**
   * Common to every prepare: checks the node and contract, reads the balances, and (when `firstTx` can be estimated now) prices the gas.
   * `estimateTx` is the first transaction that does not depend on an approval that has not happened yet.
   */
  private async fill(
    review: Omit<EvmPoolReview, 'gasCostWei' | 'coinBalance' | 'tokensBefore'>,
    estimateTx: EvmTxRequest | null,
    gasCeiling: bigint,
    refusal: string,
    needTokens: bigint,
  ): Promise<EvmPoolReview> {
    const { chain, account, token, blockers } = review;
    let gasCostWei: bigint | null = null;
    let coinBalance = 0n;
    let tokensBefore = 0n;
    try {
      if (await this.checkChain(chain, blockers)) {
        coinBalance = asBig(await this.d.read('eth_getBalance', [account, 'latest'])) ?? 0n;
        tokensBefore = await this.tokenBalance(token, account);
        if (needTokens > tokensBefore) blockers.push('You hold fewer of this token than this needs.');
        const price = await this.gasPrice();
        if (price === null) blockers.push('The network did not give a gas price. Try again in a moment.');
        else if (blockers.length === 0) {
          if (estimateTx !== null && (await this.estimate(estimateTx)) === null) blockers.push(`${refusal}${this.lastEstimateFailure}.`);
          else {
            gasCostWei = gasCeiling * price;
            if (coinBalance < review.coinOut + gasCostWei) blockers.push(`You need more ${chain.symbol}: the amount this takes plus the network gas.`);
          }
        }
      }
    } catch {
      blockers.push('The network could not be reached to check this. Try again in a moment.');
    }
    return { ...review, gasCostWei, coinBalance, tokensBefore };
  }

  private approveStep(chain: EvmPoolChain, account: string, token: string, amount: bigint): PoolStep {
    return {
      what: 'approval',
      tx: buildApproveTx(account, token, chain.pool, amount, chain.chainId),
      inspect: (tx, id) => inspectApprove(tx, { chain, from: account, token, amount }, id),
      progress: ['approving', 'confirming-approve'],
      allowance: { token, amount },
    };
  }

  // ---------------------------------------------------------------- create

  async prepareCreate(config: EvmPoolConfig): Promise<EvmPoolReview> {
    const { chain } = config;
    const blockers: string[] = [];
    let buyQuote: EvmPoolBuyQuote | null = null;
    let minFirstBuyOut = 0n;
    if (createAddress(chain.factory, config.factoryNonce) !== config.token) blockers.push('This token was not made by Aretia’s token factory, so it cannot get an Aretia Pool.');
    if (config.firstBuyWei > 0n) {
      buyQuote = poolQuoteBuy(openingMath(config), config.firstBuyWei);
      if (!buyQuote) blockers.push('Your first buy is too small to get any tokens.');
      else minFirstBuyOut = buyQuote.tokensOut;
    }
    const approve = this.approveStep(chain, config.creator, config.token, config.x0);
    const deadline = this.deadline();
    const createTx = buildCreateTx(config, minFirstBuyOut, deadline);
    const create: PoolStep = {
      what: 'pool creation',
      tx: createTx,
      inspect: (tx, id) => inspectCreate(tx, { config, minFirstBuyOut, deadline, nowSeconds: this.d.nowSeconds() }, id),
      progress: ['sending', 'confirming'],
    };
    // The existing-pool check needs the chain; do it inside fill's try via a pre-read.
    try {
      if ((await this.loadPool(chain, config.token)) !== null) blockers.push('A pool for this token already exists on this network, and only one can be opened.');
    } catch {
      // the generic network blocker below reports it
    }
    const coinOut = chain.creationFee + config.y0 + config.firstBuyWei;
    const base = {
      kind: 'create' as const,
      chain,
      account: config.creator,
      token: config.token,
      steps: [approve, create],
      coinOut,
      blockers,
      expect: { poolXAfter: config.x0 - (buyQuote?.tokensOut ?? 0n) },
      buyQuote,
      config,
      minOut: minFirstBuyOut,
    };
    return this.fill(base, approve.tx, APPROVE_GAS_CEILING + CREATE_GAS_CEILING, 'The network would not accept the approval, so nothing was sent', config.x0);
  }

  // ---------------------------------------------------------------- trade

  async prepareBuy(chain: EvmPoolChain, account: string, pool: EvmPoolState, token: string, wei: bigint, slippageBps: number = POOL_SLIPPAGE_BPS_DEFAULT): Promise<EvmPoolReview> {
    const blockers = poolProblems(pool);
    const quote = poolQuoteBuy(pool, wei);
    if (!quote) blockers.push('That amount is too small to buy any tokens.');
    const minOut = quote ? evmMinOut(quote.tokensOut, slippageBps) : 0n;
    const deadline = this.deadline();
    const tx = buildBuyTx(account, chain, token, minOut, wei, deadline);
    const step: PoolStep = { what: 'purchase', tx, inspect: (t, id) => inspectBuy(t, { chain, from: account, token, wei, minOut, deadline, nowSeconds: this.d.nowSeconds() }, id), progress: ['sending', 'confirming'] };
    return this.fill({ kind: 'buy', chain, account, token, steps: [step], coinOut: wei, blockers, expect: {}, buyQuote: quote, minOut }, quote ? tx : null, ACTION_GAS_CEILING, 'The network would not accept this purchase, so nothing was sent', 0n);
  }

  async prepareSell(chain: EvmPoolChain, account: string, pool: EvmPoolState, token: string, tokens: bigint, slippageBps: number = POOL_SLIPPAGE_BPS_DEFAULT): Promise<EvmPoolReview> {
    const blockers = poolProblems(pool);
    const quote = poolQuoteSell(pool, tokens);
    if (!quote) blockers.push('That amount cannot be sold to the pool: it would need more coin than buyers have paid in.');
    const minOut = quote ? evmMinOut(quote.net, slippageBps) : 0n;
    const approve = this.approveStep(chain, account, token, tokens);
    const deadline = this.deadline();
    const tx = buildSellTx(account, chain, token, tokens, minOut, deadline);
    const step: PoolStep = { what: 'sale', tx, inspect: (t, id) => inspectSell(t, { chain, from: account, token, tokens, minCoinOut: minOut, deadline, nowSeconds: this.d.nowSeconds() }, id), progress: ['sending', 'confirming'] };
    const r = await this.fill({ kind: 'sell', chain, account, token, steps: [approve, step], coinOut: 0n, blockers, expect: {}, sellQuote: quote, minOut }, approve.tx, APPROVE_GAS_CEILING + ACTION_GAS_CEILING, 'The network would not accept the approval, so nothing was sent', tokens);
    r.expect.tokensAfter = r.tokensBefore - tokens;
    return r;
  }

  // ---------------------------------------------------------------- liquidity

  async prepareAdd(chain: EvmPoolChain, account: string, pool: EvmPoolState, token: string, dl: bigint, slippageBps: number = POOL_SLIPPAGE_BPS_DEFAULT): Promise<EvmPoolReview> {
    const blockers = poolProblems(pool);
    const quote = poolQuoteAdd(pool, dl);
    if (!quote) blockers.push('That amount of liquidity is too small, or too large for the pool.');
    const maxTokens = quote ? evmMaxIn(quote.tokens, slippageBps) : 0n;
    const coinWei = quote ? evmMaxIn(quote.coin, slippageBps) : 0n;
    const approve = this.approveStep(chain, account, token, maxTokens);
    const deadline = this.deadline();
    const tx = buildAddTx(account, chain, token, dl, maxTokens, coinWei, deadline);
    const step: PoolStep = { what: 'deposit', tx, inspect: (t, id) => inspectAdd(t, { chain, from: account, token, dl, maxTokens, coinWei, deadline, nowSeconds: this.d.nowSeconds() }, id), progress: ['sending', 'confirming'] };
    const before = await this.loadPosition(chain, token, account).catch(() => null);
    const r = await this.fill({ kind: 'add', chain, account, token, steps: [approve, step], coinOut: coinWei, blockers, expect: {} }, quote ? approve.tx : null, APPROVE_GAS_CEILING + ACTION_GAS_CEILING, 'The network would not accept the approval, so nothing was sent', maxTokens);
    r.expect.sharesAfter = (before?.open ? before.shares : 0n) + dl;
    return r;
  }

  async prepareRemove(chain: EvmPoolChain, account: string, pool: EvmPoolState, position: EvmPosition, token: string, dl: bigint, slippageBps: number = POOL_SLIPPAGE_BPS_DEFAULT): Promise<EvmPoolReview> {
    const blockers = poolProblems(pool);
    if (!position.open || dl <= 0n || dl > position.shares - position.locked) blockers.push('You can only take out liquidity that is not locked.');
    const quote = poolQuoteRemove(pool, dl);
    if (!quote) blockers.push('The pool cannot be emptied: a small amount of liquidity always stays.');
    const minTokens = quote ? evmMinOut(quote.tokens, slippageBps) : 0n;
    const minCoin = quote ? evmMinOut(quote.coin, slippageBps) : 0n;
    const deadline = this.deadline();
    const tx = buildRemoveTx(account, chain, token, dl, minTokens, minCoin, deadline);
    const step: PoolStep = { what: 'withdrawal', tx, inspect: (t, id) => inspectRemove(t, { chain, from: account, token, dl, minTokens, minCoin, deadline, nowSeconds: this.d.nowSeconds() }, id), progress: ['sending', 'confirming'] };
    const r = await this.fill({ kind: 'remove', chain, account, token, steps: [step], coinOut: 0n, blockers, expect: { sharesAfter: position.shares - dl } }, quote ? tx : null, ACTION_GAS_CEILING, 'The network would not accept this withdrawal, so nothing was sent', 0n);
    if (quote) r.expect.minTokensAfter = r.tokensBefore + minTokens;
    return r;
  }

  async prepareClaim(chain: EvmPoolChain, account: string, pool: EvmPoolState, position: EvmPosition, token: string): Promise<EvmPoolReview> {
    const blockers = poolProblems(pool);
    if (!position.open) blockers.push('You have no position in this pool.');
    else if (poolClaimable(pool, position) === 0n) blockers.push('There is nothing to claim yet.');
    const tx = buildClaimTx(account, chain, token);
    const step: PoolStep = { what: 'claim', tx, inspect: (t, id) => inspectClaim(t, { chain, from: account, token }, id), progress: ['sending', 'confirming'] };
    return this.fill({ kind: 'claim', chain, account, token, steps: [step], coinOut: 0n, blockers, expect: { claimedAll: true } }, blockers.length === 0 ? tx : null, ACTION_GAS_CEILING, 'The network would not accept this claim, so nothing was sent', 0n);
  }

  async prepareLock(chain: EvmPoolChain, account: string, position: EvmPosition, token: string, amount: bigint): Promise<EvmPoolReview> {
    const blockers: string[] = [];
    if (!position.open || amount <= 0n || amount > position.shares - position.locked) blockers.push('You can only lock liquidity that is not locked yet.');
    const tx = buildLockTx(account, chain, token, amount);
    const step: PoolStep = { what: 'lock', tx, inspect: (t, id) => inspectLock(t, { chain, from: account, token, amount }, id), progress: ['sending', 'confirming'] };
    return this.fill({ kind: 'lock', chain, account, token, steps: [step], coinOut: 0n, blockers, expect: { lockedAfter: position.locked + amount } }, blockers.length === 0 ? tx : null, ACTION_GAS_CEILING, 'The network would not accept this lock, so nothing was sent', 0n);
  }

  async prepareTransfer(chain: EvmPoolChain, account: string, position: EvmPosition, token: string, to: string): Promise<EvmPoolReview> {
    const blockers: string[] = [];
    if (!position.open) blockers.push('You have no position in this pool.');
    if (!/^0x[0-9a-fA-F]{40}$/.test(to) || to.toLowerCase() === account.toLowerCase()) blockers.push('Name a different wallet address.');
    // The contract merges into a position the other wallet already has (shares, locked shares and settled fees add up; it keeps its own
    // fee recipient), so an existing position there is no longer a blocker.
    const tx = buildTransferTx(account, chain, token, to);
    const step: PoolStep = { what: 'transfer', tx, inspect: (t, id) => inspectTransfer(t, { chain, from: account, token, to }, id), progress: ['sending', 'confirming'] };
    return this.fill({ kind: 'transfer', chain, account, token, steps: [step], coinOut: 0n, blockers, expect: { positionGone: true, positionAt: to.toLowerCase() } }, blockers.length === 0 ? tx : null, ACTION_GAS_CEILING, 'The network would not accept this transfer, so nothing was sent', 0n);
  }

  async prepareRecipient(chain: EvmPoolChain, account: string, position: EvmPosition, token: string, recipient: string): Promise<EvmPoolReview> {
    const blockers: string[] = [];
    if (!position.open) blockers.push('You have no position in this pool.');
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient) || /^0x0{40}$/.test(recipient)) blockers.push('Name a wallet address.');
    const tx = buildRecipientTx(account, chain, token, recipient);
    const step: PoolStep = { what: 'change of fee recipient', tx, inspect: (t, id) => inspectRecipient(t, { chain, from: account, token, recipient }, id), progress: ['sending', 'confirming'] };
    const wanted = recipient.toLowerCase() === account.toLowerCase() ? null : recipient.toLowerCase();
    return this.fill({ kind: 'recipient', chain, account, token, steps: [step], coinOut: 0n, blockers, expect: { recipient: wanted } }, blockers.length === 0 ? tx : null, ACTION_GAS_CEILING, 'The network would not accept this change, so nothing was sent', 0n);
  }

  // ---------------------------------------------------------------- run

  async run(review: EvmPoolReview, progress: (p: EvmPoolProgress) => void = () => undefined): Promise<EvmPoolOutcome> {
    const { chain, token, account } = review;
    await this.begin(review, progress);
    const hashes: string[] = [];
    for (let i = 0; i < review.steps.length; i++) {
      const step = review.steps[i]!;
      let hash: string;
      try {
        hash = await this.runTx(step, progress);
      } catch (e) {
        if (i > 0 && e instanceof EvmPoolError) throw new EvmPoolError(`${e.message} The approval is in place for exactly the tokens you chose and nothing else happened. You can start again.`, false);
        throw e;
      }
      hashes.push(hash);
      if (step.allowance) {
        // A public node can answer from a block just before the approval: read a few times before believing a mismatch.
        let allowance: bigint | null = null;
        for (let i = 0; i < 8; i++) {
          allowance = wordOf(await this.call(step.allowance.token, POOL_SEL.allowance + pad(account) + pad(chain.pool)).catch(() => null));
          if (allowance === step.allowance.amount) break;
          await this.sleep(1500);
        }
        if (allowance !== step.allowance.amount) throw new EvmPoolError(`The approval confirmed but the allowance is not exactly what you approved, so nothing more was sent. Your tokens did not move. (${hash})`);
      }
    }
    progress('verifying');
    const differences = await this.readBackChecks(review);
    progress('done');
    const tokensAfter = await this.tokenBalance(token, account).catch(() => undefined);
    return { hashes, token, differences, tokensAfter };
  }

  private async readBackChecks(review: EvmPoolReview): Promise<string[]> {
    const { chain, token, account, kind, expect } = review;
    const out: string[] = [];
    const pool = await this.readBack(() => this.loadPool(chain, token));
    if (!pool) return ['The pool could not be read back from the network.'];
    out.push(...poolProblems(pool));
    const pos = await this.loadPosition(chain, token, account).catch(() => null);
    const tokens = await this.tokenBalance(token, account);
    if (kind === 'create' && review.config) {
      const c = review.config;
      if (pool.creator !== c.creator) out.push('The pool names a different creator.');
      if (pool.feeBps !== BigInt(c.feeBps)) out.push('The pool’s trading fee is not the one approved.');
      if (pool.l !== c.l0) out.push('The pool’s starting price is not the one approved.');
      if (expect.poolXAfter !== undefined && pool.x !== expect.poolXAfter) out.push('The pool does not hold the tokens approved.');
      if (!pos || !pos.open || pos.shares !== c.l0 || pos.locked !== c.l0) out.push('Your position is not locked for good as approved.');
      const held = await this.tokenBalance(token, chain.pool);
      if (held < c.x0 - (review.buyQuote?.tokensOut ?? 0n)) out.push('The pool contract does not hold the tokens approved.');
    }
    if (kind === 'buy' && tokens < review.tokensBefore + (review.minOut ?? 0n)) out.push('The wallet holds fewer tokens than the least it was willing to accept.');
    if (kind === 'sell' && expect.tokensAfter !== undefined && tokens !== expect.tokensAfter) out.push('The wallet does not hold the amount of tokens it should after the sale.');
    if (kind === 'add' && (!pos || pos.shares < (expect.sharesAfter ?? 0n))) out.push('Your position does not show the liquidity you added.');
    if (kind === 'remove') {
      if (!pos || pos.shares !== expect.sharesAfter) out.push('Your position does not show the liquidity taken out.');
      if (expect.minTokensAfter !== undefined && tokens < expect.minTokensAfter) out.push('The wallet holds fewer tokens than the least it was willing to accept.');
    }
    if (kind === 'claim' && pos) {
      const left = poolClaimable(pool, pos);
      if (left !== 0n) out.push('Your position still shows fees waiting to be claimed.');
    }
    if (kind === 'lock' && (!pos || pos.locked !== expect.lockedAfter)) out.push('Your position does not show the liquidity as locked.');
    if (kind === 'transfer') {
      if (pos?.open) out.push('You still hold the position.');
      const other = expect.positionAt ? await this.loadPosition(chain, token, expect.positionAt).catch(() => null) : null;
      if (!other?.open) out.push('The other wallet does not show the position.');
    }
    if (kind === 'recipient' && (!pos || pos.recipient !== (expect.recipient ?? null))) out.push('Your position does not show the new fee recipient.');
    return out;
  }

  // ---------------------------------------------------------------- shared

  private async begin(review: EvmPoolReview, progress: (p: EvmPoolProgress) => void): Promise<void> {
    if (review.blockers.length > 0) throw new EvmPoolError(review.blockers.join(' '), true);
    progress('checking');
    const account = (await this.d.adapter.getAccounts())[0];
    if (!account || account.toLowerCase() !== review.account.toLowerCase()) throw new EvmPoolError('The account selected in your wallet changed. Start again.', true);
    if ((await this.d.adapter.getChainId()) !== review.chain.chainId) {
      try {
        await this.d.adapter.switchChain(review.chain.chainId);
      } catch (e) {
        throw new EvmPoolError(e instanceof Error ? e.message : 'Your wallet could not switch networks.', true);
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

  /** Inspect, simulate, send, wait. Returns the hash, or throws a plain-language error at the first thing that is wrong. */
  private async runTx(step: PoolStep, progress: (p: EvmPoolProgress) => void): Promise<string> {
    const { tx, what } = step;
    const problems = step.inspect(tx, await this.d.adapter.getChainId());
    if (problems.length > 0) throw new EvmPoolError(`Not signing: ${problems.join(' ')}`, true);
    try {
      await this.d.read('eth_call', [{ from: tx.from, to: tx.to, data: tx.data, value: tx.value }, 'latest']);
    } catch (e) {
      throw new EvmPoolError(`The network would refuse the ${what}, so nothing was sent${reasonOf(e)}.`, true);
    }
    progress(step.progress[0]);
    let hash: string;
    try {
      hash = await this.d.adapter.sendTransaction(tx);
    } catch (e) {
      const rejected = e instanceof SwingsError && e.code === 'rejected';
      throw new EvmPoolError(rejected ? 'You closed the wallet without approving.' : `The ${what} was not sent: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 160)}`, false);
    }
    progress(step.progress[1]);
    const r = await this.receipt(hash);
    if (!r) throw new EvmPoolError(`The ${what} was sent but has not confirmed yet. Check ${hash} on an explorer before trying again.`);
    if (r.status !== '0x1') throw new EvmPoolError(`The ${what} failed on the network; nothing from it took effect. (${hash})`);
    return hash;
  }

  /** Reads a few times: a node can briefly lag behind the confirmation. */
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

/** The contract's own refusal reasons, in words, when the node reports one. */
const REASONS: [RegExp, string][] = [
  [/slippage/i, ': the price moved past the limit you set'],
  [/no pool/i, ': there is no pool for this token'],
  [/not from the factory/i, ': the token was not made by Aretia’s factory'],
  [/exists/i, ': a pool for this token already exists'],
  [/unlocked shares/i, ': that liquidity is locked'],
  [/last liquidity/i, ': the pool cannot be emptied'],
  [/allowance/i, ': the approval is missing'],
  [/value/i, ': the coin sent is not the amount expected'],
];
function reasonOf(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  for (const [re, words] of REASONS) if (re.test(text)) return words;
  return '';
}
