/**
 * Aretia Launch on the web wallet: the steps of selling a token on the Aretia curve, with every outside dependency passed in so
 * each path can be tested without a network or a wallet. walletCurve.ts connects it to the page.
 *
 *   loadToken / loadCurve     read the token and the creator's balance, or a curve's state, from the network
 *   prepare*                  work out the numbers, build the transaction, check it, try it without sending, and price it
 *   create / buy / sell /     check again, have the wallet sign, send, wait, and read the result back from the network
 *   migrate / abort
 * Each action is one transaction: either it happened or nothing moved.
 */
import type * as Web3 from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, ataAddress } from './walletTools';
import { accountAmount, parseMintAccount, type AccountReader } from './walletLaunchChain';
import { LaunchError, friendlyError, type Confirmation } from './walletLaunchFlow';
import { tokenBlockers, type PoolToken } from './walletPoolCore';
import { METEORA_PROGRAM_ID } from './walletPoolTx';
import {
  CURVE_FEE_BPS,
  CREATE_NETWORK_ESTIMATE_LAMPORTS,
  MIGRATE_RENT_ESTIMATE_LAMPORTS,
  SLIPPAGE_BPS_DEFAULT,
  canAbort,
  canMigrate,
  curveProblems,
  migrationArgs,
  minOut,
  parseCurveAccount,
  quoteBuy,
  quoteSell,
  type BuyQuote,
  type CurveConfig,
  type CurveState,
  type SellQuote,
} from './walletCurveCore';
import {
  assembleCurve,
  buildAbort,
  buildBuy,
  buildClaimFees,
  buildCreate,
  buildMigrate,
  buildSell,
  curveAddress,
  inspectAbort,
  inspectBuy,
  inspectClaimFees,
  inspectCreate,
  inspectMigrate,
  inspectSell,
  meteoraPoolAddress,
  migrateAddresses,
  migratorAddress,
  type MigrateArgs,
} from './walletCurveTx';

export interface CurveSimulation {
  ok: boolean;
  error: string | null;
  /** The watched wallet's SOL after the transaction, if the network reported it. */
  lamportsAfter: bigint | null;
}

export interface CurveFlowDeps {
  web3: typeof Web3;
  /** The curve program to use, from a constant for the cluster, never from the page. */
  program: string;
  balanceOf(address: string): Promise<bigint>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  fetchAccount: AccountReader;
  simulate(tx: Web3.Transaction, watch: string): Promise<CurveSimulation>;
  signAndSubmit(tx: Web3.Transaction, extraSigners: readonly Web3.Signer[]): Promise<string>;
  confirm(signature: string): Promise<Confirmation>;
  /** Seconds since 1970, from the network's own clock when it has one. */
  nowSecs(): number;
  /** The mint of the position NFT an owner holds (a Token-2022 account with exactly one token of a mint other than `exceptMint`), or null. */
  /** The graduated position held by `owner` (the migrator) in `pool`, read from Meteora's Position accounts, with its own pool field. */
  positionNft?(owner: string, pool: string): Promise<{ nft: string; pool: string } | null>;
  sleep?(ms: number): Promise<void>;
}

export type CurveProgress = 'checking' | 'signing' | 'confirming' | 'verifying' | 'done';

/** Everything a review screen shows, and the transaction behind it. */
interface ReviewBase {
  /** What the transaction takes from the wallet beyond the trade itself: network fee and account deposits. */
  network: bigint;
  balance: bigint;
  /** Reasons the action cannot go ahead. Empty means it can. */
  blockers: string[];
  instructions: Web3.TransactionInstruction[];
}

export interface CreateReview extends ReviewBase {
  kind: 'create';
  config: CurveConfig;
  firstBuy: BuyQuote | null;
  firstBuyMinOut: bigint;
}
export interface BuyReview extends ReviewBase {
  kind: 'buy';
  trader: string;
  mint: string;
  curve: CurveState;
  /** Null when the amount cannot buy anything; then `blockers` says so. */
  quote: BuyQuote | null;
  offered: bigint;
  minOut: bigint;
  tokensBefore: bigint;
}
export interface SellReview extends ReviewBase {
  kind: 'sell';
  trader: string;
  mint: string;
  curve: CurveState;
  quote: SellQuote | null;
  tokensIn: bigint;
  minOut: bigint;
  tokensBefore: bigint;
}
export interface MigrateReview extends ReviewBase {
  kind: 'migrate';
  payer: string;
  mint: string;
  curve: CurveState;
  args: MigrateArgs;
  /** The position's NFT key: held in memory for this one transaction, then dropped. */
  signer: Web3.Keypair;
  pool: string;
}
export interface AbortReview extends ReviewBase {
  kind: 'abort';
  caller: string;
  mint: string;
  curve: CurveState;
}
export interface ClaimFeesReview extends ReviewBase {
  kind: 'claim-fees';
  caller: string;
  mint: string;
  curve: CurveState;
  /** The graduated position's NFT mint, found from what the migrator holds. */
  nft: string;
}
export type CurveReview = CreateReview | BuyReview | SellReview | MigrateReview | AbortReview | ClaimFeesReview;

