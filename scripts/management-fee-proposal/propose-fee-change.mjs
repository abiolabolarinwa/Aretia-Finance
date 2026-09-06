#!/usr/bin/env node
/**
 * Aretia — Transfer-Fee Rate Change Proposal
 * ------------------------------------------------------------------
 * Manual-run tool. It does NOT execute anything on its own.
 *
 * Background: the ACT mint's transfer_fee_config_authority is the treasury
 * Squads multisig itself (verified in check-fee-authority.mjs, documented
 * in MINT.md), so a rate change requires the same 2-of-3 approval as any
 * other treasury action — no single key, including the founder's, can do
 * this alone.
 *
 * What it does:
 *   1. Reads the mint's LIVE transfer-fee config (never hardcodes it).
 *   2. Builds ONE SetTransferFee instruction moving the rate from whatever
 *      it currently is to NEW_BPS below (350 = 3.5%, per TOKENOMICS.md
 *      SS01's 6 Sept 2026 update: burn removed, management raised to 0.5%).
 *      maximumFee is left exactly as it currently is on-chain -- this
 *      script only ever changes the percentage, never the cap.
 *   3. Wraps it in a Squads vault transaction and drafts it as a PROPOSAL.
 *   4. Prints a link. A real signer still has to open Squads and approve +
 *      execute it. This script never gains, and never needs, fund-moving
 *      or fee-changing authority itself -- it only needs a multisig
 *      MEMBER's key to submit the proposal (proposing costs a small SOL
 *      rent/fee; it grants no control over the mint or the treasury).
 *
 * What actually happens on-chain once approved and executed:
 *   Token-2022 will NOT apply the new rate immediately or retroactively.
 *   SetTransferFee schedules the new basis-points value to take effect
 *   starting from a future epoch -- the current rate keeps applying to
 *   any transfer that happens before that epoch boundary is reached.
 *   This script prints the exact epoch numbers it reads from the mint
 *   after execution; verify them yourself rather than trusting a
 *   remembered rule of thumb, including mine.
 *
 * After it lands on-chain, update MINT.md's "live" row and remove the
 * "not yet executed" framing there and in TOKENOMICS.md/PROTOCOL.md --
 * website/verify.html needs no code change, it already checks live state
 * and will simply stop reporting a mismatch.
 *
 * Safety model:
 *   - Runs in --dry-run mode by default. Pass --execute to actually submit
 *     the proposal-creation transaction on-chain.
 *   - Refuses to build anything if the live rate already equals NEW_BPS.
 *
 * Usage:
 *   npm install
 *   node propose-fee-change.mjs                          # dry run (default)
 *   PROPOSER_KEYPAIR_PATH=/path/to/founder.json \
 *     node propose-fee-change.mjs --execute               # submits the proposal
 *
 * PROPOSER_KEYPAIR_PATH must point to a Solana CLI-style JSON keypair file
 * for a wallet that is already a member of the Aretia Treasury multisig
 * (e.g. the founder's own keypair, 4DoV9FEZfTokhhPQvZNCFQCom5KUrrcTbdtX3ctWhjdG).
 * That key only ever signs the "create this proposal" transaction -- it can
 * never change the fee or move funds by itself, with or without this script.
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
  createSetTransferFeeInstruction,
} from "@solana/spl-token";
import * as multisig from "@sqds/multisig";

// ---- Verified constants (see MINT.md and check-fee-authority.mjs for how each was confirmed) ----
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "https://solana-rpc.publicnode.com";
const ACT_MINT = new PublicKey("BmaBEY6NDbLevUcU59Fgie8JHeqD4UjEFJda8LuSS2yT");
const TREASURY_VAULT = new PublicKey("3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg"); // vault index 0; also the transfer_fee_config_authority
const MULTISIG_PDA = new PublicKey("AF8qvhgkZJJE6ascFN4MAwWSEGKpyi6oW6Ht9CySgkmX"); // verified: derives vault index 0 == TREASURY_VAULT above
const VAULT_INDEX = 0;

// The target rate. Change this constant (and re-read the header comment's
// cross-references) if the intended design changes again -- don't just
// pass a number on the command line, this value needs to match what's
// documented in TOKENOMICS.md/WHITEPAPER.md or the docs and the mint will
// disagree with each other.
const NEW_BPS = 350; // 3.5%, per TOKENOMICS.md SS01, 6 Sept 2026

const EXECUTE = process.argv.includes("--execute");

function log(...args) {
  console.log(...args);
}

async function main() {
  log(EXECUTE ? "=== EXECUTE MODE — this will submit a real on-chain proposal-creation transaction ===" : "=== DRY RUN (default; pass --execute to actually submit) ===");

  const connection = new Connection(RPC_ENDPOINT, "confirmed");

  // 1) Read live fee config from the mint - never hardcode the current bps/maximumFee.
  const mintAccount = await getMint(connection, ACT_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeConfig = getTransferFeeConfig(mintAccount);
  if (!feeConfig) throw new Error("ACT mint has no TransferFeeConfig extension - unexpected, stopping.");

  const configAuthority = feeConfig.transferFeeConfigAuthority;
  if (!configAuthority || configAuthority.toBase58() !== TREASURY_VAULT.toBase58()) {
    throw new Error(
      `transfer_fee_config_authority is ${configAuthority ? configAuthority.toBase58() : "None"}, ` +
      `not the treasury vault (${TREASURY_VAULT.toBase58()}) this script assumes. Stopping - do not proceed ` +
      `without re-checking MINT.md and check-fee-authority.mjs first.`
    );
  }

  const epochInfo = await connection.getEpochInfo();
  const currentEpoch = BigInt(epochInfo.epoch);
  const activeFee =
    currentEpoch >= feeConfig.newerTransferFee.epoch
      ? feeConfig.newerTransferFee
      : feeConfig.olderTransferFee;
  const liveBps = activeFee.transferFeeBasisPoints;
  const maximumFee = activeFee.maximumFee; // left untouched - this script only ever changes the percentage

  log(`Current epoch: ${currentEpoch}`);
  log(`Live transfer fee: ${liveBps} bps (${(liveBps / 100).toFixed(2)}%), max fee ${maximumFee} raw units (unchanged by this proposal)`);
  log(`Target: ${NEW_BPS} bps (${(NEW_BPS / 100).toFixed(2)}%)`);

  if (liveBps === NEW_BPS) {
    log("\nLive rate already equals the target - nothing to propose. Exiting.");
    return;
  }

  // 2) Build the instruction. Authority = TREASURY_VAULT, signed via Squads CPI at execution time,
  //    exactly like withdraw-withheld-authority actions in propose-harvest.mjs.
  const ixSetFee = createSetTransferFeeInstruction(
    ACT_MINT,
    TREASURY_VAULT,
    [],
    NEW_BPS,
    maximumFee,
    TOKEN_2022_PROGRAM_ID
  );

  if (!EXECUTE) {
    log("\nDry run complete - no transaction was sent. Instruction that WOULD be proposed:");
    log(`  program=${ixSetFee.programId.toBase58()} keys=${ixSetFee.keys.length} dataLen=${ixSetFee.data.length}`);
    log(`\nThis would change the mint's transfer fee from ${liveBps} bps to ${NEW_BPS} bps.`);
    log("Token-2022 will schedule this for a FUTURE epoch, not the current one - it will not apply");
    log("retroactively or to transfers that happen before that epoch boundary. The exact epoch it takes");
    log("effect at is only known once this is actually submitted on-chain - re-run with --execute and read");
    log("the confirmed transaction / the mint's updated newerTransferFee.epoch field, don't assume a number.");
    log("\nRe-run with --execute (and PROPOSER_KEYPAIR_PATH set) once this looks right.");
    return;
  }

  // 3) EXECUTE: load the proposer key, fetch the current transaction index, submit.
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
    instructions: [ixSetFee],
  });

  const vaultTxIx = multisig.instructions.vaultTransactionCreate({
    multisigPda: MULTISIG_PDA,
    transactionIndex: nextTransactionIndex,
    creator: proposer.publicKey,
    vaultIndex: VAULT_INDEX,
    ephemeralSigners: 0,
    transactionMessage: innerMessage,
    memo: `Transfer fee change: ${liveBps} bps -> ${NEW_BPS} bps`,
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
