#!/usr/bin/env node
/**
 * act-presale -- first functional devnet exercise
 * ---------------------------------------------------------------------
 * Hand-builds and sends every presale instruction against the deployed
 * devnet program, using the throwaway test-ACT/test-USDC/test-USDT
 * mints from setup-devnet-tokens.mjs. No Anchor CLI/IDL is available in
 * this environment, so instructions are built manually (8-byte sighash
 * discriminator + borsh-encoded args), matching
 * programs/act-presale/src/lib.rs exactly -- same pattern as
 * act-staking/scripts/init-devnet-config.mjs.
 *
 * This run uses DEVNET-TEST-ONLY parameters (tiny caps, a short window),
 * deliberately different from the real launch parameters in
 * PRESALE_DESIGN.md (Oct 1 - Dec 1 2026, $1M hard cap, $500K soft cap):
 * the point here is to exercise every instruction path in one sitting,
 * not to rehearse the real launch numbers. hard_cap is set to exactly
 * match the two test buys below, so the hard-cap-reached branch of
 * `finalize` fires immediately instead of waiting for the real window
 * to close.
 *
 * The single devnet deployer wallet plays both "authority" and "buyer"
 * roles -- there's only one funded devnet keypair in this repo, and
 * nothing in the program's logic distinguishes those roles by identity
 * beyond the authority checks already being exercised elsewhere (every
 * `has_one = authority` check still runs for real).
 *
 * This exercises: initialize_presale, initialize_payment_currency (x2),
 * fund_act_reserve, buy (both currencies), finalize (happy path --
 * sweeps to the real Squads treasury ATAs), claim (TGE portion), and
 * sweep_unsold_act. It does NOT exercise the refund path (that needs a
 * second presale instance where the soft cap is deliberately missed --
 * this program's config PDA is a per-deployment singleton) or the full
 * linear-vesting schedule (would need real elapsed days, since this
 * devnet build was NOT compiled with `test-fast-clock`, deliberately,
 * per that feature's own doc comment).
 *
 * Run: node scripts/exercise-devnet-presale.mjs
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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROGRAM_ID = new PublicKey("5hmgnujNib14NDkEgRsLpY3H8SBDCsLryiymNKY6fWku");
const RPC_URL = "https://api.devnet.solana.com";
const DEPLOYER_KEYPAIR_PATH =
  path.resolve(__dirname, "../../../devnet/deployer-keypair.json");

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
  const deployerUsdcAta = new PublicKey(tokens.deployerUsdcAta);
  const deployerUsdtAta = new PublicKey(tokens.deployerUsdtAta);

  const [configPda, configBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("presale_config")],
    PROGRAM_ID
  );
  const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority")],
    PROGRAM_ID
  );
  const [buyerAccountPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("presale_buyer"), payer.publicKey.toBuffer()],
    PROGRAM_ID
  );
  const actVaultAta = getAssociatedTokenAddressSync(
    testActMint, vaultAuthorityPda, true, TOKEN_2022_PROGRAM_ID
  );
  const usdcVaultAta = getAssociatedTokenAddressSync(testUsdcMint, vaultAuthorityPda, true);
  const usdtVaultAta = getAssociatedTokenAddressSync(testUsdtMint, vaultAuthorityPda, true);

  console.log("Config PDA:", configPda.toBase58());
  console.log("Vault authority PDA:", vaultAuthorityPda.toBase58());

  const existing = await connection.getAccountInfo(configPda);
  if (existing) {
    console.log("\nConfig already initialized on-chain -- skipping setup, jumping to buy/finalize/claim.");
  } else {
    // ---- 1. initialize_presale --------------------------------------
    const now = Math.floor(Date.now() / 1000);
    const startTs = now - 60;
    const endTs = now + 3600; // devnet-test-only window, not the real Oct1-Dec1 dates
    const priceMicroPaymentPerAct = 10_000; // $0.01/ACT in 6-decimal payment units
    const hardCapPayment = 40_000_000; // $40 total -- exactly two $20 test buys
    const softCapPayment = 30_000_000; // $30 -- met by the two buys, exercises the happy path
    const minBuyPayment = 10_000_000; // $10, per PRESALE_DESIGN.md
    const maxBuyPayment = 40_000_000; // $40 == hard cap, so either buy alone stays under it
    const tgeBps = 2500; // 25%
    const vestingDurationDays = 1; // minimum allowed; only the TGE portion is exercised here

    const initData = Buffer.concat([
      discriminator("initialize_presale"),
      u64le(priceMicroPaymentPerAct),
      i64le(startTs),
      i64le(endTs),
      u64le(hardCapPayment),
      u64le(softCapPayment),
      u64le(minBuyPayment),
      u64le(maxBuyPayment),
      u16le(tgeBps),
      u32le(vestingDurationDays),
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
    await send(
      connection, payer,
      new TransactionInstruction({ programId: PROGRAM_ID, keys: initKeys, data: initData }),
      "initialize_presale"
    );

    // ---- 2. initialize_payment_currency(0) -- USDC -------------------
    for (const [idx, mint, vault, treasury, tokenProgram] of [
      [0, testUsdcMint, usdcVaultAta, treasuryUsdcAta, TOKEN_PROGRAM_ID],
      [1, testUsdtMint, usdtVaultAta, treasuryUsdtAta, TOKEN_PROGRAM_ID],
    ]) {
      const data = Buffer.concat([discriminator("initialize_payment_currency"), u8le(idx)]);
      const keys = [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: true },
        { pubkey: vaultAuthorityPda, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: treasury, isSigner: false, isWritable: false },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      await send(
        connection, payer,
        new TransactionInstruction({ programId: PROGRAM_ID, keys, data }),
        `initialize_payment_currency(${idx})`
      );
    }

    // ---- 3. fund_act_reserve ------------------------------------------
    // Sends 1200 gross test-ACT; nets ~1158 after the 3.5% transfer fee --
    // comfortably covers the ~1036 gross ACT the TGE claim below needs.
    const fundAmount = 1_200n * 10n ** 9n;
    const fundData = Buffer.concat([discriminator("fund_act_reserve"), u64le(fundAmount)]);
    const fundKeys = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: testActMint, isSigner: false, isWritable: false },
      { pubkey: actVaultAta, isSigner: false, isWritable: true },
      { pubkey: deployerActAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    await send(
      connection, payer,
      new TransactionInstruction({ programId: PROGRAM_ID, keys: fundKeys, data: fundData }),
      "fund_act_reserve"
    );

    // ---- 4. buy x2 (USDC then USDT), $20 each, hits hard cap exactly --
    for (const [mint, vault, buyerAta, tokenProgram] of [
      [testUsdcMint, usdcVaultAta, deployerUsdcAta, TOKEN_PROGRAM_ID],
      [testUsdtMint, usdtVaultAta, deployerUsdtAta, TOKEN_PROGRAM_ID],
    ]) {
      const buyAmount = 20_000_000; // $20
      const buyData = Buffer.concat([discriminator("buy"), u64le(buyAmount)]);
      const buyKeys = [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: true },
        { pubkey: buyerAccountPda, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: buyerAta, isSigner: false, isWritable: true },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      await send(
        connection, payer,
        new TransactionInstruction({ programId: PROGRAM_ID, keys: buyKeys, data: buyData }),
        `buy ($20 via ${mint.equals(testUsdcMint) ? "USDC" : "USDT"})`
      );
    }

    // ---- 5. finalize (hard cap reached -> happy path, sweeps to real Squads treasury ATAs) --
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
    await send(
      connection, payer,
      new TransactionInstruction({ programId: PROGRAM_ID, keys: finalizeKeys, data: finalizeData }),
      "finalize"
    );
  }

  // ---- 6. claim (TGE portion) ----------------------------------------
  const claimData = discriminator("claim");
  const claimKeys = [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: configPda, isSigner: false, isWritable: true },
    { pubkey: buyerAccountPda, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: false, isWritable: false }, // owner (== buyer)
    { pubkey: vaultAuthorityPda, isSigner: false, isWritable: false },
    { pubkey: testActMint, isSigner: false, isWritable: false },
    { pubkey: actVaultAta, isSigner: false, isWritable: true },
    { pubkey: deployerActAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  await send(
    connection, payer,
    new TransactionInstruction({ programId: PROGRAM_ID, keys: claimKeys, data: claimData }),
    "claim (TGE portion)"
  );

  // ---- 7. sweep_unsold_act (expected to fail here -- vault holds less
  //         than what's still owed for the un-vested 75%, which is the
  //         correct, conservative outcome; not treated as a script error) --
  const sweepData = discriminator("sweep_unsold_act");
  const sweepKeys = [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: configPda, isSigner: false, isWritable: false },
    { pubkey: vaultAuthorityPda, isSigner: false, isWritable: false },
    { pubkey: testActMint, isSigner: false, isWritable: false },
    { pubkey: actVaultAta, isSigner: false, isWritable: true },
    { pubkey: treasuryActAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  try {
    await send(
      connection, payer,
      new TransactionInstruction({ programId: PROGRAM_ID, keys: sweepKeys, data: sweepData }),
      "sweep_unsold_act"
    );
  } catch (err) {
    console.log("sweep_unsold_act failed as expected (vault holds less than what's still owed):");
    console.log("  " + (err?.message ?? err));
  }

  // ---- Read back final state -----------------------------------------
  console.log("\nFinal on-chain state:");
  const configInfo = await connection.getAccountInfo(configPda);
  const buf = configInfo.data;
  let o = 8 + 32 + 32; // discriminator + authority + act_mint
  o += 32 * 2 + 32 * 2 + 32 * 2; // accepted_mints[2], accepted_vaults[2], treasury_payment_accounts[2]
  o += 32 + 32; // act_vault, treasury_act_account
  const priceRead = buf.readBigUInt64LE(o); o += 8;
  const startTsRead = buf.readBigInt64LE(o); o += 8;
  const endTsRead = buf.readBigInt64LE(o); o += 8;
  const tgeTsRead = buf.readBigInt64LE(o); o += 8;
  const tgeBpsRead = buf.readUInt16LE(o); o += 2;
  const vestingSecRead = buf.readBigInt64LE(o); o += 8;
  const hardCapRead = buf.readBigUInt64LE(o); o += 8;
  const softCapRead = buf.readBigUInt64LE(o); o += 8;
  const minBuyRead = buf.readBigUInt64LE(o); o += 8;
  const maxBuyRead = buf.readBigUInt64LE(o); o += 8;
  const totalRaisedRead = buf.readBigUInt64LE(o); o += 8;
  const totalSoldRead = buf.readBigUInt64LE(o); o += 8;
  const totalClaimedRead = buf.readBigUInt64LE(o); o += 8;
  const reserveNetRead = buf.readBigUInt64LE(o); o += 8;
  const statusRead = buf.readUInt8(o); o += 1;

  console.log({
    price: priceRead.toString(),
    startTs: startTsRead.toString(),
    endTs: endTsRead.toString(),
    tgeTs: tgeTsRead.toString(),
    tgeBps: tgeBpsRead,
    vestingSeconds: vestingSecRead.toString(),
    hardCap: hardCapRead.toString(),
    softCap: softCapRead.toString(),
    minBuy: minBuyRead.toString(),
    maxBuy: maxBuyRead.toString(),
    totalRaised: totalRaisedRead.toString(),
    totalActSoldNet: totalSoldRead.toString(),
    totalActClaimedNet: totalClaimedRead.toString(),
    actReserveNet: reserveNetRead.toString(),
    status: statusRead, // 0=Active, 1=Finalized, 2=Refunding
  });

  // totalActClaimedNet is >= the exact TGE-only amount (1000 ACT = 25% of
  // 4000), and grows with elapsed real time since tge_ts due to linear
  // vesting -- it is not pinned to exactly 1000 on a re-run against an
  // already-finalized config from an earlier session.
  const checks = [
    ["status is Finalized (1)", statusRead === 1],
    ["totalRaised == hard cap ($40)", totalRaisedRead === 40_000_000n],
    ["totalActSoldNet == 4000 ACT", totalSoldRead === 4_000_000_000_000n],
    ["totalActClaimedNet >= TGE-only amount (1000 ACT)", totalClaimedRead >= 1_000_000_000_000n],
  ];
  console.log("\nChecks:");
  let allPassed = true;
  for (const [label, passed] of checks) {
    console.log(`  ${passed ? "PASS" : "FAIL"} - ${label}`);
    if (!passed) allPassed = false;
  }
  if (!allPassed) {
    console.error("\nAt least one check failed.");
    process.exit(1);
  }
  console.log("\nAll checks passed.");

  const treasuryUsdcBalance = await connection.getTokenAccountBalance(treasuryUsdcAta);
  const treasuryUsdtBalance = await connection.getTokenAccountBalance(treasuryUsdtAta);
  console.log("\nReal Squads vault treasury balances after finalize:");
  console.log("  treasury_usdc_account:", treasuryUsdcBalance.value.uiAmountString, "test-USDC");
  console.log("  treasury_usdt_account:", treasuryUsdtBalance.value.uiAmountString, "test-USDT");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