export interface CurveOutcome {
  signature: string;
  curve: string;
  /** Differences between what was approved and what the network shows. Empty means it matches. */
  differences: string[];
  /** For a buy or sell: tokens the wallet holds now. */
  tokensAfter?: bigint;
  pool?: string;
}

/** A short extra margin beyond the measured cost, so a small change in rent does not leave the transaction short. */
const SAFETY_MARGIN_LAMPORTS = 50_000n;

export class CurveFlow {
  constructor(private readonly d: CurveFlowDeps) {}

  private sleep = (ms: number) => (this.d.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);

  // ---------------------------------------------------------------- reading

  /** The token and how much of it the creator holds. Null if it is not a readable Token-2022 token. */
  async loadToken(owner: string, mint: string): Promise<PoolToken | null> {
    const { web3, fetchAccount } = this.d;
    const acc = await fetchAccount(mint);
    const facts = acc ? parseMintAccount(web3, acc.owner, acc.data) : null;
    if (!facts) return null;
    const held = accountAmount((await fetchAccount(ataAddress(web3, owner, mint, TOKEN_2022_PROGRAM_ID)))?.data ?? null) ?? 0n;
    return { mint, decimals: facts.decimals, supply: facts.supply, mintAuthority: facts.mintAuthority, freezeAuthority: facts.freezeAuthority, extensions: facts.extensions, held };
  }

  /** The curve for a token, or null if there is none or the account is not a well-formed curve of this program. */
  async loadCurve(mint: string): Promise<CurveState | null> {
    const { web3, program } = this.d;
    const acc = await this.d.fetchAccount(curveAddress(web3, program, mint));
    if (!acc) return null;
    const c = parseCurveAccount(web3, acc.owner, program, acc.data);
    return c && c.mint === mint ? c : null;
  }

  /** A wallet's live balance of the token (its Token-2022 account), for example the curve opener's. */
  async heldBy(owner: string, mint: string): Promise<bigint> {
    return this.tokensHeld(owner, mint);
  }

  private async tokensHeld(owner: string, mint: string): Promise<bigint> {
    const { web3 } = this.d;
    return accountAmount((await this.d.fetchAccount(ataAddress(web3, owner, mint, TOKEN_2022_PROGRAM_ID)))?.data ?? null) ?? 0n;
  }

  private async blockhash(): Promise<[string, number]> {
    const b = await this.d.latestBlockhash();
    return [b.blockhash, b.lastValidBlockHeight];
  }

  /** Builds, trial-runs, and returns what the transaction takes from the wallet beyond `tradeLamports`. */
  private async price(instructions: Web3.TransactionInstruction[], payer: string, balance: bigint, tradeLamports: bigint, fallback: bigint, blockers: string[]): Promise<bigint> {
    const tx = assembleCurve(this.d.web3, instructions, payer, ...(await this.blockhash()));
    const trial = await this.d.simulate(tx, payer);
    if (trial.ok && trial.lamportsAfter !== null && balance >= trial.lamportsAfter) {
      const spent = balance - trial.lamportsAfter;
      return spent > tradeLamports ? spent - tradeLamports : 0n;
    }
    if (!trial.ok) blockers.push(`The network would refuse this in a trial run: ${explain(trial.error)}.`);
    return fallback;
  }

  private checkFunds(balance: bigint, need: bigint, blockers: string[]): void {
    if (balance < need + SAFETY_MARGIN_LAMPORTS) blockers.push('Your wallet does not hold enough SOL to cover this and the fees shown, with a small margin.');
  }

  // ---------------------------------------------------------------- create

