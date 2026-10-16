/**
 * Aretia Launch on the web wallet: the steps that create a token, with every outside dependency passed in so each path can be
 * tested without a network or a wallet. walletLaunch.ts connects it to the page.
 *
 * The order is deliberate and each step refuses to go on if the one before it is not what was approved:
 *   prepare   price it, check the balance, generate the new token's key (kept in memory only)
 *   step 1    check the transaction against the approval, simulate it, have the wallet sign it, wait for it, read the token back
 *   step 2    only if the token read back exactly as approved: check, simulate, sign, wait, read back the supply and each wallet
 * Before step 1 is sent a record is stored on this device, so a closed tab or a failed second transaction can be finished later.
 * The new token's key signs only the first transaction and is dropped; it is never stored.
 */
import type * as Web3 from '@solana/web3.js';
import { distributionOf, estimateCost, type CostEstimate, type DistributionLine, type LaunchConfig } from './walletLaunchCore';
import { TOKEN_ACCOUNT_SIZE, assemble, buildStep1, buildStep2, inspectStep, mintSizes } from './walletLaunchTx';
import {
  assessPending,
  clearPending,
  compareBalances,
  compareMint,
  loadPending,
  readBalances,
  readMint,
  savePending,
  type AccountReader,
  type MintFacts,
  type PendingCreation,
  type StorageLike,
} from './walletLaunchChain';

export type Confirmation = 'confirmed' | 'failed' | 'pending';

export interface FlowDeps {
  web3: typeof Web3;
  rentFor(size: number): Promise<bigint>;
  balanceOf(address: string): Promise<bigint>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  fetchAccount: AccountReader;
  simulate(tx: Web3.Transaction): Promise<{ ok: boolean; error: string | null }>;
  /** Has the connected wallet sign, checks it returned the same transaction, adds the extra signers and submits. Returns the signature. */
  signAndSubmit(tx: Web3.Transaction, extraSigners: readonly Web3.Signer[]): Promise<string>;
  confirm(signature: string): Promise<Confirmation>;
  storage: StorageLike;
  now(): number;
  /** Waits between reads of a just-confirmed token. Replaced in tests. */
  sleep?(ms: number): Promise<void>;
}

export interface Review {
  config: LaunchConfig;
  /** The new token's address. */
  mint: string;
  cost: CostEstimate;
  lines: DistributionLine[];
  balance: bigint;
  /** Reasons the creation cannot go ahead. Empty means it can. */
  blockers: string[];
  /** The new token's key. Held in memory for the first transaction only. */
  signer: Web3.Keypair;
  mintRentLamports: bigint;
}

export type Progress =
  | 'checking'
  | 'signing-1'
  | 'confirming-1'
  | 'verifying-1'
  | 'signing-2'
  | 'confirming-2'
  | 'verifying-2'
  | 'done';

export interface Outcome {
  mint: string;
  step1: string | null;
  step2: string | null;
  /** Differences between what was approved and what the chain shows. Empty means it matches. */
  differences: string[];
}

/** An error whose message is safe and plain to show as it is. `nothingSent` means no transaction left this page. */
export class LaunchError extends Error {
  constructor(
    message: string,
    readonly nothingSent = false,
  ) {
    super(message);
  }
}

/** A short extra margin beyond the estimate, so a small change in rent or fees does not leave the second transaction short. */
const SAFETY_MARGIN_LAMPORTS = 50_000n;

export class LaunchFlow {
  constructor(private readonly d: FlowDeps) {}

  private sleep = (ms: number) => (this.d.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);

  async prepare(config: LaunchConfig): Promise<Review> {
    const { web3, rentFor, balanceOf } = this.d;
    const sizes = mintSizes(config);
    const [mintRentLamports, tokenAccountDeposit, balance] = await Promise.all([rentFor(sizes.withMetadata), rentFor(TOKEN_ACCOUNT_SIZE), balanceOf(config.creator)]);
    const lines = distributionOf(config);
    const cost = estimateCost({ mintDeposit: mintRentLamports, tokenAccountDeposit, accountCount: lines.length });
    const blockers: string[] = [];
    if (balance < cost.total + SAFETY_MARGIN_LAMPORTS)
      blockers.push('Your wallet does not hold enough SOL to cover the network fees and the deposits shown, with a small margin.');
    const signer = web3.Keypair.generate();
    return { config, mint: signer.publicKey.toBase58(), cost, lines, balance, blockers, signer, mintRentLamports };
  }

