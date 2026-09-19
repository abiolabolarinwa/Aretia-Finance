#!/usr/bin/env node
/**
 * act-staking -- fix the tier-threshold unit-scale bug on devnet
 * ---------------------------------------------------------------------
 * init-devnet-config.mjs set tiers = [0, 1e6, 5e6, 2e7, 7.5e7], copying
 * STAKING_DESIGN.md's numbers directly. Those numbers were written to
 * mean whole-ACT-token amounts (e.g. "1,000,000 ACT = 0.10% of supply"),
 * but the program's CAS formula operates on raw base units (9 decimals),
 * so the config as originally set made any stake over 0.075 tokens
 * instantly max out at tier 4. Confirmed empirically by
 * stake-unstake-devnet-test.mjs.
 *
 * This calls update_tier_config with the same thresholds scaled by 1e9
 * to match base units. This is exactly the governance path
 * STAKING_DESIGN.md describes for recalibrating these numbers without a
 * redeploy -- using it to fix a units bug, not to change the design.
 *
 * Run: node scripts/fix-tier-thresholds-devnet.mjs
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
import os from "node:os";
import crypto from "node:crypto";

const PROGRAM_ID = new PublicKey("DpaKPgqdcoY2pQFrHc5xgP4eegbnaCWuRVYFMrrzThtH");
const DEPLOYER_KEYPAIR_PATH =
  path.join(os.tmpdir(), "aretia-devnet-deployer", "deployer.json");
const RPC_URL = "https://api.devnet.solana.com";
const DECIMALS_SCALE = 1_000_000_000n; // 9 decimals, matching this test mint and real ACT

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

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair(DEPLOYER_KEYPAIR_PATH); // config.authority is this deployer, per initialize_config
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);

  const tiersWholeTokens = [0n, 1_000_000n, 5_000_000n, 20_000_000n, 75_000_000n];
  const tiersBaseUnits = tiersWholeTokens.map((t) => t * DECIMALS_SCALE);
  const durationDays = [30, 90, 180, 365];
  const durationMultiplier = [100, 130, 175, 260];

  console.log("Old (buggy) tiers, as stored:", [0, 1_000_000, 5_000_000, 20_000_000, 75_000_000]);
  console.log("New tiers (base units):", tiersBaseUnits.map(String));

  const data = Buffer.concat([
    discriminator("update_tier_config"),
    ...tiersBaseUnits.map(u64le),
    ...durationDays.map(u16le),
    ...durationMultiplier.map(u16le),
  ]);
  const keys = [
    { pubkey: configPda, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: false },
  ];
  const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data });

  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [authority], {
    commitment: "confirmed",
  });
  console.log("Signature:", sig);

  // Verify by reading the config back.
  const info = await connection.getAccountInfo(configPda);
  const buf = info.data;
  let offset = 8 + 32 + 32 + 32 + 8; // discriminator + authority + mint + vault + total_staked
  const readTiers = [];
  for (let i = 0; i < 5; i++) { readTiers.push(buf.readBigUInt64LE(offset)); offset += 8; }
  console.log("Verified on-chain tiers:", readTiers.map(String));

  const matches = readTiers.every((v, i) => v === tiersBaseUnits[i]);
  console.log(matches ? "PASS - tiers updated correctly" : "FAIL - tiers do not match expected values");
  if (!matches) process.exit(1);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
