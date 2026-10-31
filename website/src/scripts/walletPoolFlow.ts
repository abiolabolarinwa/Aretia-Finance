/**
 * Aretia Launch on the web wallet: the steps that open a pool, with every outside dependency passed in so each path can be tested
 * without a network or a wallet. walletPool.ts connects it to the page.
 *
 *   loadToken  read the token and the creator's balance of it; refuse tokens that are not fixed-supply Token-2022 tokens
 *   prepare    build the transaction, check it, try it on the network without sending, and price it from that trial
 *   create     check again, have the wallet sign, send, wait, and read the pool back from the network
 * One transaction, so there is nothing half-done to resume: either the pool exists afterwards or nothing moved.
 */
import type * as Web3 from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ataAddress, explainTrialError } from './walletTools';
import { accountAmount, parseMintAccount, type AccountReader } from './walletLaunchChain';
import { LaunchError, friendlyError, type Confirmation } from './walletLaunchFlow';
import { POOL_NETWORK_ESTIMATE_LAMPORTS, poolCost, quoteOf, tokenBlockers, type PoolConfig, type PoolCost, type PoolToken, type QuoteRead } from './walletPoolCore';
import { METEORA_PROGRAM_ID, assemblePool, buildPool, inspectPool, type BuiltPool, type PoolLibs } from './walletPoolTx';

export interface PoolSimulation {
  ok: boolean;
  error: string | null;
  /** The creator's SOL after the transaction, if the network reported it. */
  lamportsAfter: bigint | null;
}

export interface PoolFlowDeps {
  web3: typeof Web3;
  libs: PoolLibs;
  balanceOf(address: string): Promise<bigint>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  fetchAccount: AccountReader;
  simulate(tx: Web3.Transaction, watch: string): Promise<PoolSimulation>;
  signAndSubmit(tx: Web3.Transaction, extraSigners: readonly Web3.Signer[]): Promise<string>;
  confirm(signature: string): Promise<Confirmation>;
  sleep?(ms: number): Promise<void>;
}

export interface PoolReview {
  config: PoolConfig;
  built: BuiltPool;
  /** The position NFT's key: held in memory for this one transaction, then dropped. */
  signer: Web3.Keypair;
  cost: PoolCost;
  balance: bigint;
  /** Reasons the pool cannot be opened. Empty means it can. */
  blockers: string[];
}

export type PoolProgress = 'checking' | 'signing' | 'confirming' | 'verifying' | 'done';

export interface PoolOutcome {
  pool: string;
  position: string;
  signature: string;
  /** Differences between what was approved and what the network shows. Empty means it matches. */
  differences: string[];
}

/** A short extra margin beyond the measured cost, so a small change in rent does not leave the transaction short. */
const SAFETY_MARGIN_LAMPORTS = 50_000n;

export class PoolFlow {
  constructor(private readonly d: PoolFlowDeps) {}

  private sleep = (ms: number) => (this.d.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);

  /** The token and how much of it the creator holds. Null if it is not a readable Token-2022 token. */
  async loadToken(creator: string, mint: string): Promise<PoolToken | null> {
    const { web3, fetchAccount } = this.d;
    const acc = await fetchAccount(mint);
    const facts = acc ? parseMintAccount(web3, acc.owner, acc.data) : null;
    if (!facts) return null;
    const held = accountAmount((await fetchAccount(ataAddress(web3, creator, mint, TOKEN_2022_PROGRAM_ID)))?.data ?? null) ?? 0n;
    return { mint, decimals: facts.decimals, supply: facts.supply, mintAuthority: facts.mintAuthority, freezeAuthority: facts.freezeAuthority, extensions: facts.extensions, held };
  }

  /**
   * The facts of the token buyers would pay with, read from its mint account. Null when the account is missing, is not a mint of the
   * classic token program or Token-2022, or does not read cleanly: such a pair is refused, never guessed.
   */
  async loadQuote(mint: string): Promise<QuoteRead | null> {
    const { web3, fetchAccount } = this.d;
    const acc = await fetchAccount(mint);
    if (!acc) return null;
    if (acc.owner === TOKEN_2022_PROGRAM_ID) {
      const f = parseMintAccount(web3, acc.owner, acc.data);
      return f ? { mint, program: acc.owner, decimals: f.decimals, mintAuthority: f.mintAuthority, freezeAuthority: f.freezeAuthority, extensions: f.extensions } : null;
    }
    if (acc.owner !== TOKEN_PROGRAM_ID || acc.data.length !== 82 || acc.data[45] !== 1) return null;
    const v = new DataView(acc.data.buffer, acc.data.byteOffset, acc.data.byteLength);
    // An optional key is a 4-byte tag (0 none, 1 some) then 32 bytes; any other tag is not a mint this page will describe.
    const mintTag = v.getUint32(0, true);
    const freezeTag = v.getUint32(46, true);
    if (mintTag > 1 || freezeTag > 1) return null;
    return { mint, program: acc.owner, decimals: acc.data[44]!, mintAuthority: mintTag === 1 ? 'set' : null, freezeAuthority: freezeTag === 1 ? 'set' : null, extensions: [] };
  }

