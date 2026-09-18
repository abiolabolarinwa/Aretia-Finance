#!/usr/bin/env node
/**
 * PRESALE_DESIGN.md open item -- refund_sol's success path, specifically.
 * ---------------------------------------------------------------------
 * exercise-devnet-buy-with-sol.mjs proved buy_with_sol works against a
 * real live Pyth price update, but that presale instance's soft cap was
 * deliberately set low ($1) so the buy immediately qualified for
 * finalize's happy path -- refund_sol was never actually exercised.
 *
 * This targets a THIRD, throwaway program deployment
 * (6zWExLaMGuB2ywg6VickQnML2rb2ViSXbmyfdkbH9WKV -- same act-presale
 * source with SOL support, deployed under its own program ID so its
 * PDAs are independent), deliberately set up to MISS its soft cap after
 * a SOL contribution: buy_with_sol with a real live Pyth price update,
 * wait for the (short) sale window to close, finalize -> Refunding,
 * then refund_sol -- confirming it returns exactly the lamports paid,
 * and that a second refund_sol call is correctly rejected.
 *
 * Run: PYTH_API_KEY=<key> node scripts/exercise-devnet-refund-sol.mjs
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

const PROGRAM_ID = new PublicKey("6zWExLaMGuB2ywg6VickQnML2rb2ViSXbmyfdkbH9WKV");
const RPC_URL = "https://api.devnet.solana.com";
const DEPLOYER_KEYPAIR_PATH =
  "C:/Users/USER PC/OneDrive - Furst Peak Solutions/My Stuff/Folders/2026/Aretia Climate App/aretia-finance/devnet/deployer-keypair.json";
const SOL_USD_FEED_ID_HEX = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const REAL_TREASURY_VAULT = new PublicKey("GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA");

function loadKeypair(p) {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
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
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function send(connection, payer, ix, label) {
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  console.log(`${label}: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  return sig;
}

async function main() {
  const pythApiKey = process.env.PYTH_API_KEY;
  if (!pythApiKey) throw new Error("Set PYTH_API_KEY.");

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

  let windowEndTs;
  const existing = await connection.getAccountInfo(configPda);
  if (existing) {
    console.log("Config already exists -- reading end_ts.");
    // PresaleConfig: disc(8) + authority(32) + act_mint(32) + accepted_mints[2](64)
    // + accepted_vaults[2](64) + treasury_payment_accounts[2](64) + act_vault(32)
    // + treasury_act_account(32) + treasury_sol_account(32) + price(8) + start_ts(8)
    // = 376 -- end_ts starts there.
    windowEndTs = Number(existing.data.readBigInt64LE(376));
  } else {
    const now = Math.floor(Date.now() / 1000);
    windowEndTs = now + 30; // short window -- deliberately missed after one small buy
    const initData = Buffer.concat([
      discriminator("initialize_presale"),
      u64le(10_000), // $0.01/ACT
      i64le(now - 60),
      i64le(windowEndTs),
      u64le(1_000_000_000_000), // hard cap $1,000,000 -- won't be hit by a small SOL buy
      u64le(500_000_000_000), // soft cap $500,000 -- will be missed
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
      { pubkey: REAL_TREASURY_VAULT, isSigner: false, isWritable: false },
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

  const checks = [];
  function check(label, passed) {
    checks.push([label, passed]);
    console.log(`  ${passed ? "PASS" : "FAIL"} - ${label}`);
  }

  const buyerAccountInfoBefore = await connection.getAccountInfo(buyerAccountPda);
  const lamports = 20_000_000n; // 0.02 SOL -- well under the $500k soft cap regardless of price

  if (!buyerAccountInfoBefore) {
    console.log("\nFetching a live SOL/USD price update from Hermes...");
    const hermes = new HermesClient("https://hermes.pyth.network", { accessToken: pythApiKey });
    const priceUpdates = await hermes.getLatestPriceUpdates([SOL_USD_FEED_ID_HEX], { encoding: "base64" });
    const parsed = priceUpdates.parsed && priceUpdates.parsed[0];
    if (parsed) {
      const price = Number(parsed.price.price) * 10 ** parsed.price.expo;
      console.log(`Live SOL/USD price: $${price.toFixed(2)}`);
    }

    const wallet = new Wallet(payer);
    const pythSolanaReceiver = new PythSolanaReceiver({ connection, wallet });
    const transactionBuilder = pythSolanaReceiver.newTransactionBuilder({ closeUpdateAccounts: false });
    await transactionBuilder.addPostPriceUpdates(priceUpdates.binary.data);

    await transactionBuilder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
      const priceUpdateAccount = getPriceUpdateAccount(SOL_USD_FEED_ID_HEX);
      const buyData = Buffer.concat([discriminator("buy_with_sol"), u64le(lamports)]);
      const buyKeys = [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: true },
        { pubkey: buyerAccountPda, isSigner: false, isWritable: true },
        { pubkey: vaultAuthorityPda, isSigner: false, isWritable: true },
        { pubkey: priceUpdateAccount, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      return [{ instruction: new TransactionInstruction({ programId: PROGRAM_ID, keys: buyKeys, data: buyData }), signers: [] }];
    });

    const versionedTxs = await transactionBuilder.buildVersionedTransactions({
      computeUnitPriceMicroLamports: 100_000,
      tightComputeBudget: false,
    });
    console.log(`\nSending ${versionedTxs.length} transaction(s) (post price update + buy_with_sol)...`);
    const sigs = await pythSolanaReceiver.provider.sendAll(versionedTxs, { skipPreflight: false });
    for (const sig of sigs) console.log(`  https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    await connection.confirmTransaction(sigs[sigs.length - 1], "confirmed");
  } else {
    console.log("\nbuyer_account already exists -- skipping buy_with_sol.");
  }

  // Continuing from end_ts(376): +end_ts(8)=384, +tge_ts(8)=392, +tge_bps(2)=394,
  // +vesting_duration_seconds(8)=402, +hard_cap(8)=410, +soft_cap(8)=418,
  // +min_buy(8)=426, +max_buy(8)=434, +total_raised(8)=442,
  // +total_act_sold_net(8)=450, +total_act_claimed_net(8)=458,
  // +act_reserve_net(8)=466 -- status starts there.
  const statusOffset = 466;
  let configInfo = await connection.getAccountInfo(configPda);
  let status = configInfo.data.readUInt8(statusOffset);

  if (status === 0 /* Active */) {
    const waitMs = Math.max(0, windowEndTs - Math.floor(Date.now() / 1000)) * 1000 + 3000;
    console.log(`\nWaiting ${Math.ceil(waitMs / 1000)}s for the sale window to end...`);
    await sleep(waitMs);

    const finalizeData = discriminator("finalize");
    const finalizeKeys = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: vaultAuthorityPda, isSigner: false, isWritable: true },
      { pubkey: REAL_TREASURY_VAULT, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: testUsdcMint, isSigner: false, isWritable: false },
      { pubkey: testUsdtMint, isSigner: false, isWritable: false },
      { pubkey: usdcVaultAta, isSigner: false, isWritable: true },
      { pubkey: usdtVaultAta, isSigner: false, isWritable: true },
      { pubkey: treasuryUsdcAta, isSigner: false, isWritable: true },
      { pubkey: treasuryUsdtAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    await send(connection, payer, new TransactionInstruction({ programId: PROGRAM_ID, keys: finalizeKeys, data: finalizeData }), "finalize (expect Refunding)");
    configInfo = await connection.getAccountInfo(configPda);
    status = configInfo.data.readUInt8(statusOffset);
  }

  check("config status is Refunding (2)", status === 2);

  const buyerAccountInfo = await connection.getAccountInfo(buyerAccountPda);
  let o = 8 + 32 + 16 + 8 + 8 + 2;
  const solLamportsContributed = buyerAccountInfo.data.readBigUInt64LE(o);

  const balanceBefore = await connection.getBalance(payer.publicKey);
  const refundSolData = discriminator("refund_sol");
  const refundSolKeys = [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: configPda, isSigner: false, isWritable: false },
    { pubkey: buyerAccountPda, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: false, isWritable: false }, // owner
    { pubkey: vaultAuthorityPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  const refundSig = await send(connection, payer, new TransactionInstruction({ programId: PROGRAM_ID, keys: refundSolKeys, data: refundSolData }), "refund_sol");
  const feePaid = (await connection.getTransaction(refundSig, { maxSupportedTransactionVersion: 0 })).meta.fee;
  const balanceAfter = await connection.getBalance(payer.publicKey);
  const received = BigInt(balanceAfter - balanceBefore) + BigInt(feePaid);

  console.log("\nsol_lamports_contributed (expected refund):", solLamportsContributed.toString());
  console.log("Actual lamports received back (net of this tx's own fee):", received.toString());
  check("refund_sol returned exactly what was contributed", received === solLamportsContributed);

  try {
    await send(connection, payer, new TransactionInstruction({ programId: PROGRAM_ID, keys: refundSolKeys, data: refundSolData }), "refund_sol again (expect AlreadyRefunded)");
    check("second refund_sol call correctly rejected", false);
  } catch (err) {
    const msg = err?.message ?? String(err);
    const rejected = msg.includes("AlreadyRefunded");
    check("second refund_sol call correctly rejected (AlreadyRefunded)", rejected);
    if (!rejected) console.log("  unexpected error:", msg);
  }

  const failed = checks.filter(([, p]) => !p);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) {
    console.error("At least one check failed.");
    process.exit(1);
  }
  console.log("\nAll checks passed. refund_sol's success path works as designed on devnet.");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
