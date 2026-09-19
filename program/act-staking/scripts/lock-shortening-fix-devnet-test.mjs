#!/usr/bin/env node
/**
 * act-staking -- lock-shortening fix, exercised live
 * ---------------------------------------------------------------------
 * `stake`'s "cannot shorten an existing lock" check (see the ceiling-
 * division comment right above it in lib.rs) has never actually been
 * called on-chain -- only reasoned about and unit-adjacent-tested. This
 * calls it for real, against the PRIMARY devnet deployment (no
 * throwaway program needed -- this doesn't require time manipulation,
 * just a fresh position and immediate top-up attempts).
 *
 * Uses a brand-new staker keypair, not the mint authority: the mint
 * authority already has an existing position from an earlier session
 * with only ~27 days left on its 30-day lock -- less than every valid
 * duration option (30/90/180/365), so there's no shorter option left to
 * even attempt a shortening with. A fresh position is needed to test
 * the rejection path at all. The mint authority is still used to mint
 * test tokens to this new staker.
 *
 *   1. stake(10 tokens, 90 days) -- fresh position.
 *   2. Immediately top-up with lock_days=30 (much shorter than the
 *      ~90 days remaining) -- must be rejected with CannotShortenLock.
 *   3. Top-up with lock_days=90 (matches remaining) -- must succeed.
 *   4. Top-up with lock_days=365 (extends further) -- must succeed,
 *      and the resulting unlock_at must be later than step 3's.
 *
 * This proves the mechanism rejects a real shortening attempt and
 * still accepts legitimate top-ups/extensions. It does not stress the
 * exact sub-day floor-vs-ceiling rounding boundary the code comment
 * describes (that needs sub-second timing precision this environment
 * can't reliably hit over a network round-trip); it proves the guard
 * works at all, which had never been confirmed on-chain before.
 *
 * Run: node scripts/lock-shortening-fix-devnet-test.mjs
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
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";

const PROGRAM_ID = new PublicKey("DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH");
const RPC_URL = "https://api.devnet.solana.com";
// The mint authority for the primary deployment's configured test token --
// an earlier session's throwaway deployer key, not the current
// devnet/deployer-keypair.json (confirmed via getMint: mintAuthority ==
// this key's pubkey). Used only to mint tokens here, not as the staker.
const MINT_AUTHORITY_KEYPAIR_PATH = path.join(os.tmpdir(), "claude-devnet-deployer", "deployer.json");
// Fresh keypair with no existing user_stake position, funded with 0.1
// devnet SOL from devnet/deployer-keypair.json for this test's fees.
const STAKER_KEYPAIR_PATH = "C:/Users/USERPC~1/AppData/Local/Temp/act_staking_fresh_staker.json";
const TEST_MINT = new PublicKey("2SJP1heXajn1zsRaG3RMEMeUuZSEDJyZYF3ApqRA23yh"); // primary deployment's configured mint

function loadKeypair(p) {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}
function discriminator(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
function u64le(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function u16le(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }

function decodeUserStake(buf) {
  let o = 8;
  const owner = new PublicKey(buf.subarray(o, o + 32)); o += 32;
  const amount = buf.readBigUInt64LE(o); o += 8;
  const lockDays = buf.readUInt16LE(o); o += 2;
  const stakedAt = buf.readBigInt64LE(o); o += 8;
  const unlockAt = buf.readBigInt64LE(o); o += 8;
  const tier = buf.readUInt8(o); o += 1;
  const bump = buf.readUInt8(o); o += 1;
  return { owner: owner.toBase58(), amount, lockDays, stakedAt, unlockAt, tier, bump };
}

async function send(connection, payer, ix, label) {
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  console.log(`${label}: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  return sig;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const mintAuthority = loadKeypair(MINT_AUTHORITY_KEYPAIR_PATH);
  const owner = loadKeypair(STAKER_KEYPAIR_PATH);
  console.log("Mint authority:", mintAuthority.publicKey.toBase58());
  console.log("Owner (fresh staker):", owner.publicKey.toBase58());

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
  const [userStakePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_stake"), owner.publicKey.toBuffer()],
    PROGRAM_ID
  );
  const [vaultAuthorityPda] = PublicKey.findProgramAddressSync([Buffer.from("vault_authority")], PROGRAM_ID);
  const vaultAta = getAssociatedTokenAddressSync(
    TEST_MINT, vaultAuthorityPda, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const ownerAta = getAssociatedTokenAddressSync(
    TEST_MINT, owner.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const existingInfo = await connection.getAccountInfo(userStakePda);
  if (existingInfo) {
    console.error("This staker already has a user_stake position -- expected a fresh keypair. Aborting.");
    process.exit(1);
  }

  await getOrCreateAssociatedTokenAccount(
    connection, mintAuthority, TEST_MINT, owner.publicKey, false, "confirmed", undefined,
    TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  console.log("Minting 100 test tokens to the fresh staker...");
  await mintTo(
    connection, mintAuthority, TEST_MINT, ownerAta, mintAuthority, 100_000_000_000n, [],
    undefined, TOKEN_2022_PROGRAM_ID
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

  const checks = [];
  function check(label, passed) {
    checks.push([label, passed]);
    console.log(`  ${passed ? "PASS" : "FAIL"} - ${label}`);
  }

  console.log("\n=== Step 1: fresh stake(10 tokens, 90 days) ===");
  await send(connection, owner, buildStakeIx(10_000_000_000n, 90), "stake");
  let info = decodeUserStake((await connection.getAccountInfo(userStakePda)).data);
  console.log(JSON.stringify({ ...info, amount: info.amount.toString(), stakedAt: info.stakedAt.toString(), unlockAt: info.unlockAt.toString() }));
  check("lockDays == 90", info.lockDays === 90);
  const unlockAtStep1 = info.unlockAt;

  console.log("\n=== Step 2: top-up with lock_days=30 (shorter than ~90 days remaining) -- expect CannotShortenLock ===");
  let rejected = false;
  try {
    await send(connection, owner, buildStakeIx(1_000_000_000n, 30), "stake top-up (expect reject)");
  } catch (err) {
    const text = JSON.stringify(err.logs || err.message || String(err));
    rejected = text.includes("CannotShortenLock");
    if (!rejected) console.log("Unexpected error:", err.message || err);
  }
  check("shortening top-up correctly rejected (CannotShortenLock)", rejected);

  info = decodeUserStake((await connection.getAccountInfo(userStakePda)).data);
  check("position unchanged after rejected top-up (amount still 10 tokens)", info.amount === 10_000_000_000n);
  check("unlock_at unchanged after rejected top-up", info.unlockAt === unlockAtStep1);

  console.log("\n=== Step 3: top-up with lock_days=90 (matches remaining) -- expect success ===");
  await send(connection, owner, buildStakeIx(1_000_000_000n, 90), "stake top-up (expect success, same duration)");
  info = decodeUserStake((await connection.getAccountInfo(userStakePda)).data);
  console.log(JSON.stringify({ ...info, amount: info.amount.toString(), stakedAt: info.stakedAt.toString(), unlockAt: info.unlockAt.toString() }));
  check("amount increased by the top-up (11 tokens total)", info.amount === 11_000_000_000n);
  const unlockAtStep3 = info.unlockAt;
  check("unlock_at did not move backward", unlockAtStep3 >= unlockAtStep1);

  console.log("\n=== Step 4: top-up with lock_days=365 (extends further) -- expect success ===");
  await send(connection, owner, buildStakeIx(1_000_000_000n, 365), "stake top-up (expect success, longer duration)");
  info = decodeUserStake((await connection.getAccountInfo(userStakePda)).data);
  console.log(JSON.stringify({ ...info, amount: info.amount.toString(), stakedAt: info.stakedAt.toString(), unlockAt: info.unlockAt.toString() }));
  check("amount increased again (12 tokens total)", info.amount === 12_000_000_000n);
  check("unlock_at extended further out than step 3's", info.unlockAt > unlockAtStep3);
  check("lockDays recorded as 365", info.lockDays === 365);

  const failed = checks.filter(([, p]) => !p);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) {
    console.error("At least one check failed.");
    process.exit(1);
  }
  console.log("\nAll checks passed. The lock-shortening guard rejects a real shortening attempt and still allows legitimate top-ups/extensions, exercised live on devnet.");
  console.log("\nNOTE: this leaves a real, still-locked position (12 tokens, 365-day lock from just now) on the primary devnet deployment for this owner.");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
