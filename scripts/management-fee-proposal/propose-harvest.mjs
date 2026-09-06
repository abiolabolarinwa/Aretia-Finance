#!/usr/bin/env node
/**
 * Aretia — Management Fee Harvest Proposal
 * ------------------------------------------------------------------
 * Manual-run tool. It does NOT execute anything on its own.
 *
 * What it does:
 *   1. Scans every ACT (Token-2022) token account for withheld transfer fees.
 *   2. If there's anything to harvest, computes the 0.5%-of-3.5% management-fee
 *      share (grossed up so the NET amount landing in the management wallet
 *      matches the intended share, after that internal transfer's own fee).
 *      NOTE (6 Sept 2026): this reflects the current intended design (burn
 *      removed, management raised from 0.1%) - the live on-chain rate is
 *      still 4.1% with the old split as of this writing. See MINT.md.
 *   3. Builds ONE Squads vault transaction containing:
 *        - create the management wallet's ACT token account (idempotent)
 *        - WithdrawWithheldTokensFromAccounts -> treasury vault's ACT account
 *        - TransferChecked: management share, treasury vault -> management wallet
 *      ...and drafts it as a Squads PROPOSAL.
 *   4. Prints a link. A real signer still has to open Squads and approve +
 *      execute it — this script never gains, and never needs, fund-moving
 *      authority. It only needs a multisig MEMBER's key to submit the proposal
 *      (proposing costs a small SOL rent/fee; it grants no control over funds).
 *
 * Safety model:
 *   - Runs in --dry-run mode by default. Pass --execute to actually submit
 *     the proposal-creation transaction on-chain.
 *   - Idempotent: running it when there's nothing withheld just logs that and exits.
 *   - Dry run verified against live mainnet on 3 Sept 2026: read the real
 *     transfer-fee config (410 bps, matches MINT.md), scanned every ACT
 *     Token-2022 account, found 0 withheld (expected pre-liquidity), exited
 *     cleanly. The scan/read path is confirmed correct against real chain
 *     data. --execute has still never been run - there's nothing to harvest
 *     yet. Re-run --dry-run once liquidity is live and re-check its output
 *     before ever passing --execute for the first time.
 *
 * Usage:
 *   npm install
 *   node propose-harvest.mjs                          # dry run (default)
 *   PROPOSER_KEYPAIR_PATH=/path/to/founder.json \
 *     node propose-harvest.mjs --execute               # actually submits the proposal
 *
 * PROPOSER_KEYPAIR_PATH must point to a Solana CLI-style JSON keypair file
 * for a wallet that is already a member of the Aretia Treasury multisig
 * (e.g. the founder's own keypair, 4DoV9FEZfTokhhPQvZNCFQCom5KUrrcTbdtX3ctWhjdG).
 * That key only ever signs the "create this proposal" transaction — it can
 * never move treasury or management-fee funds by itself.
 */

import fs from "node:fs";
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionMessage,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getTransferFeeConfig,
  getTransferFeeAmount,
  unpackAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createWithdrawWithheldTokensFromAccountsInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import * as multisig from "@sqds/multisig";

// ---- Verified constants (see MANAGEMENT_FEE.md and MINT.md for how each was confirmed) ----
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "https://solana-rpc.publicnode.com";
const ACT_MINT = new PublicKey("BmaBEY6NDbLevUcU59Fgie8JHeqD4UjEFJda8LuSS2yT");
const TREASURY_VAULT = new PublicKey("3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg"); // vault index 0
const MULTISIG_PDA = new PublicKey("AF8qvhgkZJJE6ascFN4MAwWSEGKpyi6oW6Ht9CySgkmX"); // verified: derives vault index 0 == TREASURY_VAULT above
const VAULT_INDEX = 0;
const MANAGEMENT_WALLET = new PublicKey("2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2");
// Management fee is 0.5% out of the mint's intended 3.5% transfer fee (burn removed,
// management raised from 0.1%, 6 Sept 2026 - see TOKENOMICS.md SS01) -> exactly 1/7
// (equivalently 5/35) of whatever gets harvested. NOTE: this ratio assumes the on-chain
// rate has actually been moved to 350 bps; as of this writing it is still live at 410 bps
// with the old 1/41 split. Re-check MINT.md's fee-authority section before running
// --execute for real, since this constant does not update itself from chain state.
const MANAGEMENT_SHARE_NUM = 1n;
const MANAGEMENT_SHARE_DEN = 7n;