  async prepareCreate(config: CurveConfig, token: PoolToken): Promise<CreateReview> {
    const { web3, program } = this.d;
    const blockers = tokenBlockers(token);
    const balance = await this.d.balanceOf(config.creator);
    if (await this.d.fetchAccount(curveAddress(web3, program, config.mint))) blockers.push('A curve for this token already exists, and only one can be opened.');

    let firstBuy: BuyQuote | null = null;
    let firstBuyMinOut = 0n;
    if (config.firstBuyLamports > 0n) {
      const start = { vSol: config.derived.vSol0, vTok: config.derived.vTok0, realSol: 0n, realTok: config.derived.curveTokens };
      firstBuy = quoteBuy(start, config.firstBuyLamports, CURVE_FEE_BPS);
      if (!firstBuy) blockers.push('Your first buy is too small to get any tokens.');
      else firstBuyMinOut = firstBuy.tokensOut;
    }
    const instructions = buildCreate(web3, program, { config, firstBuyMinOut });
    // The first buy takes the whole offer, fee included; it is counted as the trade, not as a cost.
    const trade = firstBuy?.gross ?? 0n;
    const network = await this.price(instructions, config.creator, balance, trade, CREATE_NETWORK_ESTIMATE_LAMPORTS, blockers);
    this.checkFunds(balance, network + trade, blockers);
    return { kind: 'create', config, firstBuy, firstBuyMinOut, instructions, network, balance, blockers };
  }

  async create(review: CreateReview, progress: (p: CurveProgress) => void = () => undefined): Promise<CurveOutcome> {
    const { web3, program } = this.d;
    const { config } = review;
    const curve = curveAddress(web3, program, config.mint);
    const signature = await this.send(review, config.creator, [], progress, (tx) => inspectCreate(web3, tx, { program, config, firstBuyMinOut: review.firstBuyMinOut }));
    progress('verifying');
    const state = await this.readBack(() => this.loadCurve(config.mint));
    const differences: string[] = [];
    if (!state) differences.push('The new curve could not be read back from the network.');
    else {
      const d = config.derived;
      if (state.creator !== config.creator) differences.push('The curve names a different creator.');
      if (state.target !== config.targetLamports) differences.push('The curve’s raise target is not the one approved.');
      if (state.curveTokens !== d.curveTokens || state.lpTokens !== d.lpTokens) differences.push('The curve’s split between the curve and the pool is not the one approved.');
      if (state.vSol0 !== d.vSol0) differences.push('The curve’s starting reserves are not the ones approved.');
      differences.push(...curveProblems(state));
      const vault = accountAmount((await this.d.fetchAccount(ataAddress(web3, curve, config.mint, TOKEN_2022_PROGRAM_ID)))?.data ?? null);
      // After the creator's own first buy the vault holds the total less what was bought.
      const expected = config.totalRaw - (review.firstBuy?.tokensOut ?? 0n);
      if (vault !== expected) differences.push('The curve’s token vault does not hold the amount approved.');
    }
    progress('done');
    return { signature, curve, differences };
  }

  // ---------------------------------------------------------------- buy and sell

  async prepareBuy(trader: string, curve: CurveState, offered: bigint, slippageBps: number = SLIPPAGE_BPS_DEFAULT): Promise<BuyReview> {
    const { web3, program } = this.d;
    const blockers = curveProblems(curve);
    if (curve.status !== 'trading') blockers.push('This curve is not open for buying.');
    const balance = await this.d.balanceOf(trader);
    const quote = quoteBuy(curve, offered, curve.feeBps);
    if (!quote) {
      blockers.push('That amount is too small to buy any tokens, or the curve has nothing left to sell.');
      return { kind: 'buy', trader, mint: curve.mint, curve, quote: null, offered, minOut: 0n, tokensBefore: 0n, instructions: [], network: 0n, balance, blockers };
    }
    const min = minOut(quote.tokensOut, slippageBps);
    const instructions = buildBuy(web3, program, trader, curve.mint, offered, min);
    const network = await this.price(instructions, trader, balance, quote.gross, 3_000_000n, blockers);
    this.checkFunds(balance, network + quote.gross, blockers);
    return { kind: 'buy', trader, mint: curve.mint, curve, quote, offered, minOut: min, tokensBefore: await this.tokensHeld(trader, curve.mint), instructions, network, balance, blockers };
  }

