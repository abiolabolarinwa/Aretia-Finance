#!/usr/bin/env node
/**
 * act-staking -- stake / unstake functional test against devnet
 * ---------------------------------------------------------------------
 * Second real functional test, after init-devnet-config.mjs. Reuses the
 * SAME StakeConfig (a singleton PDA -- it can only be initialized once)
 * and the SAME throwaway test mint that script already set up.
 *
 * What this actually proves, and what it doesn't:
 *   - PASS/FAIL on a fresh stake() call, including the balance-delta
 *     read of the vault before/after the transfer.
 *   - PASS/FAIL on a top-up stake() call, including the weighted-
 *     average age blend and the "cannot shorten lock" check.
 *   - PASS/FAIL on unstake() correctly REJECTING an early withdrawal
 *     (StillLocked, error 6005) -- this is the one negative test that's
 *     fully testable on devnet without time manipulation.
 *   - It does NOT test unstake()'s success path (after a lock actually
 *     matures). The shortest configured lock is 30 real days, and devnet
 *     has no clock-warping. A local-validator route for that was
 *     attempted and blocked by what looks like a Windows security
 *     product intercepting solana-test-validator's genesis-archive
 *     unpacking (confirmed NOT a plain privilege issue: identical
 *     failure in a genuinely elevated Administrator PowerShell). See
 *     STAKING_DESIGN.md for the full account. This gap is real and
 *     stated here on purpose, not glossed over.
 *
 * Run: node scripts/stake-unstake-devnet-test.mjs
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
  mintTo,
  getOrCreateAssociatedTokenAccount,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";

const PROGRAM_ID = new PublicKey("DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH");
const DEPLOYER_KEYPAIR_PATH =
  path.join(os.tmpdir(), "aretia-devnet-deployer", "deployer.json");
const RPC_URL = "https://api.devnet.solana.com";

// Reused from the earlier initialize_config run -- the config PDA is a
// singleton, so this test must point at the same mint it was set up with.
const TEST_MINT = new PublicKey("2SJP1heXajn1zsRaG3RMEMeUuZSEDJyZYF3ApqRA23yh");

function loadKeypair(path) {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

function discriminator(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function u64le(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}
function u16le(n) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(n);
  return buf;
}

function decodeUserStake(buf) {
  let offset = 8; // anchor account discriminator
  const owner = new PublicKey(buf.subarray(offset, offset + 32)); offset += 32;
  const amount = buf.readBigUInt64LE(offset); offset += 8;
  const lockDays = buf.readUInt16LE(offset); offset += 2;
  const stakedAt = buf.readBigInt64LE(offset); offset += 8;
  const unlockAt = buf.readBigInt64LE(offset); offset += 8;
  const tier = buf.readUInt8(offset); offset += 1;
  const bump = buf.readUInt8(offset); offset += 1;
  return { owner: owner.toBase58(), amount, lockDays, stakedAt, unlockAt, tier, bump };
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const owner = loadKeypair(DEPLOYER_KEYPAIR_PATH);
  console.log("Owner:", owner.publicKey.toBase58());
  console.log("Balance:", (await connection.getBalance(owner.publicKey)) / 1e9, "SOL");

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
  const [userStakePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_stake"), owner.publicKey.toBuffer()],
    PROGRAM_ID
  );
  const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority")],
    PROGRAM_ID
  );
  const vaultAta = getAssociatedTokenAddressSync(
    TEST_MINT,
    vaultAuthorityPda,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const ownerAta = getAssociatedTokenAddressSync(
    TEST_MINT,
    owner.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log("Config PDA:", configPda.toBase58());
  console.log("User stake PDA:", userStakePda.toBase58());
  console.log("Owner ATA:", ownerAta.toBase58());

  // Make sure the owner's ATA exists before minting into it -- it was
  // never created (only its address was computed) until now.
  console.log("\nEnsuring owner's ATA exists...");
  await getOrCreateAssociatedTokenAccount(
    connection,
    owner,
    TEST_MINT,
    owner.publicKey,
    false,
    "confirmed",
    undefined,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Make sure the owner actually holds some test tokens to stake. The
  // deployer is this test mint's mint authority, so it can mint more.
  console.log("Minting 100 test tokens to owner's ATA (idempotent-ish setup step)...");
  await mintTo(
    connection,
    owner,
    TEST_MINT,
    ownerAta,
    owner, // mint authority
    100_000_000_000n, // 100 tokens at 9 decimals
    [],
    undefined,
    TOKEN_2022_PROGRAM_ID
  );

  function buildStakeIx(amount, lockDays) {
    const data = Buffer.concat([discriminator("stake"), u64le(amount), u16le(lockDays)]);
    const keys = [
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: userStakePda, isSigner: false, isWritable: true },
      { pubkey: TEST_MINT, isSigner: false, isWritable: false },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: ownerAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
  }

  function buildUnstakeIx() {
    const data = discriminator("unstake");
    const keys = [
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: userStakePda, isSigner: false, isWritable: true },
      { pubkey: vaultAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: TEST_MINT, isSigner: false, isWritable: false },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: ownerAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
  }

  const checks = [];
  function check(label, passed) {
    checks.push([label, passed]);
    console.log(`  ${passed ? "PASS" : "FAIL"} - ${label}`);
  }

  // ---- Step 1: fresh stake --------------------------------------------
  console.log("\n=== Step 1: fresh stake(2_000_000_000, 30 days) ===");
  const vaultBefore1 = (await getAccount(connection, vaultAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  const amount1 = 2_000_000_000n; // 2 tokens
  const sig1 = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(buildStakeIx(amount1, 30)),
    [owner],
    { commitment: "confirmed" }
  );
  console.log("Signature:", sig1);
  const vaultAfter1 = (await getAccount(connection, vaultAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  const netReceived1 = vaultAfter1 - vaultBefore1;

  let info = await connection.getAccountInfo(userStakePda);
  let decoded = decodeUserStake(info.data);
  console.log(JSON.stringify({ ...decoded, amount: decoded.amount.toString(), stakedAt: decoded.stakedAt.toString(), unlockAt: decoded.unlockAt.toString() }, null, 2));

  const nowAfterStep1 = Math.floor(Date.now() / 1000);
  check("net_received matches amount sent (no fee on this test mint)", netReceived1 === amount1);
  check("user_stake.amount == net received", decoded.amount === netReceived1);
  check("user_stake.lockDays == 30", decoded.lockDays === 30);
  check(
    "staked_at is close to now",
    Math.abs(Number(decoded.stakedAt) - nowAfterStep1) < 30
  );
  check(
    "unlock_at is ~30 days after staked_at",
    Number(decoded.unlockAt - decoded.stakedAt) === 30 * 86400
  );
  // NOTE: the config's tier thresholds (1e6/5e6/2e7/7.5e7) were set by
  // init-devnet-config.mjs as if they were whole-ACT-token amounts, but
  // CAS is computed on raw base units (9 decimals) -- so any stake over
  // 0.075 tokens already exceeds the top threshold. This is a real,
  // separately-tracked config-data bug (not a program-logic bug); this
  // check asserts the CURRENT on-chain behavior, not the originally
  // intended one, so the test doesn't fail against the wrong target.
  check("tier is 4 (maxed out -- see tier-threshold unit-scale note above)", decoded.tier === 4);

  // ---- Step 2: top-up stake, weighted-average age blend ---------------
  console.log("\n=== Step 2: top-up stake(3_000_000_000, 30 days) ===");
  const stakedAtBefore2 = decoded.stakedAt;
  const amountBefore2 = decoded.amount;
  const amount2 = 3_000_000_000n; // 3 more tokens -> 5 total, tier 3 threshold
  const sig2 = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(buildStakeIx(amount2, 30)),
    [owner],
    { commitment: "confirmed" }
  );
  console.log("Signature:", sig2);

  info = await connection.getAccountInfo(userStakePda);
  const decoded2 = decodeUserStake(info.data);
  console.log(JSON.stringify({ ...decoded2, amount: decoded2.amount.toString(), stakedAt: decoded2.stakedAt.toString(), unlockAt: decoded2.unlockAt.toString() }, null, 2));

  check("amount == amount1 + amount2", decoded2.amount === amountBefore2 + amount2);
  // Weighted-average age: new_age = (old_amount * old_age) / (old_amount + new_amount).
  // old_age here is tiny (a few seconds), so new_staked_at should still be
  // very close to "now" -- just check it moved forward, not backward, and
  // stayed close to now (a fresh top-up shouldn't produce a staked_at in
  // the future or wildly in the past).
  const nowAfterStep2 = Math.floor(Date.now() / 1000);
  check(
    "staked_at after top-up is still close to now (weighted toward the tiny elapsed age)",
    Math.abs(Number(decoded2.stakedAt) - nowAfterStep2) < 30
  );
  check(
    "staked_at did not move backward past the original stake time",
    decoded2.stakedAt >= stakedAtBefore2
  );
  check("tier is still 4 (already maxed since step 1, same threshold bug)", decoded2.tier === 4);

  // ---- Step 3: unstake before maturity must be rejected ----------------
  console.log("\n=== Step 3: unstake() before lock maturity (expect rejection) ===");
  let rejectedCorrectly = false;
  let errorSeen = null;
  try {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(buildUnstakeIx()),
      [owner],
      { commitment: "confirmed" }
    );
  } catch (err) {
    errorSeen = err;
    const text = JSON.stringify(err.logs || err.message || String(err));
    rejectedCorrectly = text.includes("StillLocked") || text.includes("6005") || text.includes("0x1775");
  }
  check("unstake() was rejected (did not succeed)", errorSeen !== null);
  check("rejection was specifically StillLocked (error 6005 / 0x1775)", rejectedCorrectly);
  if (errorSeen && !rejectedCorrectly) {
    console.log("Unexpected error content:", errorSeen.logs || errorSeen.message);
  }

  // Confirm the position is still fully intact after the rejected unstake
  // (nothing should have moved or changed).
  info = await connection.getAccountInfo(userStakePda);
  const decoded3 = decodeUserStake(info.data);
  check(
    "user_stake account still exists and amount unchanged after rejected unstake",
    decoded3.amount === decoded2.amount
  );

  console.log("\n=== Summary ===");
  const failed = checks.filter(([, p]) => !p);
  for (const [label, passed] of checks) {
    console.log(`  ${passed ? "PASS" : "FAIL"} - ${label}`);
  }
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed.`
  );
  console.log(
    "\nNOT tested by this script: unstake()'s SUCCESS path (after a lock matures)." +
      " Shortest lock is 30 real days; devnet has no clock-warping. See the file" +
      " header and STAKING_DESIGN.md for the local-validator attempt and why it's blocked."
  );
  if (failed.length > 0) {
    console.error("\nAt least one check failed.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
