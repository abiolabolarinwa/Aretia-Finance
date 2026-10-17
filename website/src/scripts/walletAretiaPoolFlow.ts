/**
 * Aretia Pool on the web wallet: the steps that open, trade, claim from and lock a pool, with every outside dependency passed in so
 * each path can be tested without a network or a wallet. walletAretiaPool.ts connects it to the page.
 *
 *   loadToken  read the token and the creator's balance of it; refuse tokens that are not fixed-supply Token-2022 tokens
 *   prepare    build the transaction, check it, try it on the network without sending, and price it from that trial
 *   create     check again, have the wallet sign, send, wait, and read the pool back and compare it with what was approved
 *   trade, claim, lock: the same four steps for one instruction each
 * Every action is one transaction, so there is nothing half-done to resume: either it happened or nothing moved.
 */
import type * as Web3 from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, ataAddress } from './walletTools';
import { accountAmount, parseMintAccount, type AccountReader } from './walletLaunchChain';
import { LaunchError, friendlyError, type Confirmation } from './walletLaunchFlow';
import { tokenBlockers, type PoolConfig, type PoolToken } from './walletPoolCore';
import {
  ARETIA_POOL_NETWORK_ESTIMATE_LAMPORTS,
  aretiaPoolCost,
  buy,
  claimable,
  minOut,
  parsePoolAccount,
  parsePositionAccount,
  poolMathOf,
  sell,
  type AretiaPoolCost,
  type CreateParams,
  type PoolAccount,
  type PositionAccount,
} from './walletAretiaPoolCore';
import { assemble, buildClaim, buildCreatePool, buildLock, buildSwap, inspectClaim, inspectCreate, inspectLock, inspectSwap, poolAddress, positionAddress, type BuiltCreate } from './walletAretiaPoolTx';

export interface PoolSimulation {
  ok: boolean;
  error: string | null;
  /** The signer's SOL after the transaction, if the network reported it. */
  lamportsAfter: bigint | null;
}

export interface AretiaPoolFlowDeps {
  web3: typeof Web3;
  program: string;
  balanceOf(address: string): Promise<bigint>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  fetchAccount: AccountReader;
  simulate(tx: Web3.Transaction, watch: string): Promise<PoolSimulation>;
  signAndSubmit(tx: Web3.Transaction, extraSigners: readonly Web3.Signer[]): Promise<string>;
  confirm(signature: string): Promise<Confirmation>;
  sleep?(ms: number): Promise<void>;
}

export interface AretiaPoolReview {
  config: PoolConfig;
  params: CreateParams;
  built: BuiltCreate;
  cost: AretiaPoolCost;
  balance: bigint;
  /** Reasons the pool cannot be opened. Empty means it can. */
  blockers: string[];
}

export type AretiaPoolProgress = 'checking' | 'signing' | 'confirming' | 'verifying' | 'done';

export interface AretiaPoolOutcome {
  pool: string;
  position: string;
  signature: string;
  /** Differences between what was approved and what the network shows. Empty means it matches. */
  differences: string[];
}

export interface PoolView {
  pool: PoolAccount;
  position: PositionAccount | null;
  decimals: number;
  /** Fees the position could claim now. */
  claimable: bigint;
}

export interface TradeQuote {
  isBuy: boolean;
  amountIn: bigint;
  /** Tokens on a buy, lamports after the fee on a sell. */
  expectedOut: bigint;
  minOut: bigint;
  fee: bigint;
}

/** A short extra margin beyond the measured cost, so a small change in rent does not leave the transaction short. */
const SAFETY_MARGIN_LAMPORTS = 50_000n;

export class AretiaPoolFlow {
  constructor(private readonly d: AretiaPoolFlowDeps) {}

  private sleep = (ms: number) => (this.d.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);

  private async blockhash(): Promise<[string, number]> {
    const b = await this.d.latestBlockhash();
    return [b.blockhash, b.lastValidBlockHeight];
  }

  private toBase58 = (bytes: Uint8Array): string => new this.d.web3.PublicKey(bytes).toBase58();

