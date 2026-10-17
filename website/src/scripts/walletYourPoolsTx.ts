/**
 * "Your pools": the one transaction that claims a position's trading fees, and a check of it before anyone signs.
 *
 * The instructions come from Meteora's SDK (the same pinned version the pool card uses). The inspector reads each one back as raw
 * bytes and refuses anything else: another program, an extra transfer, fees going to an account that is not the owner's, a different
 * position or pool, an extra signer, a different fee payer. There is no Aretia fee in this transaction on purpose (see
 * walletYourPoolsCore.ts), so nothing here sends SOL anywhere but back to the owner.
 *
 * The transaction, in order: create the owner's token accounts if they are missing (at most one for each of the pool's two tokens),
 * the claim, and, when one side is wrapped SOL, closing the owner's wrapped-SOL account so the SOL arrives as plain SOL.
 */
import type * as Web3 from '@solana/web3.js';
import { ATA_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ataAddress } from './walletTools';
import { SYSTEM_PROGRAM_ID } from './walletLaunchTx';
import { METEORA_POOL_AUTHORITY, METEORA_PROGRAM_ID, assemblePool, type PoolLibs } from './walletPoolTx';
import { NATIVE_MINT, type PoolPosition } from './walletYourPoolsCore';

const CLAIM_DISCRIMINATOR = Uint8Array.from([180, 38, 154, 17, 133, 33, 162, 211]);
/** The token program's CloseAccount instruction. */
const CLOSE_ACCOUNT = 9;

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

function eventAuthority(web3: typeof Web3): string {
  return web3.PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], new web3.PublicKey(METEORA_PROGRAM_ID))[0].toBase58();
}

/** What the claim is built from, taken from the position the person is looking at. */
export type ClaimTarget = Pick<PoolPosition, 'pool' | 'position' | 'positionNftAccount' | 'a' | 'b'>;

export async function buildClaim(web3: typeof Web3, libs: PoolLibs, owner: string, t: ClaimTarget): Promise<Web3.TransactionInstruction[]> {
  const tx = await libs.cpAmm.claimPositionFee({
    owner: new web3.PublicKey(owner),
    position: new web3.PublicKey(t.position),
    pool: new web3.PublicKey(t.pool),
    positionNftAccount: new web3.PublicKey(t.positionNftAccount),
    tokenAMint: new web3.PublicKey(t.a.mint),
    tokenBMint: new web3.PublicKey(t.b.mint),
    tokenAVault: new web3.PublicKey(t.a.vault),
    tokenBVault: new web3.PublicKey(t.b.vault),
    tokenAProgram: new web3.PublicKey(t.a.program),
    tokenBProgram: new web3.PublicKey(t.b.program),
  });
  // Compute-budget instructions are dropped: the check allows only the instructions listed above, and the wallet sets its own limits.
  return tx.instructions.filter((ix) => ix.programId.toBase58() !== 'ComputeBudget111111111111111111111111111111');
}

export function assembleClaim(web3: typeof Web3, instructions: Web3.TransactionInstruction[], owner: string, blockhash: string, lastValidBlockHeight: number): Web3.Transaction {
  return assemblePool(web3, instructions, owner, blockhash, lastValidBlockHeight);
}

/**
 * Reads the built transaction back and compares it with the position that was shown. Returns the reasons not to sign; empty means
 * every instruction is one of the expected ones, on the expected accounts, and only the owner has to sign.
 */
export function inspectClaim(web3: typeof Web3, tx: Web3.Transaction, owner: string, t: ClaimTarget): string[] {
  const blockers: string[] = [];
  if (tx.feePayer?.toBase58() !== owner) blockers.push('The fee would be paid by an account other than yours.');
  const signers = new Set<string>();
  for (const ix of tx.instructions) for (const m of ix.keys) if (m.isSigner) signers.add(m.pubkey.toBase58());
  for (const s of signers) if (s !== owner) blockers.push(`An unexpected account would have to sign: ${s}.`);

  const mine = { a: ataAddress(web3, owner, t.a.mint, t.a.program), b: ataAddress(web3, owner, t.b.mint, t.b.program) };
  const key = (ix: Web3.TransactionInstruction, i: number) => ix.keys[i]?.pubkey.toBase58() ?? '';
  const program = (ix: Web3.TransactionInstruction) => ix.programId.toBase58();
  const data = (ix: Web3.TransactionInstruction) => Uint8Array.from(ix.data);

  let claims = 0;
  const created = new Set<string>();
  const closed = new Set<string>();
  tx.instructions.forEach((ix, n) => {
    const d = data(ix);
    // Creating one of the owner's own token accounts.
    if (program(ix) === ATA_PROGRAM_ID) {
      const ok = d.length === 1 && d[0] === 1 && ix.keys.length === 6 && key(ix, 0) === owner && key(ix, 2) === owner && key(ix, 4) === SYSTEM_PROGRAM_ID;
      const expected = [{ ata: mine.a, mint: t.a.mint, prog: t.a.program }, { ata: mine.b, mint: t.b.mint, prog: t.b.program }].find((e) => e.ata === key(ix, 1));
      if (!ok || !expected || key(ix, 3) !== expected.mint || key(ix, 5) !== expected.prog || created.has(expected.ata)) blockers.push(`Step ${n + 1} is not a token account for you and this pool.`);
      else created.add(expected.ata);
      return;
    }
    // The claim itself.
    if (program(ix) === METEORA_PROGRAM_ID) {
      claims += 1;
      const want: [number, string][] = [
        [0, METEORA_POOL_AUTHORITY],
        [1, t.pool],
        [2, t.position],
        [3, mine.a],
        [4, mine.b],
        [5, t.a.vault],
        [6, t.b.vault],
        [7, t.a.mint],
        [8, t.b.mint],
        [9, t.positionNftAccount],
        [10, owner],
        [11, t.a.program],
        [12, t.b.program],
        [13, eventAuthority(web3)],
        [14, METEORA_PROGRAM_ID],
      ];
      if (ix.keys.length !== 15 || d.length !== 8 || !bytesEqual(d, CLAIM_DISCRIMINATOR)) blockers.push('The claim step is not the expected one.');
      else for (const [i, address] of want) if (key(ix, i) !== address) blockers.push('The claim step uses an account other than the ones shown, so the fees could go somewhere else.');
      return;
    }
    // Closing the owner's wrapped-SOL account, so the SOL arrives as plain SOL: the destination must be the owner.
    if (program(ix) === TOKEN_PROGRAM_ID) {
      const nativeAtas = [t.a, t.b].filter((s) => s.mint === NATIVE_MINT).map((s) => ataAddress(web3, owner, s.mint, s.program));
      const ok = d.length === 1 && d[0] === CLOSE_ACCOUNT && ix.keys.length === 3 && nativeAtas.includes(key(ix, 0)) && key(ix, 1) === owner && key(ix, 2) === owner && !closed.has(key(ix, 0));
      if (!ok) blockers.push(`Step ${n + 1} would close an account that is not your wrapped-SOL account, or send its contents elsewhere.`);
      else closed.add(key(ix, 0));
      return;
    }
    blockers.push(`An instruction this page did not expect (${program(ix) === TOKEN_2022_PROGRAM_ID ? 'a token instruction' : 'another program'}).`);
  });
  if (claims !== 1) blockers.push('The transaction does not contain exactly one claim.');
  return blockers;
}