  /** Reads the token a few times: a node can briefly lag behind a transaction it has just confirmed. */
  private async readConfirmed(mint: string, ready: (f: MintFacts | null) => boolean): Promise<MintFacts | null> {
    let facts: MintFacts | null = null;
    for (let i = 0; i < 6; i++) {
      facts = await readMint(this.d.web3, this.d.fetchAccount, mint);
      if (ready(facts)) return facts;
      await this.sleep(1000);
    }
    return facts;
  }

  /** Builds, checks, simulates, signs, sends and waits for one transaction. Returns its signature. */
  private async send(step: 1 | 2, tx: () => Web3.Transaction, check: (t: Web3.Transaction) => string[], signers: readonly Web3.Signer[], progress: (p: Progress) => void, record: (sig: string) => void): Promise<string> {
    const built = tx();
    const blockers = check(built);
    if (blockers.length > 0) throw new LaunchError(`Not signing: ${blockers.join(' ')}`, true);
    const sim = await this.d.simulate(built);
    if (!sim.ok) throw new LaunchError(`The network would refuse this transaction, so it was not sent: ${sim.error ?? 'unknown reason'}.`, true);
    progress(step === 1 ? 'signing-1' : 'signing-2');
    let signature: string;
    try {
      signature = await this.d.signAndSubmit(built, signers);
    } catch (e) {
      const message = friendlyError(e);
      // A closed wallet window means nothing was signed. Any other failure after signing may have reached the network.
      throw new LaunchError(message, /closed the wallet|different transaction/.test(message));
    }
    record(signature);
    progress(step === 1 ? 'confirming-1' : 'confirming-2');
    const state = await this.d.confirm(signature);
    if (state === 'failed') throw new LaunchError('The transaction failed on the network. Nothing from it took effect.');
    if (state === 'pending')
      throw new LaunchError(`The transaction was sent but has not confirmed yet. Check ${signature} on an explorer. If it lands, come back to this page and finish from there.`);
    return signature;
  }

  /** The whole creation. Throws a LaunchError with a plain message; the stored record lets a later visit finish it. */
  async create(review: Review, progress: (p: Progress) => void = () => undefined): Promise<Outcome> {
    const { config, mint } = review;
    if (review.blockers.length > 0) throw new LaunchError(review.blockers.join(' '));
    if (loadPending(this.d.storage, config.creator)) throw new LaunchError('This wallet has an unfinished token creation. Finish or clear it first.');
    progress('checking');

    const pending: PendingCreation = { mint, config, stage: 'started', step1: null, step2: null, at: this.d.now() };
    savePending(this.d.storage, pending);

    return this.runFrom(review, pending, review.signer, progress);
  }

  private async runFrom(review: Review, pending: PendingCreation, signer: Web3.Keypair, progress: (p: Progress) => void): Promise<Outcome> {
    try {
      return await this.runStep1ThenFinish(review, pending, signer, progress);
    } catch (e) {
      // If nothing ever left this page, there is nothing to resume: drop the record rather than leave a puzzle for later.
      if (e instanceof LaunchError && e.nothingSent && pending.step1 === null) clearPending(this.d.storage, pending.config.creator);
      throw e;
    }
  }

  private async runStep1ThenFinish(review: Review, pending: PendingCreation, signer: Web3.Keypair, progress: (p: Progress) => void): Promise<Outcome> {
    const { web3 } = this.d;
    const { config, mint, mintRentLamports } = review;
    const bh1 = await this.d.latestBlockhash();
    const step1 = await this.send(
      1,
      () => assemble(web3, buildStep1(web3, { config, mint, mintRentLamports }), config.creator, bh1.blockhash, bh1.lastValidBlockHeight),
      (t) => inspectStep(web3, t, 1, { config, mint, mintRentLamports }),
      [signer],
      progress,
      (sig) => {
        pending.step1 = sig;
        savePending(this.d.storage, pending);
      },
    );
    progress('verifying-1');
    const facts = await this.readConfirmed(mint, (f) => f !== null);
    const diffs = facts ? compareMint(facts, config, mint, 'created') : ['The new token could not be read back from the network.'];
    if (diffs.length > 0) throw new LaunchError(`The token that was created is not what you approved, so the supply was not created. ${diffs.join(' ')}`);
    pending.stage = 'created';
    savePending(this.d.storage, pending);
    return this.finishFrom(pending, step1, progress);
  }

