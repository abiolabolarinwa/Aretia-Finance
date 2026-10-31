/**
 * "Your pools": listing a wallet's positions and claiming a position's fees, with every outside dependency passed in so each path can
 * be tested without a network or a wallet. walletYourPools.ts connects it to the page.
 *
 * Claiming: build the transaction, check it against the position that was shown, try it on the network without sending, have the
 * wallet sign, send, wait, and read the position back to see that its fees are now claimed.
 */
import { explainTrialError } from './walletTools';
import type * as Web3 from '@solana/web3.js';
import { LaunchError, friendlyError, type Confirmation } from './walletLaunchFlow';
import type { PoolLibs } from './walletPoolTx';
import { hasClaimable, sortPositions, type PoolPosition } from './walletYourPoolsCore';
import { assembleClaim, buildClaim, inspectClaim } from './walletYourPoolsTx';

export interface YourPoolsDeps {
  web3: typeof Web3;
  libs: PoolLibs;
  /** Every position the wallet owns. */
  readPositions(owner: string): Promise<{ positions: PoolPosition[]; truncated: boolean }>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  simulate(tx: Web3.Transaction): Promise<{ ok: boolean; error: string | null }>;
  signAndSubmit(tx: Web3.Transaction): Promise<string>;
  confirm(signature: string): Promise<Confirmation>;
  sleep?(ms: number): Promise<void>;
}

export type ClaimProgress = 'checking' | 'signing' | 'confirming' | 'verifying' | 'done';

export interface ClaimOutcome {
  signature: string;
  /** The position as the chain shows it after the claim, or null if it can no longer be read. */
  after: PoolPosition | null;
  /** Differences between what was expected and what the chain shows. Empty means the fees were claimed. */
  differences: string[];
}

export class YourPoolsFlow {
  constructor(private readonly d: YourPoolsDeps) {}

  private sleep = (ms: number) => (this.d.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);

  async list(owner: string): Promise<{ positions: PoolPosition[]; truncated: boolean }> {
    const r = await this.d.readPositions(owner);
    return { positions: sortPositions(r.positions), truncated: r.truncated };
  }

  /** Builds and checks the claim, and tries it on the network without sending. Returns why it cannot go ahead, if it cannot. */
  async prepare(owner: string, p: PoolPosition): Promise<{ blockers: string[]; instructions: Web3.TransactionInstruction[] }> {
    if (!hasClaimable(p)) return { blockers: ['There are no fees to claim yet.'], instructions: [] };
    const { web3, libs } = this.d;
    const instructions = await buildClaim(web3, libs, owner, p);
    const bh = await this.d.latestBlockhash();
    const tx = assembleClaim(web3, instructions, owner, bh.blockhash, bh.lastValidBlockHeight);
    const blockers = inspectClaim(web3, tx, owner, p);
    if (blockers.length === 0) {
      const sim = await this.d.simulate(tx);
      if (!sim.ok) blockers.push(`The network would refuse this in a trial run: ${explainTrialError(sim.error)}.`);
    }
    return { blockers, instructions };
  }

  async claim(owner: string, p: PoolPosition, progress: (s: ClaimProgress) => void = () => undefined): Promise<ClaimOutcome> {
    const { web3 } = this.d;
    progress('checking');
    const ready = await this.prepare(owner, p);
    if (ready.blockers.length > 0) throw new LaunchError(ready.blockers.join(' '), true);

    // A fresh blockhash and one more check on exactly what is signed.
    const bh = await this.d.latestBlockhash();
    const tx = assembleClaim(web3, ready.instructions, owner, bh.blockhash, bh.lastValidBlockHeight);
    const again = inspectClaim(web3, tx, owner, p);
    if (again.length > 0) throw new LaunchError(`Not signing: ${again.join(' ')}`, true);

    progress('signing');
    let signature: string;
    try {
      signature = await this.d.signAndSubmit(tx);
    } catch (e) {
      const message = friendlyError(e);
      throw new LaunchError(message, /closed the wallet|different transaction/.test(message));
    }
    progress('confirming');
    const state = await this.d.confirm(signature);
    if (state === 'failed') throw new LaunchError('The transaction failed on the network. Nothing from it took effect.');
    if (state === 'pending') throw new LaunchError(`The transaction was sent but has not confirmed yet. Check ${signature} on an explorer, then reload this list.`);

    progress('verifying');
    let after: PoolPosition | null = null;
    for (let i = 0; i < 5 && after === null; i++) {
      const r = await this.d.readPositions(owner);
      after = r.positions.find((x) => x.position === p.position) ?? null;
      // A node can briefly lag behind a transaction it has just confirmed: read again until the fees have dropped. (New trades can
      // add fees right after a claim, so "dropped" is what is checked, not "zero".)
      if (after && !(after.feeA < p.feeA || after.feeB < p.feeB) && i < 4) {
        after = null;
        await this.sleep(1000);
      }
    }
    const claimed = after !== null && (after.feeA < p.feeA || after.feeB < p.feeB);
    const differences = after === null ? ['The position could not be read back from the network.'] : claimed ? [] : ['The network does not show the fees as claimed yet. Reload the list in a moment.'];
    progress('done');
    return { signature, after, differences };
  }
}