const EXECUTE = process.argv.includes("--execute");

function log(...args) {
  console.log(...args);
}

/** Grosses up `netTarget` so that, after the mint's own transfer fee is withheld
 *  on the internal treasury -> management-wallet transfer, the NET amount that
 *  actually lands equals `netTarget`. Mirrors the on-chain calculateFee logic
 *  (proportional, capped at maximumFee), inverted. */
function computeGrossAmount(netTarget, bps, maximumFee) {
  if (netTarget === 0n) return 0n;
  // Try the proportional (uncapped) inverse first: sent * (1 - bps/10000) = netTarget
  const denom = 10000n - BigInt(bps);
  if (denom <= 0n) throw new Error("Transfer fee bps >= 100% - refusing to compute.");
  let sent = (netTarget * 10000n + denom - 1n) / denom; // ceil division, so net >= netTarget
  let fee = (sent * BigInt(bps) + 9999n) / 10000n;
  if (fee > maximumFee) fee = maximumFee;
  if (fee >= sent) throw new Error("Transfer fee would consume the entire amount - refusing.");
  // If fee got capped, the proportional guess undershoots; correct directly.
  if (fee === maximumFee) {
    sent = netTarget + maximumFee;
  }
  return sent;
}

async function main() {
  log(EXECUTE ? "=== EXECUTE MODE — this will submit a real on-chain proposal-creation transaction ===" : "=== DRY RUN (default; pass --execute to actually submit) ===");

  const connection = new Connection(RPC_ENDPOINT, "confirmed");

  // 1) Read live fee config from the mint - never hardcode bps/maximumFee, they can change.
  const mintAccount = await getMint(connection, ACT_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeConfig = getTransferFeeConfig(mintAccount);
  if (!feeConfig) throw new Error("ACT mint has no TransferFeeConfig extension - unexpected, stopping.");

  const epochInfo = await connection.getEpochInfo();
  const currentEpoch = BigInt(epochInfo.epoch);
  const activeFee =
    currentEpoch >= feeConfig.newerTransferFee.epoch
      ? feeConfig.newerTransferFee
      : feeConfig.olderTransferFee;
  const bps = activeFee.transferFeeBasisPoints;
  const maximumFee = activeFee.maximumFee;
  log(`Live transfer fee: ${bps} bps, max fee ${maximumFee} raw units, decimals ${mintAccount.decimals}`);

  // 2) Scan every Token-2022 account for this mint and sum withheld amounts.
  log("Scanning ACT token accounts for withheld fees (this can take a moment)...");
  const programAccounts = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: ACT_MINT.toBase58() } }],
  });

  const sources = [];
  let totalWithheld = 0n;
  for (const { pubkey, account } of programAccounts) {
    let decoded;
    try {
      decoded = unpackAccount(pubkey, account, TOKEN_2022_PROGRAM_ID);
    } catch {
      continue; // not a standard token account layout we can read - skip
    }
    const feeAmount = getTransferFeeAmount(decoded);
    if (feeAmount && feeAmount.withheldAmount > 0n) {
      sources.push(pubkey);
      totalWithheld += feeAmount.withheldAmount;
    }
  }

  log(`Found ${sources.length} account(s) with withheld fees. Total withheld: ${totalWithheld} raw units.`);

  if (totalWithheld === 0n) {
    log("Nothing to harvest yet - exiting cleanly. (Expected pre-liquidity: no trades, no fees.)");
    return;
  }

  // 3) Compute the management-fee share and gross it up for the internal transfer's own fee.
  const managementNet = (totalWithheld * MANAGEMENT_SHARE_NUM) / MANAGEMENT_SHARE_DEN;
  const managementGross = computeGrossAmount(managementNet, bps, maximumFee);
  log(`Management-fee share: intend to deliver ${managementNet} net raw units -> sending ${managementGross} raw units to cover the internal transfer fee.`);

  if (managementGross > totalWithheld) {
    throw new Error("Computed management transfer exceeds total withheld amount - something is wrong, refusing to proceed.");
  }

  // 4) Build the instructions.
  const treasuryAta = getAssociatedTokenAddressSync(ACT_MINT, TREASURY_VAULT, true, TOKEN_2022_PROGRAM_ID);
  const managementAta = getAssociatedTokenAddressSync(ACT_MINT, MANAGEMENT_WALLET, true, TOKEN_2022_PROGRAM_ID);

  const ixCreateManagementAta = createAssociatedTokenAccountIdempotentInstruction(
    TREASURY_VAULT, // payer (the vault pays its own ATA-creation rent when this executes)
    managementAta,
    MANAGEMENT_WALLET,
    ACT_MINT,
    TOKEN_2022_PROGRAM_ID
  );

  const ixWithdraw = createWithdrawWithheldTokensFromAccountsInstruction(
    ACT_MINT,
    treasuryAta,
    TREASURY_VAULT, // authority - signed via Squads CPI when the vault transaction executes
    [],
    sources,
    TOKEN_2022_PROGRAM_ID
  );

  const ixTransfer = createTransferCheckedInstruction(
    treasuryAta,
    ACT_MINT,
    managementAta,
    TREASURY_VAULT,
    managementGross,
    mintAccount.decimals,
    [],
    TOKEN_2022_PROGRAM_ID
  );

  const innerInstructions = [ixCreateManagementAta, ixWithdraw, ixTransfer];

  if (!EXECUTE) {
    log("\nDry run complete - no transaction was sent. Instructions that WOULD be proposed:");
    innerInstructions.forEach((ix, i) => {
      log(`  [${i}] program=${ix.programId.toBase58()} keys=${ix.keys.length} dataLen=${ix.data.length}`);
    });
    log(`\nSources to harvest from (${sources.length}):`);
    sources.forEach((s) => log(`  ${s.toBase58()}`));
    log("\nRe-run with --execute (and PROPOSER_KEYPAIR_PATH set) once this looks right.");
    return;
  }

  // 5) EXECUTE: load the proposer key, fetch the current transaction index, submit.
  const keypairPath = process.env.PROPOSER_KEYPAIR_PATH;
  if (!keypairPath) {
    throw new Error("Set PROPOSER_KEYPAIR_PATH to a Solana CLI-style JSON keypair file for a treasury multisig member.");
  }
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  const proposer = Keypair.fromSecretKey(Uint8Array.from(secret));
  log(`Proposer: ${proposer.publicKey.toBase58()}`);

  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(connection, MULTISIG_PDA);
  const nextTransactionIndex = BigInt(multisigAccount.transactionIndex) + 1n;
  log(`Next Squads transaction index: ${nextTransactionIndex}`);

  const { blockhash } = await connection.getLatestBlockhash();
  const innerMessage = new TransactionMessage({
    payerKey: TREASURY_VAULT,
    recentBlockhash: blockhash,
    instructions: innerInstructions,
  });

  const vaultTxIx = multisig.instructions.vaultTransactionCreate({
    multisigPda: MULTISIG_PDA,
    transactionIndex: nextTransactionIndex,
    creator: proposer.publicKey,
    vaultIndex: VAULT_INDEX,
    ephemeralSigners: 0,
    transactionMessage: innerMessage,
    memo: `Management fee harvest: ${managementNet} net raw units to ${MANAGEMENT_WALLET.toBase58()}`,
  });

  const proposalIx = multisig.instructions.proposalCreate({
    multisigPda: MULTISIG_PDA,
    creator: proposer.publicKey,
    transactionIndex: nextTransactionIndex,
    isDraft: false,
  });

  const outerTx = new Transaction({ feePayer: proposer.publicKey, recentBlockhash: blockhash }).add(
    vaultTxIx,
    proposalIx
  );

  const signature = await connection.sendTransaction(outerTx, [proposer]);
  log(`Submitted: ${signature}`);
  await connection.confirmTransaction(signature, "confirmed");
  log("Confirmed. Proposal created - it does NOT execute yet.");
  log(`Review and approve in Squads: https://app.squads.so/squads/${TREASURY_VAULT.toBase58()}/transactions`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
