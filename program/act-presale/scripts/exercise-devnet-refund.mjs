#!/usr/bin/env node
/**
 * act-presale -- refund-path devnet exercise
 * ---------------------------------------------------------------------
 * exercise-devnet-presale.mjs already proved the happy path (soft cap
 * met -> finalize sweeps to treasury -> claim). The soft-cap-missed ->
 * Refunding -> refund path can't be exercised on that same deployment:
 * `presale_config` is a PDA singleton per program (`seeds =
 * [b"presale_config"]`), so once a config is `Finalized` there's no way
 * to get a second, independent `Active` config out of the same program
 * ID. This script targets a SEPARATE, throwaway program deployment
 * (5zT4oG1qBMPjdvA6QZ16pX12eFjbH1znUtvUEdD8UCe8 -- same act_presale.so
 * binary, just deployed under a second program keypair purely so its
 * PDAs are independent) built specifically to miss its soft cap and
 * exercise `refund`.
 *
 * Reuses the same test-USDC mint and the deployer's existing test-USDC
 * ATA from setup-devnet-tokens.mjs (no new mints needed -- refund only
 * needs one payment currency to prove the mechanism). Buys $20, well
 * under a deliberately high $80 soft cap, so after the short test
 * window ends `finalize` moves the presale to `Refunding` instead of
 * sweeping anything, and `refund` should return exactly the $20.
 *
 * Run: node scripts/exercise-devnet-refund.mjs
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
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
} from "@solana/spl-token";
import fs from "node:fs";
import crypto from "node:crypto";

const PROGRAM_ID = new PublicKey("5zT4oG1qBMPjdvA6QZ16pX12eFjbH1znUtvUEdD8UCe8");
const RPC_URL = "https://api.devnet.solana.com";
const DEPLOYER_KEYPAIR_PATH =
  "C:/Users/USER PC/OneDrive - Furst Peak Solutions/My Stuff/Folders/2026/Aretia Climate App/aretia-finance/devnet/deployer-keypair.json";

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
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
  const deployerUsdcAta = new PublicKey(tokens.deployerUsdcAta);

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("presale_config")], PROGRAM_ID);
  const [vaultAuthorityPda] = PublicKey.findProgramAddressSync([Buffer.from("vault_authority")], PROGRAM_ID);
  const [buyerAccountPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("presale_buyer"), payer.publicKey.toBuffer()],
    PROGRAM_ID
  );
  const actVaultAta = getAssociatedTokenAddressSync(testActMint, vaultAuthorityPda, true, TOKEN_2022_PROGRAM_ID);
  const usdcVaultAta = getAssociatedTokenAddressSync(testUsdcMint, vaultAuthorityPda, true);
  const usdtVaultAta = getAssociatedTokenAddressSync(testUsdtMint, vaultAuthorityPda, true);
  // `Finalize` requires both currency slots to be registered (it checks
  // `address = config.accepted_mints[0..1]` unconditionally) even though
  // this test only ever buys with currency 0 -- so currency 1 (USDT) is
  // still initialized below, just never bought with. Its vault stays at
  // 0, so finalize's `if usdt_amount > 0` branch is simply a no-op for it.
  const treasuryActAta = new PublicKey(tokens.treasuryActAta);
  const treasuryUsdcAta = new PublicKey(tokens.treasuryUsdcAta);
  const treasuryUsdtAta = new PublicKey(tokens.treasuryUsdtAta);

  console.log("Program:", PROGRAM_ID.toBase58());
  console.log("Config PDA:", configPda.toBase58());

  const statusOffsetConst = 8 + 32 + 32 + 32 * 6 + 32 * 2 + 8 + 8 + 8 + 8 + 2 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8;
  const existing = await connection.getAccountInfo(configPda);
  if (existing && existing.data.readUInt8(statusOffsetConst) !== 0) {
    console.log("Config already initialized and past Active -- skipping setup.");
  } else if (existing) {
    console.log("Config already initialized and still Active (buy already happened) -- just finalizing.");
    const finalizeData = discriminator("finalize");
    const finalizeKeys = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: vaultAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: testUsdcMint, isSigner: false, isWritable: false },
      { pubkey: testUsdtMint, isSigner: false, isWritable: false },
      { pubkey: usdcVaultAta, isSigner: false, isWritable: true },
      { pubkey: usdtVaultAta, isSigner: false, isWritable: true },
      { pubkey: treasuryUsdcAta, isSigner: false, isWritable: true },
      { pubkey: treasuryUsdtAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    await send(connection, payer, new TransactionInstruction({ programId: PROGRAM_ID, keys: finalizeKeys, data: finalizeData }), "finalize (expect Refunding)");
  } else {
    const now = Math.floor(Date.now() / 1000);
    const startTs = now - 60;
    const endTs = now + 20; // short window -- deliberately misses soft cap, then closes fast
    const initData = Buffer.concat([
      discriminator("initialize_presale"),
      u64le(10_000), // $0.01/ACT
      i64le(startTs),
      i64le(endTs),
      u64le(100_000_000), // hard cap $100
      u64le(80_000_000), // soft cap $80 -- a $20 buy will miss this
      u64le(10_000_000), // min buy $10
      u64le(100_000_000), // max buy $100
      u16le(2500), // 25% TGE
      u32le(1), // vesting_duration_days (irrelevant here -- never reaches Finalized)
    ]);
    const initKeys = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: vaultAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: testActMint, isSigner: false, isWritable: false },
      { pubkey: actVaultAta, isSigner: false, isWritable: true },
      { pubkey: treasuryActAta, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    await send(connection, payer, new TransactionInstruction({ programId: PROGRAM_ID, keys: initKeys, data: initData }), "initialize_presale");

    const currencyData = Buffer.concat([discriminator("initialize_payment_currency"), u8le(0)]);
    const currencyKeys = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: vaultAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: testUsdcMint, isSigner: false, isWritable: false },
      { pubkey: usdcVaultAta, isSigner: false, isWritable: true },
      { pubkey: treasuryUsdcAta, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    await send(connection, payer, new TransactionInstruction({ programId: PROGRAM_ID, keys: currencyKeys, data: currencyData }), "initialize_payment_currency(0)");

    const currency1Data = Buffer.concat([discriminator("initialize_payment_currency"), u8le(1)]);
    const currency1Keys = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: vaultAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: testUsdtMint, isSigner: false, isWritable: false },
      { pubkey: usdtVaultAta, isSigner: false, isWritable: true },
      { pubkey: treasuryUsdtAta, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    await send(connection, payer, new TransactionInstruction({ programId: PROGRAM_ID, keys: currency1Keys, data: currency1Data }), "initialize_payment_currency(1)");

    // buy $20 USDC -- well under the $80 soft cap
    const buyData = Buffer.concat([discriminator("buy"), u64le(20_000_000)]);
    const buyKeys = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: buyerAccountPda, isSigner: false, isWritable: true },
      { pubkey: testUsdcMint, isSigner: false, isWritable: false },
      { pubkey: usdcVaultAta, isSigner: false, isWritable: true },
      { pubkey: deployerUsdcAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    await send(connection, payer, new TransactionInstruction({ programId: PROGRAM_ID, keys: buyKeys, data: buyData }), "buy ($20 USDC)");

    const buyerUsdcBefore = await getAccount(connection, deployerUsdcAta);
    console.log("Buyer USDC balance after buy:", buyerUsdcBefore.amount.toString());

    // wait for the window to actually end before finalize is legal
    const waitMs = Math.max(0, (endTs - Math.floor(Date.now() / 1000)) * 1000) + 3000;
    console.log(`Waiting ${Math.ceil(waitMs / 1000)}s for the sale window to end...`);
    await sleep(waitMs);

    const finalizeData = discriminator("finalize");
    const finalizeKeys = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: vaultAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: testUsdcMint, isSigner: false, isWritable: false },
      { pubkey: testUsdtMint, isSigner: false, isWritable: false },
      { pubkey: usdcVaultAta, isSigner: false, isWritable: true },
      { pubkey: usdtVaultAta, isSigner: false, isWritable: true },
      { pubkey: treasuryUsdcAta, isSigner: false, isWritable: true },
      { pubkey: treasuryUsdtAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    await send(connection, payer, new TransactionInstruction({ programId: PROGRAM_ID, keys: finalizeKeys, data: finalizeData }), "finalize (expect Refunding)");
  }

  const configInfo = await connection.getAccountInfo(configPda);
  const statusOffset = 8 + 32 + 32 + 32 * 6 + 32 * 2 + 8 + 8 + 8 + 8 + 2 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8;
  const status = configInfo.data.readUInt8(statusOffset);
  console.log("Config status:", status, "(0=Active, 1=Finalized, 2=Refunding)");
  if (status !== 2) {
    console.error("Expected status Refunding (2) before calling refund -- aborting.");
    process.exit(1);
  }

  const buyerUsdcBefore = await getAccount(connection, deployerUsdcAta);
  console.log("Buyer USDC balance before refund:", buyerUsdcBefore.amount.toString());

  const refundData = discriminator("refund");
  const refundKeys = [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: configPda, isSigner: false, isWritable: false },
    { pubkey: buyerAccountPda, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: false, isWritable: false }, // owner
    { pubkey: vaultAuthorityPda, isSigner: false, isWritable: false },
    { pubkey: testUsdcMint, isSigner: false, isWritable: false },
    { pubkey: usdcVaultAta, isSigner: false, isWritable: true },
    { pubkey: deployerUsdcAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  await send(connection, payer, new TransactionInstruction({ programId: PROGRAM_ID, keys: refundKeys, data: refundData }), "refund");

  const buyerUsdcAfter = await getAccount(connection, deployerUsdcAta);
  console.log("Buyer USDC balance after refund:", buyerUsdcAfter.amount.toString());
  const delta = buyerUsdcAfter.amount - buyerUsdcBefore.amount;
  console.log("Refunded amount:", delta.toString(), "(expected 20000000 = $20)");

  console.log("\nChecks:");
  const checks = [["refund returned exactly $20 (20,000,000 base units)", delta === 20_000_000n]];
  let allPassed = true;
  for (const [label, passed] of checks) {
    console.log(`  ${passed ? "PASS" : "FAIL"} - ${label}`);
    if (!passed) allPassed = false;
  }

  // A second refund call for the same currency should fail (AlreadyRefunded).
  try {
    await send(connection, payer, new TransactionInstruction({ programId: PROGRAM_ID, keys: refundKeys, data: refundData }), "refund again (expect AlreadyRefunded)");
    console.log("  FAIL - second refund call should have failed but succeeded");
    allPassed = false;
  } catch (err) {
    const msg = err?.message ?? String(err);
    const isAlreadyRefunded = msg.includes("AlreadyRefunded") || msg.includes("6022") || msg.includes("0x1786");
    console.log(`  ${isAlreadyRefunded ? "PASS" : "FAIL"} - second refund call correctly rejected (AlreadyRefunded)`);
    if (!isAlreadyRefunded) {
      allPassed = false;
      console.log("    (unexpected error): " + msg);
    }
  }

  if (!allPassed) {
    console.error("\nAt least one check failed.");
    process.exit(1);
  }
  console.log("\nAll checks passed. Refund path works as designed on devnet.");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