  async buy(review: BuyReview, progress: (p: CurveProgress) => void = () => undefined): Promise<CurveOutcome> {
    const { web3, program } = this.d;
    const signature = await this.send(review, review.trader, [], progress, (tx) => inspectBuy(web3, tx, { program, trader: review.trader, mint: review.mint, amount: review.offered, minOut: review.minOut }));
    progress('verifying');
    const state = await this.readBack(() => this.loadCurve(review.mint));
    const after = await this.tokensHeld(review.trader, review.mint);
    const differences: string[] = [];
    if (!state) differences.push('The curve could not be read back from the network.');
    else differences.push(...curveProblems(state));
    if (after < review.tokensBefore + review.minOut) differences.push('The wallet holds fewer tokens than the least it was willing to accept.');
    progress('done');
    return { signature, curve: curveAddress(web3, program, review.mint), differences, tokensAfter: after };
  }

  async prepareSell(trader: string, curve: CurveState, tokensIn: bigint, slippageBps: number = SLIPPAGE_BPS_DEFAULT): Promise<SellReview> {
    const { web3, program } = this.d;
    const blockers = curveProblems(curve);
    if (curve.status !== 'trading' && curve.status !== 'aborted') blockers.push('This curve is not open for selling.');
    const balance = await this.d.balanceOf(trader);
    const held = await this.tokensHeld(trader, curve.mint);
    if (tokensIn > held) blockers.push('More than your wallet holds of this token.');
    const quote = quoteSell(curve, curve.curveTokens, tokensIn, curve.feeBps);
    if (!quote) {
      blockers.push('That amount cannot be sold back to the curve.');
      return { kind: 'sell', trader, mint: curve.mint, curve, quote: null, tokensIn, minOut: 0n, tokensBefore: held, instructions: [], network: 0n, balance, blockers };
    }
    // The program accepts a sale that pays nothing (audit L-8) and the tokens would be gone for 0 lamports: refuse it here.
    if (quote.net === 0n) {
      blockers.push('That amount is too small: the curve would pay you 0 SOL for it, and the tokens would be lost. Sell a larger amount.');
      return { kind: 'sell', trader, mint: curve.mint, curve, quote, tokensIn, minOut: 0n, tokensBefore: held, instructions: [], network: 0n, balance, blockers };
    }
    const min = minOut(quote.net, slippageBps);
    const instructions = buildSell(web3, program, trader, curve.mint, tokensIn, min);
    // The sale pays the wallet, so measure the trial against the balance plus the proceeds: what is left is the network cost.
    const network = await this.price(instructions, trader, balance + quote.net, 0n, 10_000n, blockers);
    this.checkFunds(balance, network, blockers);
    return { kind: 'sell', trader, mint: curve.mint, curve, quote, tokensIn, minOut: min, tokensBefore: held, instructions, network, balance, blockers };
  }

  async sell(review: SellReview, progress: (p: CurveProgress) => void = () => undefined): Promise<CurveOutcome> {
    const { web3, program } = this.d;
    const signature = await this.send(review, review.trader, [], progress, (tx) => inspectSell(web3, tx, { program, trader: review.trader, mint: review.mint, amount: review.tokensIn, minOut: review.minOut }));
    progress('verifying');
    const state = await this.readBack(() => this.loadCurve(review.mint));
    const after = await this.tokensHeld(review.trader, review.mint);
    const differences: string[] = [];
    if (!state) differences.push('The curve could not be read back from the network.');
    else differences.push(...curveProblems(state));
    if (after !== review.tokensBefore - review.tokensIn) differences.push('The wallet does not hold the amount of tokens it should after the sale.');
    progress('done');
    return { signature, curve: curveAddress(web3, program, review.mint), differences, tokensAfter: after };
  }

  // ---------------------------------------------------------------- graduation

