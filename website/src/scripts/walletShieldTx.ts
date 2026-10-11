/**
 * The two fixes Shield offers for a Solana wallet, built here and signed by the person's own wallet:
 *  - revoke: take back the standing permission an address has over a token account;
 *  - reclaim: close empty token accounts and get their rent back to the wallet.
 * Each is simulated on the network before the wallet is asked, and the wallet shows exactly what it is signing.
 */
import type * as Web3 from '@solana/web3.js';
import { CLOSE_ACCOUNT_DATA, CLOSE_PER_TRANSACTION, chunk, REVOKE_DATA, type TokenAccount } from '../swings/shield/health.js';
import { loadWeb3, rpcCall, signAndSubmitTransaction, simulateTransaction, waitForConfirmation } from './walletSend.js';

async function buildTransaction(owner: string, make: (web3: typeof Web3, ownerKey: Web3.PublicKey) => Web3.TransactionInstruction[]): Promise<Web3.Transaction> {
  const web3 = await loadWeb3();
  const ownerKey = new web3.PublicKey(owner);
  const { value } = await rpcCall<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  return new web3.Transaction({ feePayer: ownerKey, recentBlockhash: value.blockhash }).add(...make(web3, ownerKey));
}

export const revokeTransaction = (owner: string, accounts: readonly TokenAccount[]): Promise<Web3.Transaction> =>
  buildTransaction(owner, (web3, ownerKey) =>
    accounts.map(
      (a) =>
        new web3.TransactionInstruction({
          programId: new web3.PublicKey(a.program),
          keys: [
            { pubkey: new web3.PublicKey(a.address), isSigner: false, isWritable: true },
            { pubkey: ownerKey, isSigner: true, isWritable: false },
          ],
          data: Buffer.from(REVOKE_DATA),
        }),
    ),
  );

export const closeTransaction = (owner: string, accounts: readonly TokenAccount[]): Promise<Web3.Transaction> =>
  buildTransaction(owner, (web3, ownerKey) =>
    accounts.map(
      (a) =>
        new web3.TransactionInstruction({
          programId: new web3.PublicKey(a.program),
          keys: [
            { pubkey: new web3.PublicKey(a.address), isSigner: false, isWritable: true },
            // The rent goes back to the wallet that owns the account.
            { pubkey: ownerKey, isSigner: false, isWritable: true },
            { pubkey: ownerKey, isSigner: true, isWritable: false },
          ],
          data: Buffer.from(CLOSE_ACCOUNT_DATA),
        }),
    ),
  );

export interface FixResult {
  signatures: string[];
  confirmed: boolean;
}

async function run(transactions: Web3.Transaction[], onStep?: (done: number, total: number) => void): Promise<FixResult> {
  const signatures: string[] = [];
  let confirmed = true;
  for (const [i, tx] of transactions.entries()) {
    const sim = await simulateTransaction(tx);
    if (!sim.ok) throw new Error(`The network would reject this, so it was not sent to your wallet: ${sim.error}`);
    const signature = await signAndSubmitTransaction(tx);
    signatures.push(signature);
    confirmed = (await waitForConfirmation(signature)) === 'confirmed' && confirmed;
    onStep?.(i + 1, transactions.length);
  }
  return { signatures, confirmed };
}

/** Takes back the permission on each account, a few to a transaction. */
export async function revoke(owner: string, accounts: readonly TokenAccount[], onStep?: (done: number, total: number) => void): Promise<FixResult> {
  const txs: Web3.Transaction[] = [];
  for (const group of chunk(accounts, CLOSE_PER_TRANSACTION)) txs.push(await revokeTransaction(owner, group));
  return run(txs, onStep);
}

/** Closes the empty accounts, a few to a transaction, one wallet approval each. */
export async function reclaim(owner: string, accounts: readonly TokenAccount[], onStep?: (done: number, total: number) => void): Promise<FixResult> {
  const txs: Web3.Transaction[] = [];
  for (const group of chunk(accounts, CLOSE_PER_TRANSACTION)) txs.push(await closeTransaction(owner, group));
  return run(txs, onStep);
}
