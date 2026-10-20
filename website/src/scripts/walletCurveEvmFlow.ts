/**
 * Aretia Launch on Ethereum-style chains: the steps of selling a token on the Aretia curve, with every outside dependency passed in so each
 * path can be tested without a network or a wallet. walletCurveEvm.ts connects it to the page.
 *
 *   loadToken / loadCurve    read the token (and prove the factory made it) or a curve from the chain, without asking the wallet anything
 *   prepare*                 work out the numbers, build the transactions, refuse anything that is wrong, and price the gas
 *   create / buy / sell /    check each transaction against what was approved (independent inspector), simulate it, make sure the wallet is
 *   graduate / abort         on the right network and account, have the wallet send it, wait for the receipt, then read the result back
 *   rescue                   a graduation blocked by a pre-made exchange pair (review M-4, L-12), through Aretia's rescue helper when one is
 *                            deployed for the chain: an approval to the helper (only when tokens are needed), then `rescue(token, maxTokens)`
 * An approval and the action it enables are two transactions. If the second cannot go ahead the approval stays in place for exactly the tokens
 * approved and nothing else has happened; the error says so.
 */
import { SwingsError } from '../swings/core/types.js';
import { decodeAbiString } from '../swings/chains/evmSession.js';
import type { EvmTxRequest } from '../swings/chains/evmWallet.js';
import type { EvmFlowDeps } from './walletLaunchEvmFlow';
import {
  EVM_SLIPPAGE_BPS_DEFAULT,
  createAddress,
  evmCanAbort,
  evmCanGraduate,
  evmCurveProblems,
  evmMinOut,
  evmPairBlocks,
  parseRescuePlan,
  type EvmPairState,
  type EvmRescuePlan,
  evmQuoteBuy,
  evmQuoteSell,
  evmStart,
  findFactoryNonce,
  parseCurveReturn,
  type EvmBuyQuote,
  type EvmCurveChain,
  type EvmCurveConfig,
  type EvmCurveState,
  type EvmCurveToken,
  type EvmSellQuote,
} from './walletCurveEvmCore';
import {
  CURVE_SEL,
  buildAbortTx,
  buildApproveTx,
  buildBuyTx,
  buildCreateTx,
  buildGraduateTx,
  buildSellTx,
  curveReadData,
  inspectAbort,
  inspectApprove,
  inspectBuy,
  inspectCreate,
  inspectGraduate,
  inspectRescue,
  inspectRescueApprove,
  inspectSell,
  buildRescueTx,
  rescueQuoteData,
} from './walletCurveEvmTx';
import { SEL as PAIR_SEL } from './walletPoolEvmTx';

export interface EvmCurveFlowDeps extends EvmFlowDeps {
  /** Unix seconds. */
  nowSeconds(): number;
}

export class EvmCurveError extends Error {
  constructor(
    message: string,
    readonly nothingSent = false,
  ) {
    super(message);
  }
}

interface ReviewBase {
  chain: EvmCurveChain;
  account: string;
  /** A rough ceiling for the gas of every transaction in this action, in wei. Null if it could not be estimated. */
  gasCostWei: bigint | null;
  coinBalance: bigint;
  blockers: string[];
}
export interface EvmCreateReview extends ReviewBase {
  kind: 'create';
  config: EvmCurveConfig;
  approveTx: EvmTxRequest;
  createTx: EvmTxRequest;
  firstBuy: EvmBuyQuote | null;
  minFirstBuyOut: bigint;
  tokenBalance: bigint;
}
export interface EvmBuyReview extends ReviewBase {
  kind: 'buy';
  token: string;
  curve: EvmCurveState;
  quote: EvmBuyQuote | null;
  wei: bigint;
  minOut: bigint;
  tx: EvmTxRequest;
  tokensBefore: bigint;
}
export interface EvmSellReview extends ReviewBase {
  kind: 'sell';
  token: string;
  curve: EvmCurveState;
  quote: EvmSellQuote | null;
  tokens: bigint;
  minOut: bigint;
  approveTx: EvmTxRequest;
  tx: EvmTxRequest;
  tokensBefore: bigint;
}
export interface EvmGraduateReview extends ReviewBase {
  kind: 'graduate';
  token: string;
  curve: EvmCurveState;
  tx: EvmTxRequest;
  /** The exchange pair for the token, if one exists already. */
  pair?: EvmPairState | null;
  /** True when a pre-made pair blocks the plain graduation and a rescue helper is configured: the page offers "Graduate anyway". */
  rescuable?: boolean;
}
export interface EvmRescueReview extends ReviewBase {
  kind: 'rescue';
  token: string;
  curve: EvmCurveState;
  plan: EvmRescuePlan | null;
  /** The approval to the helper, only when the repair needs tokens. */
  approveTx: EvmTxRequest | null;
  tx: EvmTxRequest;
  maxTokens: bigint;
  wei: bigint;
  tokensBefore: bigint;
}
export interface EvmAbortReview extends ReviewBase {
  kind: 'abort';
  token: string;
  curve: EvmCurveState;
  tx: EvmTxRequest;
}
export type EvmCurveReview = EvmCreateReview | EvmBuyReview | EvmSellReview | EvmGraduateReview | EvmAbortReview | EvmRescueReview;