  /** The token and how much of it the creator holds. Null if it is not a readable Token-2022 token. */
  async loadToken(creator: string, mint: string): Promise<PoolToken | null> {
    const { web3, fetchAccount } = this.d;
    const acc = await fetchAccount(mint);
    const facts = acc ? parseMintAccount(web3, acc.owner, acc.data) : null;
    if (!facts) return null;
    const held = accountAmount((await fetchAccount(ataAddress(web3, creator, mint, TOKEN_2022_PROGRAM_ID)))?.data ?? null) ?? 0n;
    return { mint, decimals: facts.decimals, supply: facts.supply, mintAuthority: facts.mintAuthority, freezeAuthority: facts.freezeAuthority, extensions: facts.extensions, held };
  }

  /** The pool for a token and, if the wallet has one, its position. Null when no pool exists or it is not the program's. */
  async loadPool(mint: string, owner: string | null): Promise<PoolView | null> {
    const { web3, program, fetchAccount } = this.d;
    const poolAddr = poolAddress(web3, program, mint);
    const acc = await fetchAccount(poolAddr);
    if (!acc || acc.owner !== program) return null;
    const pool = parsePoolAccount(acc.data, this.toBase58);
    if (!pool || pool.mint !== mint) return null;
    let position: PositionAccount | null = null;
    if (owner) {
      const p = await fetchAccount(positionAddress(web3, program, poolAddr, owner));
      if (p && p.owner === program) position = parsePositionAccount(p.data, this.toBase58);
    }
    const mintAcc = await fetchAccount(mint);
    const decimals = (mintAcc ? parseMintAccount(web3, mintAcc.owner, mintAcc.data) : null)?.decimals ?? 0;
    return { pool, position, decimals, claimable: position ? (claimable(pool, position) ?? 0n) : 0n };
  }

  async prepare(config: PoolConfig, params: CreateParams, token: PoolToken): Promise<AretiaPoolReview> {
    const { web3, program } = this.d;
    const blockers = tokenBlockers(token);
    const built = buildCreatePool(web3, program, params);
    const balance = await this.d.balanceOf(config.creator);
    if (await this.d.fetchAccount(built.pool)) blockers.push('A pool for this token already exists on this program, and only one can be opened.');

    let network = ARETIA_POOL_NETWORK_ESTIMATE_LAMPORTS;
    const tx = assemble(web3, built.instructions, config.creator, ...(await this.blockhash()));
    const trial = await this.d.simulate(tx, config.creator);
    if (trial.ok && trial.lamportsAfter !== null && balance >= trial.lamportsAfter) {
      const spent = balance - trial.lamportsAfter;
      const fee = aretiaPoolCost(0n).aretiaFee;
      network = spent > fee ? spent - fee : 0n;
    } else if (!trial.ok) blockers.push(`The network would refuse this in a trial run: ${trial.error ?? 'unknown reason'}.`);

    const cost = aretiaPoolCost(network);
    if (balance < cost.total + SAFETY_MARGIN_LAMPORTS) blockers.push('Your wallet does not hold enough SOL to cover the fees and the deposits shown, with a small margin.');
    return { config, params, built, cost, balance, blockers };
  }

  async create(review: AretiaPoolReview, progress: (p: AretiaPoolProgress) => void = () => undefined): Promise<AretiaPoolOutcome> {
    const { web3, program } = this.d;
    const { params, built } = review;
    if (review.blockers.length > 0) throw new LaunchError(review.blockers.join(' '), true);
    progress('checking');
    const tx = assemble(web3, built.instructions, params.creator, ...(await this.blockhash()));
    const blockers = inspectCreate(web3, tx, { params, program, pool: built.pool });
    if (blockers.length > 0) throw new LaunchError(`Not signing: ${blockers.join(' ')}`, true);
    const signature = await this.submit(tx, params.creator, progress);
    progress('verifying');
    const differences = await this.readBack(review);
    progress('done');
    return { pool: built.pool, position: built.position, signature, differences };
  }