  async prepareMigrate(payer: string, curve: CurveState): Promise<MigrateReview> {
    const { web3, program } = this.d;
    const blockers = curveProblems(curve);
    if (!canMigrate(curve)) blockers.push('This curve has not sold out, or has already moved on.');
    const signer = web3.Keypair.generate();
    const pool = migrateAddresses(web3, curve.mint, signer.publicKey.toBase58()).pool;
    const balance = await this.d.balanceOf(payer);
    const calc = migrationArgs(curve.realSol, curve.lpTokens);
    if (!calc) {
      blockers.push('The pool could not be worked out from this curve.');
      return { kind: 'migrate', payer, mint: curve.mint, curve, args: { rentBudget: 0n, liquidity: 0n, sqrtPrice: 0n }, signer, pool, instructions: [], network: 0n, balance, blockers };
    }
    if (await this.d.fetchAccount(pool)) blockers.push('A pool for this token against SOL already exists, so this curve cannot move into one. After seven days anyone can unwind the curve so holders can sell back.');
    const args: MigrateArgs = { rentBudget: MIGRATE_RENT_ESTIMATE_LAMPORTS, liquidity: calc.liquidity, sqrtPrice: calc.sqrtPrice };
    const instructions = buildMigrate(web3, program, payer, curve.mint, signer.publicKey.toBase58(), args);
    const network = await this.price(instructions, payer, balance, 0n, MIGRATE_RENT_ESTIMATE_LAMPORTS, blockers);
    this.checkFunds(balance, network, blockers);
    return { kind: 'migrate', payer, mint: curve.mint, curve, args, signer, pool, instructions, network, balance, blockers };
  }

  async migrate(review: MigrateReview, progress: (p: CurveProgress) => void = () => undefined): Promise<CurveOutcome> {
    const { web3, program } = this.d;
    const nft = review.signer.publicKey.toBase58();
    const signature = await this.send(review, review.payer, [review.signer], progress, (tx) => inspectMigrate(web3, tx, { program, payer: review.payer, mint: review.mint, nft, args: review.args }));
    progress('verifying');
    const state = await this.readBack(() => this.loadCurve(review.mint));
    const differences: string[] = [];
    if (!state) differences.push('The curve could not be read back from the network.');
    else {
      if (state.status !== 'migrated') differences.push('The curve does not show as moved into a pool.');
      if (state.pool !== review.pool) differences.push('The curve names a different pool from the one shown.');
    }
    const pool = await this.d.fetchAccount(review.pool);
    if (!pool) differences.push('The new pool could not be read back from the network.');
    else if (pool.owner !== METEORA_PROGRAM_ID) differences.push('The pool account is not owned by the pool program.');
    progress('done');
    return { signature, curve: curveAddress(web3, program, review.mint), differences, pool: review.pool };
  }

  async prepareAbort(caller: string, curve: CurveState): Promise<AbortReview> {
    const { web3, program } = this.d;
    const blockers = curveProblems(curve);
    if (!canAbort(curve, this.d.nowSecs())) {
      // A curve whose pool someone else has already opened can never move into it, so it may be unwound at once.
      const pool = curve.status === 'soldOut' ? await this.d.fetchAccount(meteoraPoolAddress(web3, curve.mint)).catch(() => null) : null;
      if (!(pool && pool.owner === METEORA_PROGRAM_ID)) blockers.push('This curve cannot be unwound yet: it must have sold out and waited seven days without moving into a pool.');
    }
    const balance = await this.d.balanceOf(caller);
    const instructions = buildAbort(web3, program, caller, curve.mint);
    const network = await this.price(instructions, caller, balance, 0n, 10_000n, blockers);
    this.checkFunds(balance, network, blockers);
    return { kind: 'abort', caller, mint: curve.mint, curve, instructions, network, balance, blockers };
  }

  async abort(review: AbortReview, progress: (p: CurveProgress) => void = () => undefined): Promise<CurveOutcome> {
    const { web3, program } = this.d;
    const signature = await this.send(review, review.caller, [], progress, (tx) => inspectAbort(web3, tx, { program, caller: review.caller, mint: review.mint }));
    progress('verifying');
    const state = await this.readBack(() => this.loadCurve(review.mint));
    const differences: string[] = [];
    if (!state || state.status !== 'aborted') differences.push('The curve does not show as unwound.');
    progress('done');
    return { signature, curve: curveAddress(web3, program, review.mint), differences };
  }

