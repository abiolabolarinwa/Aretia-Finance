#!/usr/bin/env node
/**
 * act-presale -- devnet test-token setup
 * ---------------------------------------------------------------------
 * Creates three THROWAWAY devnet mints that stand in for the real
 * mainnet-only ACT/USDC/USDT so the presale program can be exercised
 * end to end without touching anything real:
 *
 *   - test-ACT: Token-2022 with a TransferFeeConfig extension set to
 *     350 bps (3.5%), matching real ACT's live mainnet configuration
 *     exactly, so the gross-up math (`grossed_up_amount` in lib.rs)
 *     actually gets exercised against real fee-withholding behavior,
 *     not a mint that happens not to have the extension at all.
 *   - test-USDC / test-USDT: plain SPL Token (Token program, not
 *     Token-2022), 6 decimals, no fee -- matching real USDC/USDT.
 *
 * Also creates three treasury ATAs (one per test mint) owned by the
 * REAL mainnet Squads treasury vault address
 * (GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA), per the instruction
 * to wire the presale's treasury destinations to the real multisig.
 * That address has no signing authority on devnet (the real Squads
 * multisig only exists as such on mainnet), so nothing can ever be
 * *spent* from these devnet treasury ATAs -- that's fine, this test
 * only needs to prove `finalize`/`sweep_unsold_act` send funds to the
 * *correct address*, not that devnet can spend from it afterward.
 *
 * Run: node scripts/setup-devnet-tokens.mjs
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ExtensionType,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createMint,
  getMintLen,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import fs from "node:fs";

const RPC_URL = "https://api.devnet.solana.com";
const DEPLOYER_KEYPAIR_PATH =
  "C:/Users/USER PC/OneDrive - Furst Peak Solutions/My Stuff/Folders/2026/Aretia Climate App/aretia-finance/devnet/deployer-keypair.json";

// The REAL mainnet Squads treasury vault -- fee-config-authority and
// withdraw-withheld-authority on the real ACT mint, and the address that
// holds the real treasury's ACT/fee balances. Used here as-is (no devnet
// substitute) per the instruction to wire treasury accounts to the real
// multisig, even though it can't sign anything on this cluster.
const REAL_TREASURY_VAULT = new PublicKey(
  "GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA"
);

function loadKeypair(path) {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

async function createToken2022MintWithFee(connection, payer, decimals, feeBasisPoints) {
  const mintKeypair = Keypair.generate();
  const extensions = [ExtensionType.TransferFeeConfig];
  const mintLen = getMintLen(extensions);
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      lamports,
      space: mintLen,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeTransferFeeConfigInstruction(
      mintKeypair.publicKey,
      payer.publicKey, // transferFeeConfigAuthority
      payer.publicKey, // withdrawWithheldAuthority
      feeBasisPoints,
      BigInt("18446744073709551615"), // maxFee = u64::MAX, matches real ACT (uncapped)
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      decimals,
      payer.publicKey,
      null,
      TOKEN_2022_PROGRAM_ID
    )
  );

  await sendAndConfirmTransaction(connection, tx, [payer, mintKeypair], {
    commitment: "confirmed",
  });
  return mintKeypair.publicKey;
}

async function createPlainMint(connection, payer, decimals) {
  return createMint(connection, payer, payer.publicKey, null, decimals, undefined, {
    commitment: "confirmed",
  });
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadKeypair(DEPLOYER_KEYPAIR_PATH);
  console.log("Deployer:", payer.publicKey.toBase58());

  console.log("\nCreating test-ACT (Token-2022, 350 bps fee, 9 decimals)...");
  const testActMint = await createToken2022MintWithFee(connection, payer, 9, 350);
  console.log("test-ACT mint:", testActMint.toBase58());

  console.log("\nCreating test-USDC (plain SPL Token, 6 decimals)...");
  const testUsdcMint = await createPlainMint(connection, payer, 6);
  console.log("test-USDC mint:", testUsdcMint.toBase58());

  console.log("\nCreating test-USDT (plain SPL Token, 6 decimals)...");
  const testUsdtMint = await createPlainMint(connection, payer, 6);
  console.log("test-USDT mint:", testUsdtMint.toBase58());

  console.log("\nCreating treasury ATAs owned by the real Squads vault", REAL_TREASURY_VAULT.toBase58(), "...");
  const treasuryActAta = getAssociatedTokenAddressSync(
    testActMint,
    REAL_TREASURY_VAULT,
    true,
    TOKEN_2022_PROGRAM_ID
  );
  const treasuryUsdcAta = getAssociatedTokenAddressSync(testUsdcMint, REAL_TREASURY_VAULT, true);
  const treasuryUsdtAta = getAssociatedTokenAddressSync(testUsdtMint, REAL_TREASURY_VAULT, true);

  const ataTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      treasuryActAta,
      REAL_TREASURY_VAULT,
      testActMint,
      TOKEN_2022_PROGRAM_ID
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      treasuryUsdcAta,
      REAL_TREASURY_VAULT,
      testUsdcMint,
      TOKEN_PROGRAM_ID
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      treasuryUsdtAta,
      REAL_TREASURY_VAULT,
      testUsdtMint,
      TOKEN_PROGRAM_ID
    )
  );
  await sendAndConfirmTransaction(connection, ataTx, [payer], { commitment: "confirmed" });
  console.log("treasury_act_account:", treasuryActAta.toBase58());
  console.log("treasury_usdc_account:", treasuryUsdcAta.toBase58());
  console.log("treasury_usdt_account:", treasuryUsdtAta.toBase58());

  console.log("\nMinting test supply to the deployer (source for fund_act_reserve, and buyer test funds)...");
  const deployerActAta = getAssociatedTokenAddressSync(
    testActMint,
    payer.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  const deployerUsdcAta = getAssociatedTokenAddressSync(testUsdcMint, payer.publicKey);
  const deployerUsdtAta = getAssociatedTokenAddressSync(testUsdtMint, payer.publicKey);

  const deployerAtaTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      deployerActAta,
      payer.publicKey,
      testActMint,
      TOKEN_2022_PROGRAM_ID
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      deployerUsdcAta,
      payer.publicKey,
      testUsdcMint,
      TOKEN_PROGRAM_ID
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      deployerUsdtAta,
      payer.publicKey,
      testUsdtMint,
      TOKEN_PROGRAM_ID
    )
  );
  await sendAndConfirmTransaction(connection, deployerAtaTx, [payer], { commitment: "confirmed" });

  // 200,000,000 test-ACT (9 decimals) -- enough to fund the vault per the
  // two-hop gross-up math (~107.4M needed) with headroom.
  await mintTo(
    connection,
    payer,
    testActMint,
    deployerActAta,
    payer,
    200_000_000n * 10n ** 9n,
    [],
    { commitment: "confirmed" },
    TOKEN_2022_PROGRAM_ID
  );
  // 50,000 test-USDC / test-USDT (6 decimals) each -- enough for several
  // test buys up to the $10,000 max.
  await mintTo(
    connection,
    payer,
    testUsdcMint,
    deployerUsdcAta,
    payer,
    50_000n * 10n ** 6n,
    [],
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID
  );
  await mintTo(
    connection,
    payer,
    testUsdtMint,
    deployerUsdtAta,
    payer,
    50_000n * 10n ** 6n,
    [],
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID
  );
  console.log("Minted test-ACT/test-USDC/test-USDT to the deployer.");

  const out = {
    testActMint: testActMint.toBase58(),
    testUsdcMint: testUsdcMint.toBase58(),
    testUsdtMint: testUsdtMint.toBase58(),
    treasuryVault: REAL_TREASURY_VAULT.toBase58(),
    treasuryActAta: treasuryActAta.toBase58(),
    treasuryUsdcAta: treasuryUsdcAta.toBase58(),
    treasuryUsdtAta: treasuryUsdtAta.toBase58(),
    deployerActAta: deployerActAta.toBase58(),
    deployerUsdcAta: deployerUsdcAta.toBase58(),
    deployerUsdtAta: deployerUsdtAta.toBase58(),
  };
  fs.writeFileSync(
    new URL("./devnet-test-tokens.json", import.meta.url),
    JSON.stringify(out, null, 2)
  );
  console.log("\nWrote scripts/devnet-test-tokens.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
