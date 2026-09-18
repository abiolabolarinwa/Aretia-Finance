#!/usr/bin/env node
/**
 * PRESALE_DESIGN.md follow-up -- simulate (never send) a real-ACT pool
 * creation on MAINNET, to check the one thing devnet testing couldn't:
 * whether the real ACT mint's extra `MetadataPointer` extension (not
 * present on the devnet test-ACT mint used everywhere else in this
 * repo's AMM proofs) causes any AMM SDK/program to behave differently.
 *
 * SAFETY: this NEVER sends a transaction and NEVER spends real funds.
 * It hand-builds a real Raydium CPMM createPool instruction (using the
 * SDK's low-level `makeCreateCpmmPoolInInstruction`, not the high-level
 * `raydium.cpmm.createPool` convenience wrapper -- that wrapper does a
 * client-side check requiring the owner to already hold both tokens,
 * which the real Squads vault fails for USDC even though this is a
 * pure simulation and no USDC would actually be needed to observe the
 * ACT-specific behavior) against real mainnet state (the real ACT
 * mint, real USDC, the real deployed Raydium program) and only calls
 * `connection.simulateTransaction` with `sigVerify: false` -- nothing
 * is broadcast, nothing is persisted, no private key is used or
 * needed.
 *
 * The "creator" for instruction-building purposes is the real Squads
 * treasury vault (GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA) --
 * confirmed via a live mainnet RPC query to hold the entire real
 * 1,000,000,000 ACT supply (but, also confirmed, no real USDC at all
 * -- so this simulation is expected to reveal whatever the vault's
 * real balances actually allow, which is itself the honest result).
 * This script only ever reads that vault's public key; it has no
 * signing capability over it and none is used.
 *
 * Run: node scripts/simulate-mainnet-raydium-real-act.mjs
 */

import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
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
// Standard 0.25% fee-tier config, confirmed live on mainnet.
const MAINNET_CPMM_CONFIG_0 = new PublicKey("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2");