  /** Sends a graduated pool's trading fees to Aretia. Anyone may do it; the fees can only go to Aretia's fee wallet. */
  async prepareClaimFees(caller: string, curve: CurveState): Promise<ClaimFeesReview> {
    const { web3, program } = this.d;
    // The reserve checks describe a curve that is trading; once it has moved into its pool its SOL is gone from it by design.
    const blockers: string[] = [];
    if (curve.status !== 'migrated' || !curve.pool) blockers.push('This curve has not moved into its pool, so there are no pool fees yet.');
    const migrator = migratorAddress(web3, program, curveAddress(web3, program, curve.mint));
    const found = curve.status === 'migrated' && curve.pool && this.d.positionNft ? await this.d.positionNft(migrator, curve.pool).catch(() => null) : null;
    const nft = found?.nft ?? null;
    if (curve.status === 'migrated' && !nft) blockers.push('The pool’s position could not be found from the network just now. Try again in a moment.');
    // The position's own pool field must be this curve's pool, and so must the pool the claim instruction names.
    if (found && curve.pool && (found.pool !== curve.pool || migrateAddresses(web3, curve.mint, found.nft).pool !== curve.pool)) blockers.push('The position found does not belong to this curve’s pool.');
    const balance = await this.d.balanceOf(caller);
    const instructions = nft ? buildClaimFees(web3, program, caller, curve.mint, nft) : [];
    const network = nft && blockers.length === 0 ? await this.price(instructions, caller, balance, 0n, 10_000n, blockers) : 0n;
    this.checkFunds(balance, network, blockers);
    return { kind: 'claim-fees', caller, mint: curve.mint, curve, nft: nft ?? '', instructions, network, balance, blockers };
  }

  async claimFees(review: ClaimFeesReview, progress: (p: CurveProgress) => void = () => undefined): Promise<CurveOutcome> {
    const { web3, program } = this.d;
    const signature = await this.send(review, review.caller, [], progress, (tx) => inspectClaimFees(web3, tx, { program, caller: review.caller, mint: review.mint, nft: review.nft }));
    progress('done');
    return { signature, curve: curveAddress(web3, program, review.mint), differences: [] };
  }

  // ---------------------------------------------------------------- shared

  /** Check, try, sign, send, wait. Throws a plain-language LaunchError at the first thing that is wrong. */
  private async send(
    review: ReviewBase,
    payer: string,
    extra: readonly Web3.Signer[],
    progress: (p: CurveProgress) => void,
    inspect: (tx: Web3.Transaction) => string[],
  ): Promise<string> {
    if (review.blockers.length > 0) throw new LaunchError(review.blockers.join(' '), true);
    progress('checking');
    const tx = assembleCurve(this.d.web3, review.instructions, payer, ...(await this.blockhash()));
    const blockers = inspect(tx);
    if (blockers.length > 0) throw new LaunchError(`Not signing: ${blockers.join(' ')}`, true);
    const sim = await this.d.simulate(tx, payer);
    if (!sim.ok) throw new LaunchError(`The network would refuse this transaction, so it was not sent: ${explain(sim.error)}.`, true);

    progress('signing');
    let signature: string;
    try {
      signature = await this.d.signAndSubmit(tx, extra);
    } catch (e) {
      const message = friendlyError(e);
      throw new LaunchError(message, /closed the wallet|different transaction/.test(message));
    }
    progress('confirming');
    const state = await this.d.confirm(signature);
    if (state === 'failed') throw new LaunchError('The transaction failed on the network. Nothing from it took effect.');
    if (state === 'pending') throw new LaunchError(`The transaction was sent but has not confirmed yet. Check ${signature} on an explorer before trying again.`);
    return signature;
  }

  /** Reads a few times: a node can briefly lag behind the confirmation. */
  private async readBack<T>(read: () => Promise<T | null>): Promise<T | null> {
    for (let i = 0; i < 6; i++) {
      const v = await read();
      if (v) return v;
      await this.sleep(1000);
    }
    return null;
  }
}

/** The program's own error names, in words. */
const PROGRAM_ERRORS: [RegExp, string][] = [
  [/Slippage|0x1775|\b6005\b/, 'the price moved past the limit set, so nothing was bought or sold'],
  [/NotTrading|0x1773|\b6003\b/, 'the curve is not open for this'],
  [/TradeTooSmall|0x1774|\b6004\b/, 'that trade is too small to buy or sell anything'],
  [/MintNotAllowed|0x1770|\b6000\b/, 'this token is not one a curve accepts'],
  [/PoolPriceMismatch|0x177b|\b6011\b/, 'the pool could not be opened at the price the curve ended at'],
  [/TooEarly|0x1779|\b6009\b/, 'it is too early'],
];
function explain(error: string | null): string {
  const text = error ?? 'unknown reason';
  for (const [re, words] of PROGRAM_ERRORS) if (re.test(text)) return words;
  return text.slice(0, 200);
}