  /** The second transaction and the final check, for a token whose first transaction is confirmed and verified. */
  private async finishFrom(pending: PendingCreation, step1: string | null, progress: (p: Progress) => void): Promise<Outcome> {
    const { web3 } = this.d;
    const { config, mint } = pending;
    const bh2 = await this.d.latestBlockhash();
    const step2 = await this.send(
      2,
      () => assemble(web3, buildStep2(web3, config, mint), config.creator, bh2.blockhash, bh2.lastValidBlockHeight),
      (t) => inspectStep(web3, t, 2, { config, mint, mintRentLamports: 0n }),
      [],
      progress,
      (sig) => {
        pending.step2 = sig;
        savePending(this.d.storage, pending);
      },
    );
    progress('verifying-2');
    const facts = await this.readConfirmed(mint, (f) => f !== null && f.supply === config.totalSupplyRaw);
    const differences = facts ? compareMint(facts, config, mint, 'complete') : ['The token could not be read back from the network.'];
    const held = await readBalances(web3, this.d.fetchAccount, config, mint);
    differences.push(...compareBalances(web3, config, mint, held));
    clearPending(this.d.storage, config.creator);
    progress('done');
    return { mint, step1: step1 ?? pending.step1, step2, differences };
  }

  // ---------------------------------------------------------------- finishing a stored creation

  /** What a stored creation needs, from what the chain shows now. */
  async assess(creator: string): Promise<{ pending: PendingCreation; action: 'none' | 'finish' | 'verify' | 'stop'; reason: string } | null> {
    const pending = loadPending(this.d.storage, creator);
    if (!pending) return null;
    const facts = await readMint(this.d.web3, this.d.fetchAccount, pending.mint);
    const r = assessPending(pending, facts);
    return { pending, action: r.action, reason: r.reason };
  }

  /** Finishes a stored creation: runs the second transaction only if the chain still shows exactly the half-made token. */
  async finish(creator: string, progress: (p: Progress) => void = () => undefined): Promise<Outcome> {
    progress('checking');
    const a = await this.assess(creator);
    if (!a) throw new LaunchError('There is no unfinished creation for this wallet.');
    if (a.action !== 'finish') throw new LaunchError(a.reason);
    return this.finishFrom(a.pending, a.pending.step1, progress);
  }

  /** Reads back a creation whose supply already exists, and clears the record. */
  async verifyStored(creator: string): Promise<Outcome> {
    const a = await this.assess(creator);
    if (!a) throw new LaunchError('There is no unfinished creation for this wallet.');
    if (a.action !== 'verify') throw new LaunchError(a.reason);
    const { config, mint } = a.pending;
    const facts = await readMint(this.d.web3, this.d.fetchAccount, mint);
    const differences = facts ? compareMint(facts, config, mint, 'complete') : ['The token could not be read back from the network.'];
    differences.push(...compareBalances(this.d.web3, config, mint, await readBalances(this.d.web3, this.d.fetchAccount, config, mint)));
    clearPending(this.d.storage, config.creator);
    return { mint, step1: a.pending.step1, step2: a.pending.step2, differences };
  }

  /** Drops a stored record that is no longer useful (the token was never created, or the person chooses to stop). */
  discard(creator: string): void {
    clearPending(this.d.storage, creator);
  }
}

/** Plain language for the errors a wallet or the network gives. Never shows raw error objects. */
export function friendlyError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  if (/reject|denied|declin|cancel|closed|user abort/i.test(text)) return 'You closed the wallet without approving. Nothing was sent.';
  if (/different transaction/i.test(text)) return text;
  if (/insufficient|0x1\b|custom program error: 0x1\b/i.test(text)) return 'The network says the wallet does not hold enough SOL for this.';
  if (/blockhash/i.test(text)) return 'The network moved on before the transaction could be sent. Nothing was sent. Try again.';
  const first = text.split('\n')[0] ?? '';
  return `The transaction was not sent: ${first.slice(0, 160)}`;
}
