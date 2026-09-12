#!/usr/bin/env node
/**
 * act-staking -- first functional test against the devnet deployment
 * ---------------------------------------------------------------------
 * A deployed program proves the bytecode loads and is executable. It
 * proves nothing about whether any instruction actually works. This
 * script is that next, real test: it creates a throwaway Token-2022
 * test mint (NOT real ACT -- ACT only exists on mainnet), then calls
 * initialize_config against the deployed act-staking program on devnet,
 * then reads back the resulting StakeConfig account and checks every
 * field matches what was sent, rather than just checking the
 * transaction didn't error.
 *
 * No Anchor CLI/IDL is used here -- the instruction is hand-built
 * (8-byte sighash discriminator + borsh-encoded fixed-size arrays) to
 * match programs/act-staking/src/lib.rs exactly, since neither anchor
 * CLI nor a generated IDL exists in this environment. If the account
 * layout in lib.rs ever changes, this script's manual offsets must be
 * updated to match -- they are not derived from a shared source of
 * truth.
 *
 * Run: node scripts/init-devnet-config.mjs
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
  createMint,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import fs from "node:fs";
import crypto from "node:crypto";

const PROGRAM_ID = new PublicKey("DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH");
const DEPLOYER_KEYPAIR_PATH =
  "C:/Users/USER PC/AppData/Local/Temp/claude-devnet-deployer/deployer.json";
const RPC_URL = "https://api.devnet.solana.com";

function loadKeypair(path) {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

// Anchor instruction discriminator: first 8 bytes of sha256("global:<name>")
function discriminator(name) {
  const hash = crypto.createHash("sha256").update(`global:${name}`).digest();
  return hash.subarray(0, 8);
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

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const deployer = loadKeypair(DEPLOYER_KEYPAIR_PATH);
  console.log("Deployer:", deployer.publicKey.toBase58());

  const balance = await connection.getBalance(deployer.publicKey);
  console.log("Balance:", balance / 1e9, "SOL");

  // 1. Create a throwaway devnet Token-2022 test mint. NOT real ACT --
  //    ACT only exists on mainnet. This is purely to exercise the
  //    program's token_interface CPI logic against a real Token-2022
  //    mint on devnet.
  console.log("\nCreating test Token-2022 mint...");
  const testMint = await createMint(
    connection,
    deployer,
    deployer.publicKey, // mint authority
    null, // freeze authority
    9, // decimals
    undefined,
    undefined,
    TOKEN_2022_PROGRAM_ID
  );
  console.log("Test mint:", testMint.toBase58());

  // 2. Derive PDAs matching programs/act-staking/src/lib.rs exactly.
  const [configPda, configBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID
  );
  const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority")],
    PROGRAM_ID
  );
  const vaultAta = getAssociatedTokenAddressSync(
    testMint,
    vaultAuthorityPda,
    true, // allowOwnerOffCurve -- vaultAuthorityPda is a PDA
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  console.log("Config PDA:", configPda.toBase58());
  console.log("Vault authority PDA:", vaultAuthorityPda.toBase58());
  console.log("Vault ATA (to be created by the program):", vaultAta.toBase58());

  // 3. Build the initialize_config instruction.
  //    Args: tiers: [u64; 5], duration_days: [u16; 4], duration_multiplier: [u16; 4]
  //    Fixed-size Rust arrays borsh-encode with NO length prefix.
  //
  //    IMPORTANT: CAS (and therefore these thresholds) operates on raw
  //    base units, not whole tokens. STAKING_DESIGN.md's table states
  //    thresholds like "1,000,000" meaning 1,000,000 whole ACT (9
  //    decimals) -- scale by 10^9 here or every stake instantly maxes
  //    out the top tier. Confirmed the hard way: the very first devnet
  //    initialize_config call used the unscaled numbers directly, and
  //    stake-unstake-devnet-test.mjs caught it staking a mere 2 tokens
  //    straight to tier 4. Fixed on devnet via
  //    fix-tier-thresholds-devnet.mjs; fixed here so a future fresh
  //    initialize_config doesn't repeat it.
  const tiers = [0, 1_000_000, 5_000_000, 20_000_000, 75_000_000].map((t) => t * 1_000_000_000);
  const durationDays = [30, 90, 180, 365];
  const durationMultiplier = [100, 130, 175, 260];

  const data = Buffer.concat([
    discriminator("initialize_config"),
    ...tiers.map(u64le),
    ...durationDays.map(u16le),
    ...durationMultiplier.map(u16le),
  ]);

  const keys = [
    { pubkey: deployer.publicKey, isSigner: true, isWritable: true }, // authority
    { pubkey: configPda, isSigner: false, isWritable: true }, // config
    { pubkey: vaultAuthorityPda, isSigner: false, isWritable: false }, // vault_authority
    { pubkey: testMint, isSigner: false, isWritable: false }, // mint
    { pubkey: vaultAta, isSigner: false, isWritable: true }, // vault
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // associated_token_program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
  ];

  const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
  const tx = new Transaction().add(ix);

  console.log("\nSending initialize_config...");
  const sig = await sendAndConfirmTransaction(connection, tx, [deployer], {
    commitment: "confirmed",
  });
  console.log("Signature:", sig);
  console.log(`Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  // 4. Read back the StakeConfig account and decode it manually
  //    (offsets matching the Rust struct field order exactly), rather
  //    than trusting the transaction's lack of an error.
  console.log("\nReading back the StakeConfig account...");
  const accountInfo = await connection.getAccountInfo(configPda);
  if (!accountInfo) throw new Error("config account not found after initialize_config");

  const buf = accountInfo.data;
  let offset = 8; // anchor account discriminator
  const authority = new PublicKey(buf.subarray(offset, offset + 32)); offset += 32;
  const mint = new PublicKey(buf.subarray(offset, offset + 32)); offset += 32;
  const vault = new PublicKey(buf.subarray(offset, offset + 32)); offset += 32;
  const totalStaked = buf.readBigUInt64LE(offset); offset += 8;
  const readTiers = [];
  for (let i = 0; i < 5; i++) { readTiers.push(buf.readBigUInt64LE(offset)); offset += 8; }
  const readDurationDays = [];
  for (let i = 0; i < 4; i++) { readDurationDays.push(buf.readUInt16LE(offset)); offset += 2; }
  const readDurationMultiplier = [];
  for (let i = 0; i < 4; i++) { readDurationMultiplier.push(buf.readUInt16LE(offset)); offset += 2; }
  const paused = buf.readUInt8(offset); offset += 1;
  const bump = buf.readUInt8(offset); offset += 1;
  const vaultAuthorityBump = buf.readUInt8(offset); offset += 1;

  const decoded = {
    authority: authority.toBase58(),
    mint: mint.toBase58(),
    vault: vault.toBase58(),
    totalStaked: totalStaked.toString(),
    tiers: readTiers.map(String),
    durationDays: readDurationDays,
    durationMultiplier: readDurationMultiplier,
    paused: !!paused,
    bump,
    vaultAuthorityBump,
  };
  console.log(JSON.stringify(decoded, null, 2));

  // 5. Actually check it, don't just print it.
  const checks = [
    ["authority matches deployer", decoded.authority === deployer.publicKey.toBase58()],
    ["mint matches test mint", decoded.mint === testMint.toBase58()],
    ["vault matches derived ATA", decoded.vault === vaultAta.toBase58()],
    ["totalStaked is 0", decoded.totalStaked === "0"],
    ["tiers match", JSON.stringify(decoded.tiers) === JSON.stringify(tiers.map(String))],
    ["durationDays match", JSON.stringify(decoded.durationDays) === JSON.stringify(durationDays)],
    ["durationMultiplier match", JSON.stringify(decoded.durationMultiplier) === JSON.stringify(durationMultiplier)],
    ["paused is false", decoded.paused === false],
    ["config bump matches derivation", decoded.bump === configBump],
  ];
  console.log("\nChecks:");
  let allPassed = true;
  for (const [label, passed] of checks) {
    console.log(`  ${passed ? "PASS" : "FAIL"} - ${label}`);
    if (!passed) allPassed = false;
  }
  if (!allPassed) {
    console.error("\nAt least one check failed -- initialize_config did not behave as expected.");
    process.exit(1);
  }
  console.log("\nAll checks passed. initialize_config works as designed on devnet.");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