  async prepare(config: PoolConfig, token: PoolToken): Promise<PoolReview> {
    const { web3, libs } = this.d;
    const blockers = tokenBlockers(token);
    const signer = web3.Keypair.generate();
    const built = await buildPool(web3, libs, config, signer.publicKey.toBase58());
    const balance = await this.d.balanceOf(config.creator);

    if (await this.d.fetchAccount(built.pool)) blockers.push(`A pool for this token against ${quoteOf(config).symbol} already exists, and only one can be opened here.`);

    // Trial run: tells us the exact SOL it takes, and refuses early for anything the network would refuse.
    let network = POOL_NETWORK_ESTIMATE_LAMPORTS;
    const tx = assemblePool(web3, built.instructions, config.creator, ...(await this.blockhash()));
    const trial = await this.d.simulate(tx, config.creator);
    if (trial.ok && trial.lamportsAfter !== null && balance >= trial.lamportsAfter) {
      const spent = balance - trial.lamportsAfter;
      const fee = poolCost(0n).aretiaFee;
      network = spent > fee ? spent - fee : 0n;
    } else if (!trial.ok) blockers.push(`The network would refuse this in a trial run: ${explainTrialError(trial.error)}.`);

    const cost = poolCost(network);
    if (balance < cost.total + SAFETY_MARGIN_LAMPORTS) blockers.push('Your wallet does not hold enough SOL to cover the fees and the deposits shown, with a small margin.');
    return { config, built, signer, cost, balance, blockers };
  }

  private async blockhash(): Promise<[string, number]> {
    const b = await this.d.latestBlockhash();
    return [b.blockhash, b.lastValidBlockHeight];
  }

  async create(review: PoolReview, progress: (p: PoolProgress) => void = () => undefined): Promise<PoolOutcome> {
    const { web3 } = this.d;
    const { config, built, signer } = review;
    if (review.blockers.length > 0) throw new LaunchError(review.blockers.join(' '), true);
    progress('checking');
    const tx = assemblePool(web3, built.instructions, config.creator, ...(await this.blockhash()));
    const blockers = inspectPool(web3, tx, { config, nft: signer.publicKey.toBase58(), pool: built.pool, math: built.math });
    if (blockers.length > 0) throw new LaunchError(`Not signing: ${blockers.join(' ')}`, true);
    const sim = await this.d.simulate(tx, config.creator);
    if (!sim.ok) throw new LaunchError(`The network would refuse this transaction, so it was not sent: ${sim.error ?? 'unknown reason'}.`, true);

    progress('signing');
    let signature: string;
    try {
      signature = await this.d.signAndSubmit(tx, [signer]);
    } catch (e) {
      const message = friendlyError(e);
      throw new LaunchError(message, /closed the wallet|different transaction/.test(message));
    }
    progress('confirming');
    const state = await this.d.confirm(signature);
    if (state === 'failed') throw new LaunchError('The transaction failed on the network. Nothing from it took effect.');
    if (state === 'pending')
      throw new LaunchError(`The transaction was sent but has not confirmed yet. Check ${signature} on an explorer before trying again: a second attempt would be refused if the pool exists.`);

    progress('verifying');
    const differences = await this.readBack(review);
    progress('done');
    return { pool: built.pool, position: built.position, signature, differences };
  }

  /** The pool account must exist and belong to the pool program. Read a few times: a node can briefly lag. */
  private async readBack(review: PoolReview): Promise<string[]> {
    for (let i = 0; i < 6; i++) {
      const acc = await this.d.fetchAccount(review.built.pool);
      if (acc) return acc.owner === METEORA_PROGRAM_ID ? [] : ['The pool account is not owned by the pool program.'];
      await this.sleep(1000);
    }
    return ['The new pool could not be read back from the network.'];
  }
}
