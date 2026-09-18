#!/usr/bin/env node
/**
 * PRESALE_DESIGN.md open item #3 -- SOL payment support.
 * ---------------------------------------------------------------------
 * Exercises `buy_with_sol` for real on a throwaway devnet deployment
 * (7N3YGkjbJBX9NyjQLdTV2JuDUBnAuUCcw6cDuRuJWN2k -- same act-presale
 * source with SOL support added, deployed under its own program ID
 * purely so its PDAs are independent of the primary deployment).
 *
 * Posts a real, live Pyth SOL/USD price update (fetched from Hermes,
 * Pyth's own price service) on-chain via the pull-oracle flow, then
 * calls buy_with_sol in the SAME transaction, consuming that price
 * update -- exactly the intended usage pattern, not a mocked price.
 *
 * Caps are set deliberately wide ($1 min, $1000 max/hard cap, $1 soft
 * cap) so this test doesn't need to know the exact current SOL/USD
 * price in advance: sending 0.05 SOL is comfortably within that range
 * at any plausible price.
 *
 * NOTE: @pythnetwork/pyth-solana-receiver's dependency chain has a
 * couple of real packaging bugs under Node's strict ESM resolver
 * (extensionless imports in jito-ts via @pythnetwork/solana-utils, a
 * bare directory import in its nested @coral-xyz/anchor copy). Both
 * were patched directly in node_modules (not in this repo's own code)
 * to get this running -- see the two `patch_*.log`-style notes this
 * script prints if it has to explain why, and PRESALE_DESIGN.md's open
 * item #3 for the exact files touched.
 *
 * Run: node scripts/exercise-devnet-buy-with-sol.mjs
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Wallet } from "@coral-xyz/anchor";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { HermesClient } from "@pythnetwork/hermes-client";
import fs from "node:fs";
import crypto from "node:crypto";

const PROGRAM_ID = new PublicKey("7N3YGkjbJBX9NyjQLdTV2JuDUBnAuUCcw6cDuRuJWN2k");
const RPC_URL = "https://api.devnet.solana.com";
const DEPLOYER_KEYPAIR_PATH =
  "C:/Users/USER PC/OneDrive - Furst Peak Solutions/My Stuff/Folders/2026/Aretia Climate App/aretia-finance/devnet/deployer-keypair.json";
const SOL_USD_FEED_ID_HEX = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const REAL_TREASURY_VAULT = new PublicKey("GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA");

function loadKeypair(path) {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}
function discriminator(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
function u8le(n) { return Buffer.from([n]); }
function u16le(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function u64le(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function i64le(n) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; }

async function send(connection, payer, ix, label) {
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  console.log(`${label}: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  return sig;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadKeypair(DEPLOYER_KEYPAIR_PATH);
  console.log("Deployer/authority/buyer:", payer.publicKey.toBase58());

  const tokens = JSON.parse(
    fs.readFileSync(new URL("./devnet-test-tokens.json", import.meta.url), "utf8")
  );
  const testActMint = new PublicKey(tokens.testActMint);
  const testUsdcMint = new PublicKey(tokens.testUsdcMint);
  const testUsdtMint = new PublicKey(tokens.testUsdtMint);
  const treasuryActAta = new PublicKey(tokens.treasuryActAta);
  const treasuryUsdcAta = new PublicKey(tokens.treasuryUsdcAta);
  const treasuryUsdtAta = new PublicKey(tokens.treasuryUsdtAta);
  const deployerActAta = new PublicKey(tokens.deployerActAta);

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("presale_config")], PROGRAM_ID);
  const [vaultAuthorityPda] = PublicKey.findProgramAddressSync([Buffer.from("vault_authority")], PROGRAM_ID);
  const [buyerAccountPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("presale_buyer"), payer.publicKey.toBuffer()],
    PROGRAM_ID
  );
  const actVaultAta = getAssociatedTokenAddressSync(testActMint, vaultAuthorityPda, true, TOKEN_2022_PROGRAM_ID);
  const usdcVaultAta = getAssociatedTokenAddressSync(testUsdcMint, vaultAuthorityPda, true);
  const usdtVaultAta = getAssociatedTokenAddressSync(testUsdtMint, vaultAuthorityPda, true);

  console.log("Config PDA:", configPda.toBase58());
  console.log("Vault authority PDA (also the native-SOL escrow):", vaultAuthorityPda.toBase58());

  const existing = await connection.getAccountInfo(configPda);
  if (existing) {
    console.log("Config already initialized -- skipping setup.");
  } else {
    const now = Math.floor(Date.now() / 1000);
    const initData = Buffer.concat([
      discriminator("initialize_presale"),
      u64le(10_000), // $0.01/ACT
      i64le(now - 60),
      i64le(now + 3600),
      u64le(1_000_000_000), // hard cap $1000 -- deliberately wide, see file header
      u64le(1_000_000), // soft cap $1 -- any nonzero buy meets it
      u64le(1_000_000), // min buy $1
      u64le(1_000_000_000), // max buy $1000
      u16le(2500),
      u32le(1),
    ]);
    const initKeys = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: vaultAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: testActMint, isSigner: false, isWritable: false },
      { pubkey: actVaultAta, isSigner: false, isWritable: true },
      { pubkey: treasuryActAta, isSigner: false, isWritable: false },
      { pubkey: REAL_TREASURY_VAULT, isSigner: false, isWritable: false }, // treasury_sol_account
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    await send(connection, payer, new TransactionInstruction({ programId: PROGRAM_ID, keys: initKeys, data: initData }), "initialize_presale");

    for (const [idx, mint, vault, treasury] of [
      [0, testUsdcMint, usdcVaultAta, treasuryUsdcAta],
      [1, testUsdtMint, usdtVaultAta, treasuryUsdtAta],
    ]) {
      const data = Buffer.concat([discriminator("initialize_payment_currency"), u8le(idx)]);
      const keys = [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: true },
        { pubkey: vaultAuthorityPda, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: treasury, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      await send(connection, payer, new TransactionInstruction({ programId: PROGRAM_ID, keys, data }), `initialize_payment_currency(${idx})`);
    }

    const fundAmount = 500n * 10n ** 9n;
    const fundData = Buffer.concat([discriminator("fund_act_reserve"), u64le(fundAmount)]);
    const fundKeys = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: testActMint, isSigner: false, isWritable: false },
      { pubkey: actVaultAta, isSigner: false, isWritable: true },
      { pubkey: deployerActAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    await send(connection, payer, new TransactionInstruction({ programId: PROGRAM_ID, keys: fundKeys, data: fundData }), "fund_act_reserve");
  }

  // ---- Post a real Pyth SOL/USD price update, then buy_with_sol in the
  //      same atomic sequence -- the intended pull-oracle usage pattern. --
  console.log("\nFetching a live SOL/USD price update from Hermes...");
  const pythApiKey = process.env.PYTH_API_KEY;
  if (!pythApiKey) {
    throw new Error(
      "Set PYTH_API_KEY (Hermes now requires an API key as of 26 Aug 2026 -- see https://docs.pyth.network for how to obtain one)."
    );
  }
  const hermes = new HermesClient("https://hermes.pyth.network", {
    accessToken: pythApiKey,
  });
  const priceUpdates = await hermes.getLatestPriceUpdates([SOL_USD_FEED_ID_HEX], { encoding: "base64" });
  const parsed = priceUpdates.parsed && priceUpdates.parsed[0];
  if (parsed) {
    const price = Number(parsed.price.price) * 10 ** parsed.price.expo;
    console.log(`Live SOL/USD price: $${price.toFixed(2)} (publish_time ${parsed.price.publish_time})`);
  }

  const wallet = new Wallet(payer);
  const pythSolanaReceiver = new PythSolanaReceiver({ connection, wallet });
  const transactionBuilder = pythSolanaReceiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await transactionBuilder.addPostPriceUpdates(priceUpdates.binary.data);

  const lamports = 50_000_000n; // 0.05 SOL

  await transactionBuilder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
    const priceUpdateAccount = getPriceUpdateAccount(SOL_USD_FEED_ID_HEX);
    console.log("Price update account posted at:", priceUpdateAccount.toBase58());

    const buyData = Buffer.concat([discriminator("buy_with_sol"), u64le(lamports)]);
    const buyKeys = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: buyerAccountPda, isSigner: false, isWritable: true },
      { pubkey: vaultAuthorityPda, isSigner: false, isWritable: true },
      { pubkey: priceUpdateAccount, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    return [
      {
        instruction: new TransactionInstruction({ programId: PROGRAM_ID, keys: buyKeys, data: buyData }),
        signers: [],
      },
    ];
  });

  const vaultBalanceBefore = await connection.getBalance(vaultAuthorityPda);
  console.log("\nvault_authority SOL balance before buy_with_sol:", vaultBalanceBefore);

  const versionedTxs = await transactionBuilder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: 100_000,
    tightComputeBudget: false,
  });
  console.log(`\nSending ${versionedTxs.length} transaction(s) (post price update + buy_with_sol)...`);
  const sigs = await pythSolanaReceiver.provider.sendAll(versionedTxs, { skipPreflight: false });
  for (const sig of sigs) {
    console.log(`  https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  }
  await connection.confirmTransaction(sigs[sigs.length - 1], "confirmed");

  const vaultBalanceAfter = await connection.getBalance(vaultAuthorityPda);
  console.log("vault_authority SOL balance after buy_with_sol:", vaultBalanceAfter);

  const checks = [];
  function check(label, passed) {
    checks.push([label, passed]);
    console.log(`  ${passed ? "PASS" : "FAIL"} - ${label}`);
  }
  check(
    "vault_authority received exactly 0.05 SOL",
    BigInt(vaultBalanceAfter - vaultBalanceBefore) === lamports
  );

  const buyerInfo = await connection.getAccountInfo(buyerAccountPda);
  // BuyerAccount: disc(8) + owner(32) + payment_contributed[2](16) +
  // act_allocated_net(8) + act_claimed_net(8) + refunded[2](2) +
  // sol_lamports_contributed(8) + sol_usd_value_contributed(8)
  let o = 8 + 32 + 16 + 8 + 8 + 2;
  const solLamportsContributed = buyerInfo.data.readBigUInt64LE(o); o += 8;
  const solUsdValueContributed = buyerInfo.data.readBigUInt64LE(o); o += 8;
  console.log("\nBuyerAccount.sol_lamports_contributed:", solLamportsContributed.toString());
  console.log("BuyerAccount.sol_usd_value_contributed (6dp USD):", solUsdValueContributed.toString());
  check("sol_lamports_contributed == 0.05 SOL", solLamportsContributed === lamports);
  check("sol_usd_value_contributed > 0 (oracle conversion worked)", solUsdValueContributed > 0n);
  check(
    "sol_usd_value_contributed is a plausible SOL price (between $1 and $1000 for 0.05 SOL)",
    solUsdValueContributed >= 1_000_000n && solUsdValueContributed <= 1_000_000_000n
  );

  const failed = checks.filter(([, p]) => !p);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) {
    console.error("At least one check failed.");
    process.exit(1);
  }
  console.log("\nAll checks passed. buy_with_sol works end to end against a real live Pyth price update on devnet.");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
