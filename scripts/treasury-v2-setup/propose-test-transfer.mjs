#!/usr/bin/env node
/**
 * Aretia — ACT v2 Treasury: Real Test Transaction
 * ------------------------------------------------------------------
 * Manual-run tool. It does NOT execute anything on its own, and it never
 * touches the live v1 treasury or v1 mint in any way.
 *
 * Why this exists: a multisig that has only ever been configured, never
 * actually exercised, is a weaker guarantee than one that has been proven
 * end-to-end with a real signed transaction -- this is the same standard
 * v1's treasury was held to (see TREASURY.md, "Verification -- complete").
 * The v2 multisig was created correctly (verified independently on-chain,
 * not just trusted from the Squads UI -- see TREASURY_V2.md), but has not
 * yet been exercised.
 *
 * What it does:
 *   Builds ONE trivial instruction -- a small SOL transfer from the v2
 *   vault back to the founder's own wallet (same ownership, no external
 *   destination, minimal value at risk) -- wraps it in a Squads vault
 *   transaction + proposal, and submits the proposal. It does NOT approve
 *   or execute it. A real 2-of-3 approval, done by two humans independently
 *   in the Squads UI, is still required afterward -- that human step is
 *   the actual point of this test, not something this script should ever
 *   shortcut.
 *
 * Safety model:
 *   - Runs in --dry-run mode by default (prints what would be proposed).
 *   - Pass --execute (with PROPOSER_KEYPAIR_PATH set) to actually submit
 *     the proposal-creation transaction.
 *   - Transfer amount is deliberately tiny (see TEST_AMOUNT_LAMPORTS) and
 *     the destination is the founder's own wallet -- nothing leaves the
 *     signers' own control at any point.
 *
 * Usage:
 *   npm install
 *   node propose-test-transfer.mjs                          # dry run (default)
 *   PROPOSER_KEYPAIR_PATH=/path/to/founder.json \
 *     node propose-test-transfer.mjs --execute               # submits the proposal
 *
 * PROPOSER_KEYPAIR_PATH must point to a Solana CLI-style JSON keypair file
 * for a wallet that is a member of the v2 multisig (e.g. the founder's own
 * keypair). That key only signs the "create this proposal" transaction --
 * it cannot approve or execute anything by itself, with or without this
 * script; two independent signers must still approve in the Squads UI.
 */

import fs from "node:fs";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";

// ---- Verified constants (see TREASURY_V2.md for how each was confirmed independently on-chain) ----
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "https://solana-rpc.publicnode.com";
const V2_MULTISIG_PDA = new PublicKey("5yxBrrC3h1PncGayMtAuWtvTx7MSUy2DJfdrnQ72FJGr");
const V2_VAULT = new PublicKey("GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA"); // vault index 0
const FOUNDER = new PublicKey("4DoV9FEZfTokhhPQvZNCFQCom5KUrrcTbdtX3ctWhjdG");
const VAULT_INDEX = 0;
const TEST_AMOUNT_LAMPORTS = 100_000; // 0.0001 SOL -- roughly a cent, leaves the vault's 0.001 SOL comfortably intact

const EXECUTE = process.argv.includes("--execute");

function log(...args) {
  console.log(...args);
}

async function main() {
  const connection = new Connection(RPC_ENDPOINT, "confirmed");

  const vaultBalance = await connection.getBalance(V2_VAULT);
  log(`v2 vault balance: ${vaultBalance} lamports (${(vaultBalance / 1e9).toFixed(6)} SOL)`);
  if (vaultBalance < TEST_AMOUNT_LAMPORTS) {
    throw new Error(`Vault balance (${vaultBalance} lamports) is less than the test amount (${TEST_AMOUNT_LAMPORTS} lamports).`);
  }

  const ixTransfer = SystemProgram.transfer({
    fromPubkey: V2_VAULT,
    toPubkey: FOUNDER,
    lamports: TEST_AMOUNT_LAMPORTS,
  });

  if (!EXECUTE) {
    log("\nDry run complete - no transaction was sent. Instruction that WOULD be proposed:");
    log(`  Transfer ${TEST_AMOUNT_LAMPORTS} lamports (${(TEST_AMOUNT_LAMPORTS / 1e9).toFixed(6)} SOL) from ${V2_VAULT.toBase58()} (v2 vault) to ${FOUNDER.toBase58()} (founder's own wallet).`);
    log("\nThis only tests that the multisig's propose -> approve -> execute cycle works end to end.");
    log("It does not move funds anywhere outside the signers' own control.");
    log("\nRe-run with --execute (and PROPOSER_KEYPAIR_PATH set) once this looks right.");
    return;
  }

  const keypairPath = process.env.PROPOSER_KEYPAIR_PATH;
  if (!keypairPath) {
    throw new Error("Set PROPOSER_KEYPAIR_PATH to a Solana CLI-style JSON keypair file for a v2 multisig member.");
  }
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  const proposer = Keypair.fromSecretKey(Uint8Array.from(secret));
  log(`Proposer: ${proposer.publicKey.toBase58()}`);

  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(connection, V2_MULTISIG_PDA);
  const nextTransactionIndex = BigInt(multisigAccount.transactionIndex) + 1n;
  log(`Next Squads transaction index: ${nextTransactionIndex}`);

  const { blockhash } = await connection.getLatestBlockhash();
  const innerMessage = new TransactionMessage({
    payerKey: V2_VAULT,
    recentBlockhash: blockhash,
    instructions: [ixTransfer],
  });

  const vaultTxIx = multisig.instructions.vaultTransactionCreate({
    multisigPda: V2_MULTISIG_PDA,
    transactionIndex: nextTransactionIndex,
    creator: proposer.publicKey,
    vaultIndex: VAULT_INDEX,
    ephemeralSigners: 0,
    transactionMessage: innerMessage,
    memo: "v2 multisig real-transaction test: trivial SOL transfer, vault -> founder",
  });

  const proposalIx = multisig.instructions.proposalCreate({
    multisigPda: V2_MULTISIG_PDA,
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
  log(`Review and approve in Squads (needs 2 of 3 independent signers): https://app.squads.so/squads/${V2_VAULT.toBase58()}/transactions`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
