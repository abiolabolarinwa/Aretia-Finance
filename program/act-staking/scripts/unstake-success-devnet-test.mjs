#!/usr/bin/env node
/**
 * act-staking -- unstake() SUCCESS-PATH devnet exercise
 * ---------------------------------------------------------------------
 * stake-unstake-devnet-test.mjs proved `stake` and `unstake`'s early-
 * withdrawal REJECTION, but explicitly could not prove `unstake`'s
 * success path -- the shortest configured lock is 30 real days, and a
 * local-validator route to fast-forward that was tried and blocked by a
 * documented native-Windows solana-test-validator genesis-unpacking
 * failure (see this repo's README, "Local-validator attempt").
 *
 * This closes that gap the same way act-presale's vesting checkpoints
 * were tested: a THROWAWAY devnet deployment
 * (Dk71i4rN8MmPFc1awfChRZigcso8DwBMLKwSGS5NW7ur -- same act-staking
 * source, built with `test-fast-clock` so a "day" is 2 real seconds,
 * never the real devnet/mainnet program) instead of a local validator.
 * A 30-day lock matures in 60 real seconds under this build, which is
 * exactly what's exercised here.
 *
 * Uses act-presale's throwaway test-ACT mint (Token-2022, 350 bps
 * transfer fee) rather than a fresh fee-less mint, specifically so this
 * test also confirms the documented (not previously exercised) fact
 * that `unstake` does NOT gross up the withdrawal -- the wallet nets
 * BOTH the deposit-side and withdrawal-side fee, ending up with
 * roughly staked_amount * 0.965^2, not staked_amount * 0.965.
 *
 * Run: node scripts/unstake-success-devnet-test.mjs
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
  getAccount,
} from "@solana/spl-token";
import fs from "node:fs";
import crypto from "node:crypto";

const PROGRAM_ID = new PublicKey("Dk71i4rN8MmPFc1awfChRZigcso8DwBMLKwSGS5NW7ur");
const RPC_URL = "https://api.devnet.solana.com";
const DEPLOYER_KEYPAIR_PATH =
  "C:/Users/USER PC/OneDrive - Furst Peak Solutions/My Stuff/Folders/2026/Aretia Climate App/aretia-finance/devnet/deployer-keypair.json";
// test-ACT from act-presale's devnet-test-tokens.json (Token-2022, 350 bps fee).
const TEST_MINT = new PublicKey("DByy9CGFgXAEGeaufeA275y8tP9aiXWZkjRanNMd4pEr");

function loadKeypair(path) {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}
function discriminator(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
function u64le(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function u16le(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function decodeUserStake(buf) {
  let offset = 8;
  const owner = new PublicKey(buf.subarray(offset, offset + 32)); offset += 32;
  const amount = buf.readBigUInt64LE(offset); offset += 8;
  const lockDays = buf.readUInt16LE(offset); offset += 2;
  const stakedAt = buf.readBigInt64LE(offset); offset += 8;
  const unlockAt = buf.readBigInt64LE(offset); offset += 8;
  const tier = buf.readUInt8(offset); offset += 1;
  const bump = buf.readUInt8(offset); offset += 1;
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
  const owner = loadKeypair(DEPLOYER_KEYPAIR_PATH);
  console.log("Owner:", owner.publicKey.toBase58());

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

  console.log("Config PDA:", configPda.toBase58());
  console.log("User stake PDA:", userStakePda.toBase58());

  const existingConfig = await connection.getAccountInfo(configPda);
  if (!existingConfig) {
    console.log("\nInitializing config...");
    const tiers = [0, 1_000_000, 5_000_000, 20_000_000, 75_000_000].map((t) => BigInt(t) * 10n ** 9n);
    const durationDays = [30, 90, 180, 365];
    const durationMultiplier = [100, 130, 175, 260];
    const initData = Buffer.concat([
      discriminator("initialize_config"),
      ...tiers.map(u64le),
      ...durationDays.map(u16le),
      ...durationMultiplier.map(u16le),
    ]);
    const initKeys = [
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: vaultAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: TEST_MINT, isSigner: false, isWritable: false },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    await send(connection, owner, new TransactionInstruction({ programId: PROGRAM_ID, keys: initKeys, data: initData }), "initialize_config");
  } else {
    console.log("\nConfig already initialized -- skipping setup.");
  }

  await getOrCreateAssociatedTokenAccount(
    connection, owner, TEST_MINT, owner.publicKey, false, "confirmed", undefined,
    TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const existingUserStake = await connection.getAccountInfo(userStakePda);
  const checks = [];
  function check(label, passed) {
    checks.push([label, passed]);
    console.log(`  ${passed ? "PASS" : "FAIL"} - ${label}`);
  }

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

  let stakedAmountGross;
  if (existingUserStake) {
    console.log("\nExisting stake found -- skipping fresh stake, proceeding to maturity wait/unstake.");
    const decoded = decodeUserStake(existingUserStake.data);
    console.log(JSON.stringify({ ...decoded, amount: decoded.amount.toString(), stakedAt: decoded.stakedAt.toString(), unlockAt: decoded.unlockAt.toString() }, null, 2));
  } else {
    console.log("\n=== Minting 1000 test-ACT to owner ===");
    await mintTo(
      connection, owner, TEST_MINT, ownerAta, owner, 1_000n * 10n ** 9n, [],
      undefined, TOKEN_2022_PROGRAM_ID
    );

    console.log("\n=== stake(1000 test-ACT, 30 days) ===");
    stakedAmountGross = 1_000n * 10n ** 9n;
    const vaultBefore = (await getAccount(connection, vaultAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    await send(connection, owner, buildStakeIx(stakedAmountGross, 30), "stake");
    const vaultAfter = (await getAccount(connection, vaultAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    const netReceived = vaultAfter - vaultBefore;
    console.log("Vault net received (gross 1000, minus ~3.5% deposit fee):", netReceived.toString());

    const info = await connection.getAccountInfo(userStakePda);
    const decoded = decodeUserStake(info.data);
    console.log(JSON.stringify({ ...decoded, amount: decoded.amount.toString(), stakedAt: decoded.stakedAt.toString(), unlockAt: decoded.unlockAt.toString() }, null, 2));
    check("user_stake.amount == net received (post deposit-fee)", decoded.amount === netReceived);
    check("unlock_at - staked_at == 60s (30 days at 2s/day fast clock)", Number(decoded.unlockAt - decoded.stakedAt) === 60);

    console.log("\n=== unstake() before maturity (expect StillLocked rejection) ===");
    let rejected = false;
    try {
      await send(connection, owner, buildUnstakeIx(), "unstake (expect reject)");
    } catch (err) {
      const text = JSON.stringify(err.logs || err.message || String(err));
      rejected = text.includes("StillLocked") || text.includes("6005") || text.includes("0x1775");
      if (!rejected) console.log("Unexpected error:", err.message || err);
    }
    check("early unstake correctly rejected (StillLocked)", rejected);
  }

  const infoBeforeWait = await connection.getAccountInfo(userStakePda);
  const decodedBeforeWait = decodeUserStake(infoBeforeWait.data);
  const waitSeconds = Math.max(0, Number(decodedBeforeWait.unlockAt) - Math.floor(Date.now() / 1000)) + 5;
  console.log(`\nWaiting ${waitSeconds}s for the 30-day (fast-clock) lock to mature...`);
  await sleep(waitSeconds * 1000);

  console.log("\n=== unstake() after maturity (expect SUCCESS) ===");
  const ownerBalanceBefore = (await getAccount(connection, ownerAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  const stakedAmountNet = decodedBeforeWait.amount; // what the vault actually holds for this position

  await send(connection, owner, buildUnstakeIx(), "unstake (expect success)");

  const ownerBalanceAfter = (await getAccount(connection, ownerAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  const received = ownerBalanceAfter - ownerBalanceBefore;
  console.log("Vault-recorded staked amount (net of deposit fee):", stakedAmountNet.toString());
  console.log("Owner's wallet balance increase (net of BOTH fee hops):", received.toString());

  // Expect roughly stakedAmountNet * 0.965 (withdrawal-side fee only,
  // since stakedAmountNet is already net of the deposit-side fee) --
  // confirms unstake does NOT gross up, exactly as documented.
  const expectedApprox = (stakedAmountNet * 965n) / 1000n;
  const withinTolerance = received > 0n &&
    (received > expectedApprox ? received - expectedApprox : expectedApprox - received) < (stakedAmountNet / 100n);
  check("received > 0 (unstake actually paid out)", received > 0n);
  check("received ~= stakedAmountNet * 0.965 (withdrawal fee applied, no gross-up, as documented)", withinTolerance);

  const userStakeInfoAfter = await connection.getAccountInfo(userStakePda);
  check("user_stake account closed (rent refunded) after successful unstake", userStakeInfoAfter === null);

  console.log("\n=== Summary ===");
  const failed = checks.filter(([, p]) => !p);
  for (const [label, passed] of checks) console.log(`  ${passed ? "PASS" : "FAIL"} - ${label}`);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) {
    console.error("\nAt least one check failed.");
    process.exit(1);
  }
  console.log("\nAll checks passed. unstake()'s success path works as designed on devnet (fast-clock build).");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