  /** Check once more, try it on the network without sending, have the wallet sign, send, and wait. */
  private async submit(tx: Web3.Transaction, watch: string, progress: (p: AretiaPoolProgress) => void): Promise<string> {
    const sim = await this.d.simulate(tx, watch);
    if (!sim.ok) throw new LaunchError(`The network would refuse this transaction, so it was not sent: ${sim.error ?? 'unknown reason'}.`, true);
    progress('signing');
    let signature: string;
    try {
      signature = await this.d.signAndSubmit(tx, []);
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

  /** The pool account must exist, belong to the program, and hold exactly what was approved. Read a few times: a node can briefly lag. */
  private async readBack(review: AretiaPoolReview): Promise<string[]> {
    const { params } = review;
    for (let i = 0; i < 6; i++) {
      const view = await this.loadPool(params.mint, params.creator);
      if (view) {
        const out: string[] = [];
        const p = view.pool;
        if (p.x !== params.x0 || p.y !== params.y0 || p.l !== params.l0) out.push('The pool holds different amounts than the ones approved.');
        if (p.feeBps !== params.feeBps) out.push('The pool has a different trading fee than the one approved.');
        if (p.creator !== params.creator) out.push('The pool records a different creator.');
        if (!view.position || view.position.shares !== params.l0) out.push('Your position is not the one approved.');
        else if ((view.position.locked === params.l0) !== params.lock) out.push('The lock is not as approved.');
        return out;
      }
      await this.sleep(1000);
    }
    return ['The new pool could not be read back from the network.'];
  }

  /** A quote for a trade against the pool as it is now, with a floor for the amount received. */
  quote(pool: PoolAccount, isBuy: boolean, amountIn: bigint, slippageBps: number): TradeQuote | null {
    const m = poolMathOf(pool);
    if (isBuy) {
      const q = buy(m, amountIn);
      return q ? { isBuy, amountIn, expectedOut: q.result.tokensOut, minOut: minOut(q.result.tokensOut, slippageBps), fee: q.result.fee } : null;
    }
    const q = sell(m, amountIn);
    return q ? { isBuy, amountIn, expectedOut: q.result.net, minOut: minOut(q.result.net, slippageBps), fee: q.result.fee } : null;
  }

  async trade(trader: string, mint: string, q: TradeQuote, progress: (p: AretiaPoolProgress) => void = () => undefined): Promise<string> {
    const { web3, program } = this.d;
    if (q.minOut <= 0n) throw new LaunchError('The trade has no minimum on what you receive, so it was not built.', true);
    progress('checking');
    const s = { trader, mint, isBuy: q.isBuy, amountIn: q.amountIn, minOut: q.minOut };
    const tx = assemble(web3, [buildSwap(web3, program, s)], trader, ...(await this.blockhash()));
    const blockers = inspectSwap(web3, tx, { ...s, program });
    if (blockers.length > 0) throw new LaunchError(`Not signing: ${blockers.join(' ')}`, true);
    const signature = await this.submit(tx, trader, progress);
    progress('done');
    return signature;
  }

  async claim(owner: string, mint: string, progress: (p: AretiaPoolProgress) => void = () => undefined): Promise<string> {
    const { web3, program } = this.d;
    progress('checking');
    const tx = assemble(web3, [buildClaim(web3, program, owner, mint)], owner, ...(await this.blockhash()));
    const blockers = inspectClaim(web3, tx, { program, owner, mint });
    if (blockers.length > 0) throw new LaunchError(`Not signing: ${blockers.join(' ')}`, true);
    const signature = await this.submit(tx, owner, progress);
    progress('done');
    return signature;
  }

  async lock(owner: string, mint: string, amount: bigint, progress: (p: AretiaPoolProgress) => void = () => undefined): Promise<string> {
    const { web3, program } = this.d;
    progress('checking');
    const tx = assemble(web3, [buildLock(web3, program, owner, mint, amount)], owner, ...(await this.blockhash()));
    const blockers = inspectLock(web3, tx, { program, owner, mint, amount });
    if (blockers.length > 0) throw new LaunchError(`Not signing: ${blockers.join(' ')}`, true);
    const signature = await this.submit(tx, owner, progress);
    progress('done');
    return signature;
  }
}
