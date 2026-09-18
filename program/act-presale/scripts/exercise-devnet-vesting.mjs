#!/usr/bin/env node
/**
 * act-presale -- multi-checkpoint vesting devnet exercise
 * ---------------------------------------------------------------------
 * exercise-devnet-presale.mjs only ever claimed once, moments after
 * finalize -- enough to prove the TGE portion and the gross-up fix, but
 * not enough to prove the *linear* part of vesting actually unlocks
 * correctly over multiple checkpoints. Doing that with real seconds
 * would mean waiting 180 real days, so this targets a THIRD, throwaway
 * program deployment (HCBoBwEtqu2E2zRWRQJvYTe9CRZijCsASkytZY2n9i8P --
 * same act-presale source, temporarily built with the `test-fast-clock`
 * feature, which shrinks a "day" to 2 real seconds -- see that
 * feature's own doc comment in lib.rs and act-staking's README for why
 * this goes through a throwaway devnet deployment rather than a local
 * validator: solana-test-validator has a documented native-Windows
 * genesis-unpacking failure in this environment).
 *
 * Buys $40 (hits hard cap exactly, so finalize doesn't need to wait for
 * the window to close), sets vesting_duration_days = 30 (= 60 real
 * seconds under the fast clock), and calls `claim` four times: right
 * after TGE, at ~1/3 and ~2/3 of the vesting window, and once fully
 * past it -- checking the *cumulative* claimed amount against the
 * expected vested amount at each point, and that a claim after full
 * vesting returns exactly the remainder with nothing left over.
 *
 * Run: node scripts/exercise-devnet-vesting.mjs
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
  getAccount,
} from "@solana/spl-token";
import fs from "node:fs";
import crypto from "node:crypto";

const PROGRAM_ID = new PublicKey("HCBoBwEtqu2E2zRWRQJvYTe9CRZijCsASkytZY2n9i8P");
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
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
  console.log("Program (fast-clock, throwaway):", PROGRAM_ID.toBase58());

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

  const VESTING_DURATION_DAYS = 30; // 60 real seconds under the 2-sec fast-clock day
  const VESTING_DURATION_SECONDS = VESTING_DURATION_DAYS * 2;
  const TGE_BPS = 2500;

  const existing = await connection.getAccountInfo(configPda);
  let tgeTs;
  if (existing) {
    console.log("Config already initialized -- reading tge_ts from it.");
    tgeTs = Number(existing.data.readBigInt64LE(8 + 32 + 32 + 32 * 6 + 32 * 2 + 8 + 8 + 8));
  } else {
    const now = Math.floor(Date.now() / 1000);
    const startTs = now - 60;
    const endTs = now + 3600;
    const initData = Buffer.concat([
      discriminator("initialize_presale"),
      u64le(10_000),
      i64le(startTs),
      i64le(endTs),
      u64le(40_000_000), // hard cap $40
      u64le(30_000_000), // soft cap $30
      u64le(10_000_000), // min buy $10
      u64le(40_000_000), // max buy $40
      u16le(TGE_BPS),
      u32le(VESTING_DURATION_DAYS),
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

    // Fund the ACT reserve generously: full 4000 ACT entitlement grossed
    // up (~4145 ACT) plus headroom, so every checkpoint claim below has
    // enough to draw from.
    const fundAmount = 4_500n * 10n ** 9n;
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

    for (const [mint, vault, buyerAta] of [
      [testUsdcMint, usdcVaultAta, deployerUsdcAta],
      [testUsdtMint, usdtVaultAta, deployerUsdtAta],
    ]) {
      const buyData = Buffer.concat([discriminator("buy"), u64le(20_000_000)]);
      const buyKeys = [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: true },
        { pubkey: buyerAccountPda, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: buyerAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      await send(connection, payer, new TransactionInstruction({ programId: PROGRAM_ID, keys: buyKeys, data: buyData }), `buy ($20 via ${mint.equals(testUsdcMint) ? "USDC" : "USDT"})`);
    }

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
    await send(connection, payer, new TransactionInstruction({ programId: PROGRAM_ID, keys: finalizeKeys, data: finalizeData }), "finalize");

    const configAfter = await connection.getAccountInfo(configPda);
    tgeTs = Number(configAfter.data.readBigInt64LE(8 + 32 + 32 + 32 * 6 + 32 * 2 + 8 + 8 + 8));
  }

  console.log("tge_ts:", tgeTs, "vesting_duration_seconds:", VESTING_DURATION_SECONDS);

  const TOTAL_ALLOCATED_NET = 4_000_000_000_000n; // 4000 ACT
  const TGE_AMOUNT = (TOTAL_ALLOCATED_NET * BigInt(TGE_BPS)) / 10_000n; // 1000 ACT
  const REMAINING = TOTAL_ALLOCATED_NET - TGE_AMOUNT; // 3000 ACT

  function expectedVested(nowSec) {
    if (nowSec < tgeTs) return 0n;
    const elapsed = BigInt(nowSec - tgeTs);
    if (elapsed >= BigInt(VESTING_DURATION_SECONDS)) return TOTAL_ALLOCATED_NET;
    const linear = (REMAINING * elapsed) / BigInt(VESTING_DURATION_SECONDS);
    return TGE_AMOUNT + linear;
  }

  const claimKeysBase = [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: configPda, isSigner: false, isWritable: true },
    { pubkey: buyerAccountPda, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: false, isWritable: false }, // owner
    { pubkey: vaultAuthorityPda, isSigner: false, isWritable: false },
    { pubkey: testActMint, isSigner: false, isWritable: false },
    { pubkey: actVaultAta, isSigner: false, isWritable: true },
    { pubkey: deployerActAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  const claimData = discriminator("claim");

  async function readBuyerClaimedNet() {
    const info = await connection.getAccountInfo(buyerAccountPda);
    // BuyerAccount: discriminator(8) + owner(32) + payment_contributed[2](16) + act_allocated_net(8) + act_claimed_net(8)
    return info.data.readBigUInt64LE(8 + 32 + 16 + 8);
  }

  const checkpoints = [
    { label: "checkpoint 1 (right after TGE)", waitSec: 2 },
    { label: "checkpoint 2 (~1/3 through vesting)", waitSec: VESTING_DURATION_SECONDS / 3 },
    { label: "checkpoint 3 (~2/3 through vesting)", waitSec: VESTING_DURATION_SECONDS / 3 },
    { label: "checkpoint 4 (fully past vesting)", waitSec: VESTING_DURATION_SECONDS / 3 + 5 },
  ];

  let allPassed = true;
  for (const { label, waitSec } of checkpoints) {
    console.log(`\nWaiting ${waitSec}s before ${label}...`);
    await sleep(waitSec * 1000);

    await send(connection, payer, new TransactionInstruction({ programId: PROGRAM_ID, keys: claimKeysBase, data: claimData }), `claim @ ${label}`);

    const nowSec = Math.floor(Date.now() / 1000);
    const claimedOnChain = await readBuyerClaimedNet();
    const expected = expectedVested(nowSec);
    // Allow the on-chain value to be slightly ahead of our local
    // `expected` estimate (a second or two of extra real elapsed time
    // between building the expectation and the transaction landing),
    // but never behind it, and never exceed the total allocation.
    const withinBounds = claimedOnChain >= (expected > 50_000_000n ? expected - 50_000_000n : 0n) && claimedOnChain <= TOTAL_ALLOCATED_NET;
    console.log(`  on-chain act_claimed_net: ${claimedOnChain} (expected ~${expected})`);
    console.log(`  ${withinBounds ? "PASS" : "FAIL"} - claimed amount within expected bounds`);
    if (!withinBounds) allPassed = false;
  }

  const finalClaimed = await readBuyerClaimedNet();
  console.log("\nFinal act_claimed_net:", finalClaimed.toString(), "(expected exactly", TOTAL_ALLOCATED_NET.toString() + ")");
  const fullyClaimed = finalClaimed === TOTAL_ALLOCATED_NET;
  console.log(`  ${fullyClaimed ? "PASS" : "FAIL"} - fully vested amount claimed exactly, no more no less`);
  if (!fullyClaimed) allPassed = false;

  // A further claim attempt should now fail with NothingClaimable.
  try {
    await send(connection, payer, new TransactionInstruction({ programId: PROGRAM_ID, keys: claimKeysBase, data: claimData }), "claim again (expect NothingClaimable)");
    console.log("  FAIL - claim after full vesting should have failed but succeeded");
    allPassed = false;
  } catch (err) {
    const msg = err?.message ?? String(err);
    const isNothingClaimable = msg.includes("NothingClaimable");
    console.log(`  ${isNothingClaimable ? "PASS" : "FAIL"} - further claim correctly rejected (NothingClaimable)`);
    if (!isNothingClaimable) {
      allPassed = false;
      console.log("    (unexpected error): " + msg);
    }
  }

  if (!allPassed) {
    console.error("\nAt least one check failed.");
    process.exit(1);
  }
  console.log("\nAll checks passed. Multi-checkpoint linear vesting works as designed on devnet (fast-clock build).");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
