#!/usr/bin/env node
/**
 * Follow-up to simulate-mainnet-raydium-real-act.mjs, now that the real
 * Squads vault actually holds real USDC (4 USDC, sent by the user
 * specifically to clear the gap the first simulation stopped on) and a
 * small amount of SOL for rent. This re-simulates the exact real
 * createPool instruction with the REAL amounts intended for the actual
 * proposal (400 ACT : 4 USDC -- "just enough to clear the gap", not a
 * real liquidity target), to confirm the full instruction -- including
 * whatever happens on the USDC leg and LP-account creation, which the
 * first simulation never reached -- succeeds end-to-end before anything
 * is ever proposed for real Squads execution.
 *
 * SAFETY: read-only. Never sends a transaction, never signs anything,
 * never spends real funds. Same pattern as
 * simulate-mainnet-raydium-real-act.mjs: `connection.simulateTransaction`
 * with no signers, fee payer set to the real (unsigned) Squads vault
 * pubkey.
 *
 * Run: node scripts/simulate-mainnet-raydium-real-act-final.mjs
 */

import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import BN from "bn.js";
import {
  CREATE_CPMM_POOL_PROGRAM,
  CREATE_CPMM_POOL_FEE_ACC,
  makeCreateCpmmPoolInInstruction,
  getCreatePoolKeys,
} from "@raydium-io/raydium-sdk-v2";

const MAINNET_RPC_URL = "https://api.mainnet-beta.solana.com";
const REAL_ACT_MINT = new PublicKey("7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG");
const REAL_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const REAL_SQUADS_VAULT = new PublicKey("GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MAINNET_CPMM_CONFIG_0 = new PublicKey("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2");

// The real amounts intended for the actual proposal -- just enough to
// clear the "vault has zero USDC" gap, not a real liquidity target.
const ACT_AMOUNT = new BN(400).mul(new BN(10).pow(new BN(9))); // 400 ACT (9 decimals)
const USDC_AMOUNT = new BN(4).mul(new BN(10).pow(new BN(6))); // 4 USDC (6 decimals)

async function main() {
  const connection = new Connection(MAINNET_RPC_URL, "confirmed");

  const vaultActAta = getAssociatedTokenAddressSync(REAL_ACT_MINT, REAL_SQUADS_VAULT, true, TOKEN_2022_PROGRAM_ID);
  const vaultUsdcAta = getAssociatedTokenAddressSync(REAL_USDC_MINT, REAL_SQUADS_VAULT, true, TOKEN_PROGRAM_ID);

  const [actBal, usdcBal] = await Promise.all([
    getAccount(connection, vaultActAta, "confirmed", TOKEN_2022_PROGRAM_ID),
    getAccount(connection, vaultUsdcAta, "confirmed", TOKEN_PROGRAM_ID),
  ]);
  console.log("Vault real ACT balance:", (Number(actBal.amount) / 1e9).toLocaleString(), "ACT");
  console.log("Vault real USDC balance:", Number(usdcBal.amount) / 1e6, "USDC");
  console.log("Vault real SOL balance:", (await connection.getBalance(REAL_SQUADS_VAULT)) / 1e9, "SOL");

  if (BigInt(usdcBal.amount) < BigInt(USDC_AMOUNT.toString())) {
    throw new Error(`Vault USDC balance (${usdcBal.amount}) is less than the intended ${USDC_AMOUNT.toString()} raw units.`);
  }

  const poolKeys = getCreatePoolKeys({
    programId: CREATE_CPMM_POOL_PROGRAM,
    configId: MAINNET_CPMM_CONFIG_0,
    mintA: REAL_ACT_MINT,
    mintB: REAL_USDC_MINT,
  });
  console.log("\nDerived pool address:", poolKeys.poolId.toBase58());
  console.log("Derived LP mint:", poolKeys.lpMint.toBase58());

  const userLpAccount = getAssociatedTokenAddressSync(poolKeys.lpMint, REAL_SQUADS_VAULT, true);

  const ix = makeCreateCpmmPoolInInstruction(
    CREATE_CPMM_POOL_PROGRAM,
    REAL_SQUADS_VAULT,
    MAINNET_CPMM_CONFIG_0,
    poolKeys.authority,
    poolKeys.poolId,
    REAL_ACT_MINT,
    REAL_USDC_MINT,
    poolKeys.lpMint,
    vaultActAta,
    vaultUsdcAta,
    userLpAccount,
    poolKeys.vaultA,
    poolKeys.vaultB,
    CREATE_CPMM_POOL_FEE_ACC,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    poolKeys.observationId,
    ACT_AMOUNT,
    USDC_AMOUNT,
    new BN(0),
    [REAL_ACT_MINT]
  );

  const transaction = new Transaction().add(ix);
  transaction.feePayer = REAL_SQUADS_VAULT;

  console.log("\nSimulating the REAL createPool instruction (400 ACT : 4 USDC) against real mainnet state...");
  const sim = await connection.simulateTransaction(transaction);

  console.log("\n=== Simulation result ===");
  console.log("Error:", sim.value.err ? JSON.stringify(sim.value.err) : "none (would succeed)");
  console.log("\nLogs:");
  (sim.value.logs || []).forEach((l) => console.log(" ", l));

  console.log("\n=== Conclusion ===");
  if (!sim.value.err) {
    console.log("SUCCESS: the real createPool instruction (400 ACT : 4 USDC) simulates cleanly end-to-end against real mainnet state -- including the real USDC transfer and LP-account handling this earlier simulation never reached.");
    console.log("This instruction is now ready to be proposed for real Squads execution.");
  } else {
    const logsText = (sim.value.logs || []).join("\n");
    const lamportsMatch = logsText.match(/insufficient lamports (\d+), need (\d+)/);
    if (lamportsMatch) {
      const have = Number(lamportsMatch[1]);
      const need = Number(lamportsMatch[2]);
      console.log(`Stopped on insufficient SOL for rent: has ${(have / 1e9).toFixed(6)} SOL, needs ${(need / 1e9).toFixed(6)} SOL for the next account this instruction creates.`);
    } else {
      console.log("Did not simulate cleanly -- see logs above for the real reason before proposing anything.");
      process.exit(1);
    }
  }
  console.log("\nAccounts for the real instruction (for a Squads Transaction Builder / raw-instruction proposal):");
  console.log("Program ID:", CREATE_CPMM_POOL_PROGRAM.toBase58());
  ix.keys.forEach((k, i) => {
    console.log(`  [${i}] ${k.pubkey.toBase58()}  signer=${k.isSigner}  writable=${k.isWritable}`);
  });
  console.log("Instruction data (base64):", ix.data.toString("base64"));
  console.log("Instruction data (hex):", ix.data.toString("hex"));
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