export type EvmCurveProgress = 'checking' | 'approving' | 'confirming-approve' | 'sending' | 'confirming' | 'verifying' | 'done';

export interface EvmCurveOutcome {
  hashes: string[];
  token: string;
  /** Differences between what was approved and what the network shows. Empty means it matches. */
  differences: string[];
  tokensAfter?: bigint;
}

/** `curve()` on the rescue helper: the curve it graduates for. */
const CURVE_SEL_HELPER_CURVE = '0x7165485d';
const SEL = { name: '0x06fdde03', symbol: '0x95d89b41', decimals: '0x313ce567', totalSupply: '0x18160ddd', balanceOf: '0x70a08231' } as const;
const asBig = (v: unknown): bigint | null => (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : null);
const wordOf = (v: unknown): bigint | null => (typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) ? BigInt(v) : null);
const pad = (a: string): string => a.slice(2).toLowerCase().padStart(64, '0');
const GAS_MARGIN_NUM = 12n;
const GAS_MARGIN_DEN = 10n;
/** What a curve creation (and its first buy) costs in gas is under this; used for the balance check and the shown ceiling, as the approval comes first and the creation cannot be estimated until then. */
const CREATE_GAS_CEILING = 450_000n;
/** Graduating into the exchange creates a pool, which is expensive: measured at about 2.8 million gas on Ethereum and Polygon and 3.5 million on BNB Chain, so this leaves room. */
const GRADUATE_GAS_CEILING = 4_500_000n;

export class EvmCurveFlow {
  constructor(private readonly d: EvmCurveFlowDeps) {}

  private sleep = (ms: number) => (this.d.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);
  private call = (to: string, data: string): Promise<unknown> => this.d.read('eth_call', [{ to, data }, 'latest']);

  // ---------------------------------------------------------------- reading

