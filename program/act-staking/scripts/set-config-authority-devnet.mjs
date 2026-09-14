#!/usr/bin/env node
/**
 * act-staking -- exercise the new set_config_authority instruction
 * ---------------------------------------------------------------------
 * Two purposes at once: (1) this is the real migration this program
 * always needed -- StakeConfig.authority has sat on a throwaway devnet
 * deployer key since initialize_config was first called, with no
 * instruction able to move it until this upgrade added one; (2) calling
 * it for real, and reading the config back afterward, is the strongest
 * possible proof the just-deployed upgrade actually contains the new
 * code, stronger than comparing ProgramData byte lengths (which can
 * legitimately not match the local .so 1:1 -- the CLI is free to
 * over-allocate the account for future upgrade headroom).
 *
 * Signed by the CURRENT authority (the throwaway deployer), migrating
 * to the dedicated devnet-upgrade-authority keypair -- the same key
 * that already holds this program's upgrade authority, so devnet
 * iteration answers to one durable key instead of two different ones.
 *
 * No Anchor CLI/IDL in this environment -- hand-built instruction
 * (8-byte sighash + borsh args) matching lib.rs exactly, same
 * convention as every other script in this directory.
 *
 * Run: node scripts/set-config-authority-devnet.mjs
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "node:fs";
import crypto from "node:crypto";

const PROGRAM_ID = new PublicKey("DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH");
const DEPLOYER_KEYPAIR_PATH =
  "C:/Users/USER PC/AppData/Local/Temp/claude-devnet-deployer/deployer.json";
const NEW_AUTHORITY_KEYPAIR_PATH =
  "C:/Users/USER PC/OneDrive - Furst Peak Solutions/My Stuff/Folders/2026/Aretia Climate App/aretia-finance/program/act-staking/devnet-upgrade-authority-keypair.json";
const RPC_URL = "https://api.devnet.solana.com";

function loadKeypair(path) {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

function discriminator(name) {
  const hash = crypto.createHash("sha256").update(`global:${name}`).digest();
  return hash.subarray(0, 8);
}

function decodeConfig(buf) {
  let offset = 8; // anchor account discriminator
  const authority = new PublicKey(buf.subarray(offset, offset + 32)); offset += 32;
  const mint = new PublicKey(buf.subarray(offset, offset + 32)); offset += 32;
  const vault = new PublicKey(buf.subarray(offset, offset + 32)); offset += 32;
  const totalStaked = buf.readBigUInt64LE(offset); offset += 8;
  const tiers = [];
  for (let i = 0; i < 5; i++) { tiers.push(buf.readBigUInt64LE(offset)); offset += 8; }
  const durationDays = [];
  for (let i = 0; i < 4; i++) { durationDays.push(buf.readUInt16LE(offset)); offset += 2; }
  const durationMultiplier = [];
  for (let i = 0; i < 4; i++) { durationMultiplier.push(buf.readUInt16LE(offset)); offset += 2; }
  const paused = !!buf.readUInt8(offset); offset += 1;
  const bump = buf.readUInt8(offset); offset += 1;
  return { authority: authority.toBase58(), mint: mint.toBase58(), vault: vault.toBase58(), totalStaked: totalStaked.toString(), tiers: tiers.map(String), durationDays, durationMultiplier, paused, bump };
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const deployer = loadKeypair(DEPLOYER_KEYPAIR_PATH);
  const newAuthority = loadKeypair(NEW_AUTHORITY_KEYPAIR_PATH);
  console.log("Current authority (signer):", deployer.publicKey.toBase58());
  console.log("New authority:", newAuthority.publicKey.toBase58());

  const [configPda, configBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID
  );
  console.log("Config PDA:", configPda.toBase58());

  const before = await connection.getAccountInfo(configPda);
  if (!before) throw new Error("config account not found -- has initialize_config been run?");
  const beforeDecoded = decodeConfig(before.data);
  console.log("\nConfig authority before:", beforeDecoded.authority);
  if (beforeDecoded.authority !== deployer.publicKey.toBase58()) {
    throw new Error(
      `Refusing to proceed: on-chain config.authority (${beforeDecoded.authority}) does not match the deployer keypair being used as signer (${deployer.publicKey.toBase58()}). Wrong keypair, or authority already migrated.`
    );
  }

  const data = Buffer.concat([
    discriminator("set_config_authority"),
    newAuthority.publicKey.toBuffer(), // Pubkey arg, fixed 32 bytes, no length prefix
  ]);

  const keys = [
    { pubkey: configPda, isSigner: false, isWritable: true }, // config
    { pubkey: deployer.publicKey, isSigner: true, isWritable: false }, // authority (current)
  ];

  const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
  const tx = new Transaction().add(ix);

  console.log("\nSending set_config_authority...");
  const sig = await sendAndConfirmTransaction(connection, tx, [deployer], {
    commitment: "confirmed",
  });
  console.log("Signature:", sig);
  console.log(`Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  console.log("\nReading back the StakeConfig account...");
  const after = await connection.getAccountInfo(configPda);
  const afterDecoded = decodeConfig(after.data);
  console.log(JSON.stringify(afterDecoded, null, 2));

  const checks = [
    ["authority now matches new key", afterDecoded.authority === newAuthority.publicKey.toBase58()],
    ["authority no longer the old deployer key", afterDecoded.authority !== deployer.publicKey.toBase58()],
    ["mint unchanged", afterDecoded.mint === beforeDecoded.mint],
    ["vault unchanged", afterDecoded.vault === beforeDecoded.vault],
    ["totalStaked unchanged", afterDecoded.totalStaked === beforeDecoded.totalStaked],
    ["tiers unchanged", JSON.stringify(afterDecoded.tiers) === JSON.stringify(beforeDecoded.tiers)],
    ["paused unchanged", afterDecoded.paused === beforeDecoded.paused],
    ["bump unchanged", afterDecoded.bump === beforeDecoded.bump],
    ["config bump matches derivation", afterDecoded.bump === configBump],
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
  console.log("\nAll checks passed. set_config_authority works on devnet, and this also proves the just-deployed upgrade is the new code (this instruction did not exist in the previous binary).");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