async function main() {
  const connection = new Connection(MAINNET_RPC_URL, "confirmed");

  console.log("Confirming the real Squads vault's real ACT balance (read-only)...");
  const vaultActAta = getAssociatedTokenAddressSync(REAL_ACT_MINT, REAL_SQUADS_VAULT, true, TOKEN_2022_PROGRAM_ID);
  const vaultAccount = await getAccount(connection, vaultActAta, "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log(
    "Real Squads vault ACT balance:",
    vaultAccount.amount.toString(),
    "raw units (",
    (Number(vaultAccount.amount) / 1e9).toLocaleString(),
    "ACT )"
  );

  const vaultUsdcAta = getAssociatedTokenAddressSync(REAL_USDC_MINT, REAL_SQUADS_VAULT, true, TOKEN_PROGRAM_ID);
  let vaultUsdcBalance = "0 (account does not exist)";
  try {
    const usdcAccount = await getAccount(connection, vaultUsdcAta, "confirmed", TOKEN_PROGRAM_ID);
    vaultUsdcBalance = usdcAccount.amount.toString();
  } catch {
    // expected -- confirmed below in the printed note
  }
  console.log("Real Squads vault USDC balance:", vaultUsdcBalance);

  const poolKeys = getCreatePoolKeys({
    programId: CREATE_CPMM_POOL_PROGRAM,
    configId: MAINNET_CPMM_CONFIG_0,
    mintA: REAL_ACT_MINT,
    mintB: REAL_USDC_MINT,
  });
  console.log("\nDerived pool address:", poolKeys.poolId.toBase58());

  const ix = makeCreateCpmmPoolInInstruction(
    CREATE_CPMM_POOL_PROGRAM,
    REAL_SQUADS_VAULT, // creator
    MAINNET_CPMM_CONFIG_0,
    poolKeys.authority,
    poolKeys.poolId,
    REAL_ACT_MINT,
    REAL_USDC_MINT,
    poolKeys.lpMint,
    vaultActAta, // userVaultA
    vaultUsdcAta, // userVaultB
    getAssociatedTokenAddressSync(poolKeys.lpMint, REAL_SQUADS_VAULT, true), // userLpAccount
    poolKeys.vaultA,
    poolKeys.vaultB,
    CREATE_CPMM_POOL_FEE_ACC,
    TOKEN_2022_PROGRAM_ID, // mintProgramA
    TOKEN_PROGRAM_ID, // mintProgramB
    poolKeys.observationId,
    new BN(1_000).mul(new BN(10).pow(new BN(9))), // 1000 ACT, notional only -- never sent
    new BN(10).mul(new BN(10).pow(new BN(6))), // 10 USDC, notional only -- never sent
    new BN(0), // openTime: immediate
    [REAL_ACT_MINT] // supperMintEx: mints needing Token-2022 extension support accounts
  );

  // The real Squads vault has no USDC ATA on-chain -- bundle its
  // creation into the SAME simulated (never-sent) transaction, purely so
  // the simulation can get past that unrelated gap and actually
  // exercise the pool-creation logic for the ACT side, rather than
  // stopping at "USDC account doesn't exist" before reaching it. This
  // costs nothing: simulation never persists anything, and no SOL is
  // ever actually spent on rent.
  const createUsdcAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    REAL_SQUADS_VAULT,
    vaultUsdcAta,
    REAL_SQUADS_VAULT,
    REAL_USDC_MINT,
    TOKEN_PROGRAM_ID
  );

  const transaction = new Transaction().add(createUsdcAtaIx).add(ix);
  transaction.feePayer = REAL_SQUADS_VAULT;

  console.log("\nSimulating against real mainnet state (no transaction will be sent)...");
  // Legacy Transaction.simulateTransaction takes a signers ARRAY as its
  // second argument, not a config object (that config-object overload is
  // only for VersionedTransaction) -- omitting it entirely is exactly
  // what we want: no signers means no signing attempt, and the
  // underlying RPC method's own `sigVerify` default is already false.
  const sim = await connection.simulateTransaction(transaction);

  console.log("\n=== Simulation result ===");
  console.log("Error:", sim.value.err ? JSON.stringify(sim.value.err) : "none (would succeed)");
  console.log("\nLogs:");
  (sim.value.logs || []).forEach((l) => console.log(" ", l));

  console.log("\n=== Conclusion ===");
  const logsText = (sim.value.logs || []).join("\n");
  const lamportsMatch = logsText.match(/insufficient lamports (\d+), need (\d+)/);
  if (!sim.value.err) {
    console.log("The real-ACT pool-creation instruction simulated successfully against real mainnet state, including the real ACT mint's MetadataPointer extension (not present on the devnet test-ACT mint used elsewhere in this repo).");
    console.log("This is the strongest confirmation possible without actually spending funds: Raydium's CPMM pool-creation logic is fully compatible with the real ACT mint's exact extension set.");
  } else if (lamportsMatch) {
    const have = Number(lamportsMatch[1]);
    const need = Number(lamportsMatch[2]);
    const shortfallSol = (need - have) / 1e9;
    console.log(
      `The simulation stopped on the real Squads vault's real SOL balance being too low to pay rent for the next account this instruction needs to create ` +
      `(has ${(have / 1e9).toFixed(6)} SOL, needs ${(need / 1e9).toFixed(6)} SOL here -- short by ~${shortfallSol.toFixed(6)} SOL) -- ` +
      `a genuine, unrelated real-world funding fact about that wallet, not anything about ACT or Token-2022.`
    );
    console.log("Raydium CPMM's createPool instruction creates several accounts (pool state, LP mint, observation state, two token vaults) in sequence, each needing its own rent -- this may not be the last such shortfall even after topping up by exactly this amount.");
    console.log("This is the natural stopping point for a simulate-only, no-real-funds check: getting further would mean actually sending more real SOL to that vault. Nothing observed so far, across all instructions that DID execute, indicates any ACT-specific (TransferFeeConfig + MetadataPointer) incompatibility.");
  } else {
    console.log("The real-ACT pool-creation instruction did NOT simulate cleanly, and not for an obviously funding-related reason. This is a real finding -- see logs above.");
    process.exit(1);
  }
  console.log("\nNo funds were spent or moved. No transaction was sent. This was a read-only simulation only.");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