  /** The token, the holder's balance, and the proof the factory made it. Null if it cannot be read as a token. */
  async loadToken(chain: EvmCurveChain, owner: string, token: string): Promise<EvmCurveToken | null> {
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
      // Something that is not a token reverts on its name: it is not a token this page can describe.
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

  /** The curve for a token, or null if there is none or its answer is malformed. */
  async loadCurve(chain: EvmCurveChain, token: string): Promise<EvmCurveState | null> {
    const c = parseCurveReturn(await this.call(chain.curve, curveReadData(token)));
    return c && c.status !== 'none' ? c : null;
  }

  /**
   * The token/wrapped-coin pair on the curve's exchange (looked up through the exchange's factory), with its reserves and any unsynced
   * balance. Null when there is no pair yet. Throws when the network cannot be read.
   */
  async loadPair(chain: EvmCurveChain, token: string): Promise<EvmPairState | null> {
    const { dex } = chain;
    const got = await this.call(dex.factory, PAIR_SEL.getPair + pad(token) + pad(dex.wrapped));
    if (typeof got !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(got)) throw new Error('The exchange did not answer with a pair address.');
    const pair = '0x' + got.slice(26).toLowerCase();
    if (/^0x0{40}$/.test(pair)) return null;
    const [res, t0, balT, balC] = await Promise.all([this.call(pair, PAIR_SEL.getReserves), this.call(pair, PAIR_SEL.token0), this.call(token, SEL.balanceOf + pad(pair)), this.call(dex.wrapped, SEL.balanceOf + pad(pair))]);
    if (typeof res !== 'string' || !/^0x[0-9a-fA-F]{192}$/.test(res) || typeof t0 !== 'string') throw new Error('The pair could not be read.');
    const r0 = BigInt('0x' + res.slice(2, 66));
    const r1 = BigInt('0x' + res.slice(66, 130));
    const tokenIsZero = t0.slice(-40).toLowerCase() === token.slice(2).toLowerCase();
    const [reserveToken, reserveCoin] = tokenIsZero ? [r0, r1] : [r1, r0];
    const bt = wordOf(balT) ?? reserveToken;
    const bc = wordOf(balC) ?? reserveCoin;
    return { pair, reserveToken, reserveCoin, unsyncedToken: bt > reserveToken ? bt - reserveToken : 0n, unsyncedCoin: bc > reserveCoin ? bc - reserveCoin : 0n };
  }

  /** The total supply of a token, or null if it cannot be read. */
  async totalSupply(token: string): Promise<bigint | null> {
    return wordOf(await this.call(token, SEL.totalSupply));
  }

  /** A wallet's balance of a token (0 if it cannot be read). */
  async balanceOf(token: string, who: string): Promise<bigint> {
    return this.tokenBalance(token, who);
  }

  private async tokenBalance(token: string, who: string): Promise<bigint> {
    return wordOf(await this.call(token, SEL.balanceOf + pad(who))) ?? 0n;
  }

  private async gasPrice(): Promise<bigint | null> {
    return asBig(await this.d.read('eth_gasPrice', []));
  }

  private async checkChain(chain: EvmCurveChain, blockers: string[]): Promise<boolean> {
    if (asBig(await this.d.read('eth_chainId', [])) !== BigInt(chain.chainId)) {
      blockers.push('The network node did not answer as the right network. Try again in a moment.');
      return false;
    }
    const code = await this.d.read('eth_getCode', [chain.curve, 'latest']);
    if (typeof code !== 'string' || code === '0x') {
      blockers.push('The Aretia curve contract is not on this network at the address this page expects, so nothing was sent.');
      return false;
    }
    return true;
  }

  /** The network's reason for the last estimate it would not give, in words (or its own text), for the message shown to the person. */
  private lastEstimateFailure = '';

  /**
   * The gas a transaction needs, or null. A public node can briefly answer from an older block than the one the page just read, so one failed
   * estimate is tried a second time before it is believed; the reason the network gave is kept so the screen can say it.
   */
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

  // ---------------------------------------------------------------- create

  async prepareCreate(config: EvmCurveConfig): Promise<EvmCreateReview> {
    const { chain } = config;
    const blockers: string[] = [];
    let gasCostWei: bigint | null = null;
    let coinBalance = 0n;
    let tokenBalance = 0n;
    let firstBuy: EvmBuyQuote | null = null;
    let minFirstBuyOut = 0n;
    if (createAddress(chain.factory, config.factoryNonce) !== config.token) blockers.push('This token was not made by Aretia’s token factory, so it cannot be sold on a curve.');
    if (config.firstBuyWei > 0n) {
      firstBuy = evmQuoteBuy(evmStart(config.derived), config.firstBuyWei);
      if (!firstBuy) blockers.push('Your first buy is too small to get any tokens.');
      else minFirstBuyOut = firstBuy.tokensOut;
    }
    const approveTx = buildApproveTx(config.creator, config.token, chain.curve, config.totalRaw, chain.chainId);
    const createTx = buildCreateTx(config, minFirstBuyOut);
    try {
      if (await this.checkChain(chain, blockers)) {
        if (await this.loadCurve(chain, config.token)) blockers.push('A curve for this token already exists, and only one can be opened.');
        tokenBalance = await this.tokenBalance(config.token, config.creator);
        coinBalance = asBig(await this.d.read('eth_getBalance', [config.creator, 'latest'])) ?? 0n;
        if (tokenBalance < config.totalRaw) blockers.push(`You hold fewer ${config.tokenSymbol} than the amount you want to put in the curve.`);
        const approveGas = await this.estimate(approveTx);
        const price = await this.gasPrice();
        if (approveGas === null || price === null) blockers.push(`The network would not accept the approval, so nothing was sent${this.lastEstimateFailure}.`);
        else {
          gasCostWei = (approveGas + CREATE_GAS_CEILING) * price;
          if (coinBalance < config.firstBuyWei + gasCostWei) blockers.push(`You need more ${chain.symbol}: your first buy (if any) plus the network gas for both transactions.`);
        }
      }
    } catch {
      blockers.push('The network could not be reached to check this curve. Try again in a moment.');
    }
    return { kind: 'create', chain, account: config.creator, config, approveTx, createTx, firstBuy, minFirstBuyOut, tokenBalance, gasCostWei, coinBalance, blockers };
  }

  async create(review: EvmCreateReview, progress: (p: EvmCurveProgress) => void = () => undefined): Promise<EvmCurveOutcome> {
    const { config, chain } = review;
    const hashes: string[] = [];
    await this.begin(review, progress);
    const approveHash = await this.runTx(review.approveTx, (tx, id) => inspectApprove(tx, { chain, from: config.creator, token: config.token, amount: config.totalRaw }, id), 'approval', progress, 'approving', 'confirming-approve');
    hashes.push(approveHash);
    const allowance = wordOf(await this.call(config.token, CURVE_SEL.allowance + pad(config.creator) + pad(chain.curve)));
    if (allowance !== config.totalRaw) throw new EvmCurveError(`The approval confirmed but the allowance is not exactly what you approved, so the curve was not opened. Your tokens did not move. (${approveHash})`);
    const stuck = 'The approval is in place for exactly the tokens you chose and nothing else happened. You can start again to open the curve.';
    let createHash: string;
    try {
      createHash = await this.runTx(review.createTx, (tx, id) => inspectCreate(tx, { config, minFirstBuyOut: review.minFirstBuyOut }, id), 'curve creation', progress, 'sending', 'confirming');
    } catch (e) {
      throw new EvmCurveError(`${e instanceof Error ? e.message : String(e)} ${stuck}`, false);
    }
    hashes.push(createHash);
    progress('verifying');
    const state = await this.readBack(() => this.loadCurve(chain, config.token));
    const differences: string[] = [];
    if (!state) differences.push('The new curve could not be read back from the network.');
    else {
      const d = config.derived;
      if (state.creator !== config.creator) differences.push('The curve names a different creator.');
      if (state.target !== config.targetWei) differences.push('The curve’s raise target is not the one approved.');
      if (state.curveTokens !== d.curveTokens || state.lpTokens !== d.lpTokens) differences.push('The curve’s split between the curve and the pool is not the one approved.');
      if (state.vSol0 !== d.vSol0) differences.push('The curve’s starting reserves are not the ones approved.');
      differences.push(...evmCurveProblems(state));
      const held = await this.tokenBalance(config.token, chain.curve);
      if (held < config.totalRaw - (review.firstBuy?.tokensOut ?? 0n)) differences.push('The curve contract does not hold the tokens approved.');
    }
    progress('done');
    return { hashes, token: config.token, differences };
  }

  // ---------------------------------------------------------------- buy and sell

  async prepareBuy(chain: EvmCurveChain, account: string, curve: EvmCurveState, token: string, wei: bigint, slippageBps: number = EVM_SLIPPAGE_BPS_DEFAULT): Promise<EvmBuyReview> {
    const blockers = evmCurveProblems(curve);
    if (curve.status !== 'trading') blockers.push('This curve is not open for buying.');
    const quote = evmQuoteBuy(curve, wei);
    const minOut = quote ? evmMinOut(quote.tokensOut, slippageBps) : 0n;
    const tx = buildBuyTx(account, chain, token, minOut, wei);
    let gasCostWei: bigint | null = null;
    let coinBalance = 0n;
    let tokensBefore = 0n;
    if (!quote) blockers.push('That amount is too small to buy any tokens, or the curve has nothing left to sell.');
    try {
      if (await this.checkChain(chain, blockers)) {
        coinBalance = asBig(await this.d.read('eth_getBalance', [account, 'latest'])) ?? 0n;
        tokensBefore = await this.tokenBalance(token, account);
        if (quote) {
          const gas = await this.estimate(tx);
          const price = await this.gasPrice();
          if (gas === null || price === null) blockers.push(`The network would not accept this purchase, so nothing was sent${this.lastEstimateFailure}.`);
          else {
            gasCostWei = gas * price;
            if (coinBalance < wei + gasCostWei) blockers.push(`You need more ${chain.symbol}: the amount you are paying plus the network gas.`);
          }
        }
      }
    } catch {
      blockers.push('The network could not be reached to check this purchase. Try again in a moment.');
    }
    return { kind: 'buy', chain, account, token, curve, quote, wei, minOut, tx, tokensBefore, gasCostWei, coinBalance, blockers };
  }

  async buy(review: EvmBuyReview, progress: (p: EvmCurveProgress) => void = () => undefined): Promise<EvmCurveOutcome> {
    const { chain, token } = review;
    await this.begin(review, progress);
    const hash = await this.runTx(review.tx, (tx, id) => inspectBuy(tx, { chain, from: review.account, token, wei: review.wei, minOut: review.minOut }, id), 'purchase', progress, 'sending', 'confirming');
    progress('verifying');
    const state = await this.readBack(() => this.loadCurve(chain, token));
    const after = await this.tokenBalance(token, review.account);
    const differences: string[] = [];
    if (!state) differences.push('The curve could not be read back from the network.');
    else differences.push(...evmCurveProblems(state));
    if (after < review.tokensBefore + review.minOut) differences.push('The wallet holds fewer tokens than the least it was willing to accept.');
    progress('done');
    return { hashes: [hash], token, differences, tokensAfter: after };
  }

  async prepareSell(chain: EvmCurveChain, account: string, curve: EvmCurveState, token: string, tokens: bigint, slippageBps: number = EVM_SLIPPAGE_BPS_DEFAULT): Promise<EvmSellReview> {
    const blockers = evmCurveProblems(curve);
    if (curve.status !== 'trading' && curve.status !== 'aborted') blockers.push('This curve is not open for selling.');
    const quote = evmQuoteSell(curve, curve.curveTokens, tokens);
    const minOut = quote ? evmMinOut(quote.net, slippageBps) : 0n;
    const approveTx = buildApproveTx(account, token, chain.curve, tokens, chain.chainId);
    const tx = buildSellTx(account, chain, token, tokens, minOut);
    let gasCostWei: bigint | null = null;
    let coinBalance = 0n;
    let tokensBefore = 0n;
    if (!quote) blockers.push('That amount cannot be sold back to the curve.');
    try {
      if (await this.checkChain(chain, blockers)) {
        coinBalance = asBig(await this.d.read('eth_getBalance', [account, 'latest'])) ?? 0n;
        tokensBefore = await this.tokenBalance(token, account);
        if (tokens > tokensBefore) blockers.push('More than your wallet holds of this token.');
        const approveGas = await this.estimate(approveTx);
        const price = await this.gasPrice();
        if (approveGas === null || price === null) blockers.push(`The network would not accept the approval, so nothing was sent${this.lastEstimateFailure}.`);
        else {
          gasCostWei = (approveGas + 150_000n) * price;
          if (coinBalance < gasCostWei) blockers.push(`You need more ${chain.symbol} for the network gas of both transactions.`);
        }
      }
    } catch {
      blockers.push('The network could not be reached to check this sale. Try again in a moment.');
    }
    return { kind: 'sell', chain, account, token, curve, quote, tokens, minOut, approveTx, tx, tokensBefore, gasCostWei, coinBalance, blockers };
  }

  async sell(review: EvmSellReview, progress: (p: EvmCurveProgress) => void = () => undefined): Promise<EvmCurveOutcome> {
    const { chain, token } = review;
    const hashes: string[] = [];
    await this.begin(review, progress);
    const approveHash = await this.runTx(review.approveTx, (tx, id) => inspectApprove(tx, { chain, from: review.account, token, amount: review.tokens }, id), 'approval', progress, 'approving', 'confirming-approve');
    hashes.push(approveHash);
    const allowance = wordOf(await this.call(token, CURVE_SEL.allowance + pad(review.account) + pad(chain.curve)));
    if (allowance !== review.tokens) throw new EvmCurveError(`The approval confirmed but the allowance is not exactly what you approved, so nothing was sold. Your tokens did not move. (${approveHash})`);
    let hash: string;
    try {
      hash = await this.runTx(review.tx, (tx, id) => inspectSell(tx, { chain, from: review.account, token, tokens: review.tokens, minCoinOut: review.minOut }, id), 'sale', progress, 'sending', 'confirming');
    } catch (e) {
      throw new EvmCurveError(`${e instanceof Error ? e.message : String(e)} The approval is in place for exactly the tokens you chose and nothing was sold. You can start again.`, false);
    }
    hashes.push(hash);
    progress('verifying');
    const state = await this.readBack(() => this.loadCurve(chain, token));
    const after = await this.tokenBalance(token, review.account);
    const differences: string[] = [];
    if (!state) differences.push('The curve could not be read back from the network.');
    else differences.push(...evmCurveProblems(state));
    if (after !== review.tokensBefore - review.tokens) differences.push('The wallet does not hold the amount of tokens it should after the sale.');
    progress('done');
    return { hashes, token, differences, tokensAfter: after };
  }

  // ---------------------------------------------------------------- graduation

  async prepareGraduate(chain: EvmCurveChain, account: string, curve: EvmCurveState, token: string): Promise<EvmGraduateReview> {
    const blockers = evmCurveProblems(curve);
    if (!evmCanGraduate(curve)) blockers.push('This curve has not sold out, or has already moved on.');
    const tx = buildGraduateTx(account, chain, token);
    // A pair made on the exchange before graduation, holding anything at all, makes the curve's own graduate revert (review M-4): find
    // it first, so the page can say so plainly instead of guessing from a failed estimate.
    let pair: EvmPairState | null;
    let rescuable = false;
    try {
      pair = await this.loadPair(chain, token);
    } catch {
      pair = null;
    }
    if (evmPairBlocks(pair)) {
      const what = pairText(pair!, chain.symbol);
      if (chain.rescue) {
        rescuable = true;
        blockers.push(`Someone already made this token’s pool on ${chain.dex.name} and left ${what} in it, which blocks the normal move into a pool. Use “Graduate anyway”: Aretia’s rescue helper repairs that pool to the curve’s price and moves the curve into it in one transaction.`);
      } else {
        blockers.push(`Someone already made this token’s pool on ${chain.dex.name} and left ${what} in it, which blocks the normal move into a pool. Aretia’s rescue helper, which can repair that in one transaction, is not deployed on ${chain.name} yet, so this page cannot do it. Seven days after the curve sold out, anyone can unwind it here so holders can sell back along the curve.`);
      }
    }
    const r = await this.prepareSimple('graduate', chain, account, curve, token, tx, blockers, GRADUATE_GAS_CEILING);
    return { ...r, pair, rescuable };
  }

  /** "Graduate anyway": the rescue helper's plan, read from the helper itself, with an approval only when the repair needs tokens. */
  async prepareRescue(chain: EvmCurveChain, account: string, curve: EvmCurveState, token: string): Promise<EvmRescueReview> {
    const blockers = evmCurveProblems(curve);
    if (!evmCanGraduate(curve)) blockers.push('This curve has not sold out, or has already moved on.');
    let plan: EvmRescuePlan | null = null;
    let gasCostWei: bigint | null = null;
    let coinBalance = 0n;
    let tokensBefore = 0n;
    const helper = chain.rescue;
    if (!helper) blockers.push(`Aretia’s rescue helper is not deployed on ${chain.name} yet.`);
    try {
      if (helper && (await this.checkChain(chain, blockers))) {
        const code = await this.d.read('eth_getCode', [helper, 'latest']);
        if (typeof code !== 'string' || code === '0x') blockers.push('The rescue helper is not on this network at the address this page expects, so nothing was sent.');
        else {
          const curveOf = await this.call(helper, CURVE_SEL_HELPER_CURVE);
          if (typeof curveOf !== 'string' || curveOf.slice(-40).toLowerCase() !== chain.curve.slice(2)) blockers.push('The rescue helper at this address is not the one for this curve, so nothing was sent.');
          plan = parseRescuePlan(await this.call(helper, rescueQuoteData(token)));
          if (!plan) blockers.push('The rescue helper could not work out a repair for this pool.');
        }
        coinBalance = asBig(await this.d.read('eth_getBalance', [account, 'latest'])) ?? 0n;
        tokensBefore = await this.tokenBalance(token, account);
        if (plan && plan.tokensIn > tokensBefore) blockers.push(`The repair needs ${plan.tokensIn} of the token’s smallest units from your wallet, and it holds fewer. Anyone holding a few of these tokens can do this.`);
        const price = await this.gasPrice();
        if (price === null) blockers.push('The network did not give a gas price. Try again in a moment.');
        else {
          gasCostWei = (GRADUATE_GAS_CEILING + (plan && plan.tokensIn > 0n ? 80_000n : 0n)) * price;
          if (plan && coinBalance < plan.coinIn + gasCostWei) blockers.push(`You need more ${chain.symbol}: the coin the repair needs plus the network gas.`);
        }
      }
    } catch {
      blockers.push('The network could not be reached to check this. Try again in a moment.');
    }
    const maxTokens = plan?.tokensIn ?? 0n;
    const wei = plan?.coinIn ?? 0n;
    const approveTx = helper && maxTokens > 0n ? buildApproveTx(account, token, helper, maxTokens, chain.chainId) : null;
    const tx = buildRescueTx(account, helper ?? '0x0000000000000000000000000000000000000000', token, maxTokens, wei, chain.chainId);
    return { kind: 'rescue', chain, account, token, curve, plan, approveTx, tx, maxTokens, wei, tokensBefore, gasCostWei, coinBalance, blockers };
  }

  async rescue(review: EvmRescueReview, progress: (p: EvmCurveProgress) => void = () => undefined): Promise<EvmCurveOutcome> {
    const { chain, token } = review;
    const hashes: string[] = [];
    await this.begin(review, progress);
    if (review.approveTx) {
      const approveHash = await this.runTx(review.approveTx, (tx, id) => inspectRescueApprove(tx, { chain, from: review.account, token, amount: review.maxTokens }, id), 'approval', progress, 'approving', 'confirming-approve');
      hashes.push(approveHash);
      const allowance = wordOf(await this.call(token, CURVE_SEL.allowance + pad(review.account) + pad(chain.rescue!)));
      if (allowance !== review.maxTokens) throw new EvmCurveError(`The approval confirmed but the allowance is not exactly what you approved, so nothing else was sent. (${approveHash})`);
    }
    let hash: string;
    try {
      hash = await this.runTx(review.tx, (tx, id) => inspectRescue(tx, { chain, from: review.account, token, maxTokens: review.maxTokens, wei: review.wei, maxWei: review.plan?.coinIn ?? 0n }, id), 'rescue', progress, 'sending', 'confirming');
    } catch (e) {
      if (!review.approveTx) throw e;
      throw new EvmCurveError(`${e instanceof Error ? e.message : String(e)} The approval to the rescue helper is in place for exactly the tokens shown, and only your own wallet can use it. You can start again.`, false);
    }
    hashes.push(hash);
    progress('verifying');
    const state = await this.readBack(() => this.loadCurve(chain, token));
    const differences: string[] = [];
    if (!state || state.status !== 'migrated') differences.push('The curve does not show as moved into a pool.');
    progress('done');
    return { hashes, token, differences };
  }

  async prepareAbort(chain: EvmCurveChain, account: string, curve: EvmCurveState, token: string): Promise<EvmAbortReview> {
    const blockers = evmCurveProblems(curve);
    if (!evmCanAbort(curve, this.d.nowSeconds())) blockers.push('This curve cannot be unwound yet: it must have sold out and waited seven days without moving into a pool.');
    const tx = buildAbortTx(account, chain, token);
    return this.prepareSimple('abort', chain, account, curve, token, tx, blockers, 100_000n);
  }

  private async prepareSimple<K extends 'graduate' | 'abort'>(kind: K, chain: EvmCurveChain, account: string, curve: EvmCurveState, token: string, tx: EvmTxRequest, blockers: string[], gasCeiling: bigint) {
    let gasCostWei: bigint | null = null;
    let coinBalance = 0n;
    try {
      if (await this.checkChain(chain, blockers)) {
        coinBalance = asBig(await this.d.read('eth_getBalance', [account, 'latest'])) ?? 0n;
        const price = await this.gasPrice();
        if (price === null) blockers.push('The network did not give a gas price. Try again in a moment.');
        else {
          gasCostWei = gasCeiling * price;
          if (coinBalance < gasCostWei) blockers.push(`You need more ${chain.symbol} for the network gas${kind === 'graduate' ? ', which is large because the pool is created' : ''}.`);
        }
        if (blockers.length === 0 && (await this.estimate(tx)) === null) blockers.push(kind === 'graduate' ? `The network would refuse this${this.lastEstimateFailure || ': most likely a pool for this token already exists at another price'}.` : 'The network would not accept this, so nothing was sent.');
      }
    } catch {
      blockers.push('The network could not be reached to check this. Try again in a moment.');
    }
    return { kind, chain, account, token, curve, tx, gasCostWei, coinBalance, blockers } as K extends 'graduate' ? EvmGraduateReview : EvmAbortReview;
  }

  async graduate(review: EvmGraduateReview, progress: (p: EvmCurveProgress) => void = () => undefined): Promise<EvmCurveOutcome> {
    const { chain, token } = review;
    await this.begin(review, progress);
    const hash = await this.runTx(review.tx, (tx, id) => inspectGraduate(tx, { chain, from: review.account, token }, id), 'graduation', progress, 'sending', 'confirming');
    progress('verifying');
    const state = await this.readBack(() => this.loadCurve(chain, token));
    const differences: string[] = [];
    if (!state || state.status !== 'migrated') differences.push('The curve does not show as moved into a pool.');
    progress('done');
    return { hashes: [hash], token, differences };
  }

  async abort(review: EvmAbortReview, progress: (p: EvmCurveProgress) => void = () => undefined): Promise<EvmCurveOutcome> {
    const { chain, token } = review;
    await this.begin(review, progress);
    const hash = await this.runTx(review.tx, (tx, id) => inspectAbort(tx, { chain, from: review.account, token }, id), 'unwind', progress, 'sending', 'confirming');
    progress('verifying');
    const state = await this.readBack(() => this.loadCurve(chain, token));
    const differences: string[] = [];
    if (!state || state.status !== 'aborted') differences.push('The curve does not show as unwound.');
    progress('done');
    return { hashes: [hash], token, differences };
  }

  // ---------------------------------------------------------------- shared

  /** Refuses a review with blockers, and makes sure the wallet is on the right account and network. */
  private async begin(review: ReviewBase, progress: (p: EvmCurveProgress) => void): Promise<void> {
    if (review.blockers.length > 0) throw new EvmCurveError(review.blockers.join(' '), true);
    progress('checking');
    const account = (await this.d.adapter.getAccounts())[0];
    if (!account || account.toLowerCase() !== review.account.toLowerCase()) throw new EvmCurveError('The account selected in your wallet changed. Start again.', true);
    if ((await this.d.adapter.getChainId()) !== review.chain.chainId) {
      try {
        await this.d.adapter.switchChain(review.chain.chainId);
      } catch (e) {
        throw new EvmCurveError(e instanceof Error ? e.message : 'Your wallet could not switch networks.', true);
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
  private async runTx(
    tx: EvmTxRequest,
    inspect: (tx: EvmTxRequest, walletChainId: number) => string[],
    what: string,
    progress: (p: EvmCurveProgress) => void,
    signing: EvmCurveProgress,
    confirming: EvmCurveProgress,
  ): Promise<string> {
    const problems = inspect(tx, await this.d.adapter.getChainId());
    if (problems.length > 0) throw new EvmCurveError(`Not signing: ${problems.join(' ')}`, true);
    try {
      await this.d.read('eth_call', [{ from: tx.from, to: tx.to, data: tx.data, value: tx.value }, 'latest']);
    } catch (e) {
      throw new EvmCurveError(`The network would refuse the ${what}, so nothing was sent${reasonOf(e)}.`, true);
    }
    progress(signing);
    let hash: string;
    try {
      hash = await this.d.adapter.sendTransaction(tx);
    } catch (e) {
      const rejected = e instanceof SwingsError && e.code === 'rejected';
      throw new EvmCurveError(rejected ? 'You closed the wallet without approving.' : `The ${what} was not sent: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 160)}`, false);
    }
    progress(confirming);
    const r = await this.receipt(hash);
    if (!r) throw new EvmCurveError(`The ${what} was sent but has not confirmed yet. Check ${hash} on an explorer before trying again.`);
    if (r.status !== '0x1') throw new EvmCurveError(`The ${what} failed on the network; nothing from it took effect. (${hash})${await this.walletNote(hash, tx)}`);
    return hash;
  }

  /**
   * If the wallet sent something other than the plain transaction it was asked for (MetaMask can upgrade an account to a smart account and send
   * through its own delegation contract), say so: a failure then is often the wallet's wrapper, and trying again usually works.
   */
  private async walletNote(hash: string, asked: EvmTxRequest): Promise<string> {
    try {
      const sent = (await this.d.read('eth_getTransactionByHash', [hash])) as { to?: string; type?: string } | null;
      if (!sent) return '';
      const different = typeof sent.to === 'string' && typeof asked.to === 'string' && sent.to.toLowerCase() !== asked.to.toLowerCase();
      if (different || sent.type === '0x4')
        return ' Your wallet did not send this as the plain transaction shown here: it wrapped it in its smart-account feature, and that wrapper failed. The check done before sending passed, so trying again usually works.';
    } catch {
      // not available: no note
    }
    return '';
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
  [/not trading/i, ': the curve is not open for this'],
  [/not sold out/i, ': the curve has not sold out'],
  [/too early/i, ': it is too early'],
  // The exchange's own words when a pair made before graduation holds only one side (or dust): its `quote` needs both reserves above zero.
  [/UniswapV2Library: INSUFFICIENT_LIQUIDITY|PancakeLibrary: INSUFFICIENT_LIQUIDITY|INSUFFICIENT_LIQUIDITY(?!_)/i, ': a pool for this token was already made on the exchange with almost nothing in it, which blocks the move into a pool'],
  [/INSUFFICIENT_[AB]_AMOUNT|pool price/i, ': a pool for this token already exists at another price'],
  [/not from the factory/i, ': the token was not made by Aretia’s factory'],
  // Only the curve's own one-word reason: not any message that merely contains the word (e.g. "already exists with liquidity").
  [/(?:reverted:?\s*|reason string\s*['"]|message['"]?\s*:\s*['"])exists['"]?(?:\s|$|[.,)])/i, ': a curve for this token already exists'],
  [/allowance/i, ': the approval is missing'],
  [/OutOfFunds|insufficient funds|exceeds balance/i, ': your wallet holds less than the amount plus the network fee'],
];
function reasonOf(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  for (const [re, words] of REASONS) if (re.test(text)) return words;
  return '';
}

/** "1 wei of WETH", "12 token units and 3 wei of WETH (not synced)". */
function pairText(p: EvmPairState, symbol: string): string {
  const parts: string[] = [];
  const coin = p.reserveCoin + p.unsyncedCoin;
  const tok = p.reserveToken + p.unsyncedToken;
  if (tok > 0n) parts.push(`${tok} of the token’s smallest units`);
  if (coin > 0n) parts.push(`${coin} wei of wrapped ${symbol}`);
  return parts.join(' and ') + (p.unsyncedCoin > 0n || p.unsyncedToken > 0n ? ' (some of it not yet synced)' : '');
}
