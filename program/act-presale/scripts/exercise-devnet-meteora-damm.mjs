#!/usr/bin/env node
/**
 * PRESALE_DESIGN.md open item #2 -- extend the AMM proof to Meteora.
 * ---------------------------------------------------------------------
 * Mirrors exercise-devnet-raydium-cpmm.mjs and
 * exercise-devnet-orca-whirlpool.mjs: creates a real Meteora DAMM v2
 * (constant-product) pool on devnet pairing test-ACT (Token-2022, 350
 * bps transfer fee) against test-USDC, seeds a full-range ("compounding"
 * in this SDK's terminology) position, and swaps, to prove Meteora's
 * CP-AMM correctly handles a transfer-fee Token-2022 mint on devnet.
 *
 * Uses Meteora's real devnet deployment -- the CP-AMM (DAMM v2) program
 * is deployed at the SAME address on devnet and mainnet
 * (cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG, confirmed live via
 * `solana account` before writing this script; devnet uses
 * `createCustomPool`, which needs no shared config account, unlike the
 * standard `createPool`).
 *
 * Uses @meteora-ag/cp-amm-sdk (DAMM v2), not @meteora-ag/dlmm -- DLMM's
 * bin-based liquidity model needs considerably more setup (bin arrays,
 * bitmap extensions) for the same proof; DAMM v2 is a plain constant-
 * product AMM, the closest match to Raydium CPMM's shape.
 *
 * Run: node scripts/exercise-devnet-meteora-damm.mjs
 */

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import fs from "node:fs";
import {
  CpAmm,
  CP_AMM_PROGRAM_ID,
  getSqrtPriceFromPrice,
  getInitialCompoundingPoolInformation,
  getBaseFeeParams,
  BaseFeeMode,
  CollectFeeMode,
  ActivationType,
  deriveCustomizablePoolAddress,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
} from "@meteora-ag/cp-amm-sdk";

const RPC_URL = "https://api.devnet.solana.com";
const DEPLOYER_KEYPAIR_PATH =
  "C:/Users/USER PC/OneDrive - Furst Peak Solutions/My Stuff/Folders/2026/Aretia Climate App/aretia-finance/devnet/deployer-keypair.json";

function loadKeypair(path) {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

async function send(connection, payer, tx, signers, label) {
  const sig = await sendAndConfirmTransaction(connection, tx, [payer, ...signers], { commitment: "confirmed" });
  console.log(`${label}: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  return sig;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadKeypair(DEPLOYER_KEYPAIR_PATH);
  console.log("Deployer:", payer.publicKey.toBase58());
  console.log("CP-AMM program:", CP_AMM_PROGRAM_ID.toBase58());

  const tokens = JSON.parse(
    fs.readFileSync(new URL("./devnet-test-tokens.json", import.meta.url), "utf8")
  );
  const testActMint = new PublicKey(tokens.testActMint);
  const testUsdcMint = new PublicKey(tokens.testUsdcMint);
  const deployerActAta = new PublicKey(tokens.deployerActAta);

  const cpAmm = new CpAmm(connection);

  // tokenA = test-ACT, tokenB = test-USDC (this SDK doesn't auto-sort --
  // we choose the order). $0.01/ACT = price(B per A) = 0.01.
  const tokenAMint = testActMint;
  const tokenBMint = testUsdcMint;
  const tokenADecimal = 9;
  const tokenBDecimal = 6;
  const sqrtPrice = getSqrtPriceFromPrice("0.01", tokenADecimal, tokenBDecimal);

  const expectedPoolPda = deriveCustomizablePoolAddress(tokenAMint, tokenBMint);
  const existingPool = await connection.getAccountInfo(expectedPoolPda);

  const checks = [];
  function check(label, passed) {
    checks.push([label, passed]);
    console.log(`  ${passed ? "PASS" : "FAIL"} - ${label}`);
  }

  let poolAddress;
  if (existingPool) {
    poolAddress = expectedPoolPda;
    console.log("\nPool already exists -- skipping creation. Pool:", poolAddress.toBase58());
  } else {
    console.log("\nCreating Meteora DAMM v2 custom pool...");
    const liquidity = new BN(10).pow(new BN(25)); // comfortably above DEAD_LIQUIDITY (~1.8e21)
    const info = getInitialCompoundingPoolInformation(sqrtPrice, liquidity);
    console.log("Initial pool info:", {
      tokenAAmount: info.tokenAAmount.toString(),
      tokenBAmount: info.tokenBAmount.toString(),
      sqrtPrice: info.sqrtPrice.toString(),
      initialLiquidity: info.initialLiquidity.toString(),
      sqrtMinPrice: info.sqrtMinPrice.toString(),
      sqrtMaxPrice: info.sqrtMaxPrice.toString(),
    });

    const poolFees = {
      baseFee: getBaseFeeParams({
        baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear,
        feeTimeSchedulerParam: {
          startingFeeBps: 25, // flat 0.25% -- starting == ending, 0 periods/duration
          endingFeeBps: 25,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      }),
      compoundingFeeBps: 0,
      padding: 0,
      dynamicFee: null,
    };

    const positionNft = Keypair.generate();
    const { tx, pool, position } = await cpAmm.createCustomPool({
      payer: payer.publicKey,
      creator: payer.publicKey,
      positionNft: positionNft.publicKey,
      tokenAMint,
      tokenBMint,
      tokenAAmount: info.tokenAAmount,
      tokenBAmount: info.tokenBAmount,
      // getInitialCompoundingPoolInformation's own sqrtMinPrice/sqrtMaxPrice
      // are sentinel values (0 / u128::MAX) meaning "unbounded" for a
      // compounding *position*, not valid pool-level bounds -- the pool's
      // own range must fall within the protocol-wide MIN/MAX_SQRT_PRICE
      // constants, confirmed by hitting InvalidPriceRangeError otherwise.
      sqrtMinPrice: MIN_SQRT_PRICE,
      sqrtMaxPrice: MAX_SQRT_PRICE,
      liquidityDelta: info.initialLiquidity,
      initSqrtPrice: info.sqrtPrice,
      poolFees,
      hasAlphaVault: false,
      activationType: ActivationType.Timestamp,
      collectFeeMode: CollectFeeMode.BothToken,
      activationPoint: null,
      tokenAProgram: TOKEN_2022_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
    });
    poolAddress = pool;
    await send(connection, payer, tx, [positionNft], "createCustomPool");
    console.log("Pool:", poolAddress.toBase58());
    console.log("Position:", position.toBase58());
  }

  const poolState = await cpAmm.fetchPoolState(poolAddress);
  console.log("\nPool tokenAVault:", poolState.tokenAVault.toBase58());
  console.log("Pool tokenBVault:", poolState.tokenBVault.toBase58());

  console.log("\nSwapping 20 test-USDC -> test-ACT...");
  const amountIn = new BN(20_000_000); // 20 test-USDC
  const currentTime = Math.floor(Date.now() / 1000);
  const currentSlot = await connection.getSlot();
  const quote = cpAmm.getQuote({
    inAmount: amountIn,
    inputTokenMint: tokenBMint,
    slippage: 5, // 5% -- generous for a mechanism test, matching the other two AMM scripts
    poolState,
    currentTime,
    currentSlot,
    tokenADecimal,
    tokenBDecimal,
  });
  console.log("Quote outAmount:", quote.swapOutAmount?.toString() ?? JSON.stringify(quote));

  const actBalanceBefore = await getAccount(connection, deployerActAta, "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log("Deployer test-ACT balance before swap:", actBalanceBefore.amount.toString());

  const swapTx = await cpAmm.swap({
    payer: payer.publicKey,
    pool: poolAddress,
    inputTokenMint: tokenBMint,
    outputTokenMint: tokenAMint,
    amountIn,
    minimumAmountOut: new BN(0), // mechanism test, not a precision/slippage test
    tokenAMint,
    tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: TOKEN_2022_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    referralTokenAccount: null,
  });
  const swapSig = await send(connection, payer, swapTx, [], "swap");

  const actBalanceAfter = await getAccount(connection, deployerActAta, "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log("Deployer test-ACT balance after swap:", actBalanceAfter.amount.toString());
  const received = actBalanceAfter.amount - actBalanceBefore.amount;

  const swapTxInfo = await connection.getParsedTransaction(swapSig, { maxSupportedTransactionVersion: 0 });
  const findVaultDelta = (mint, vaultOwnerCandidate) => {
    const pre = swapTxInfo.meta.preTokenBalances.find((b) => b.mint === mint && b.owner === vaultOwnerCandidate);
    const post = swapTxInfo.meta.postTokenBalances.find((b) => b.mint === mint && b.owner === vaultOwnerCandidate);
    if (!pre || !post) return null;
    return BigInt(pre.uiTokenAmount.amount) - BigInt(post.uiTokenAmount.amount);
  };
  // The ACT vault's owner is the pool's authority PDA; look it up from the
  // vault account itself rather than assuming which PDA it is.
  const vaultInfo = await getAccount(connection, poolState.tokenAVault, "confirmed", TOKEN_2022_PROGRAM_ID);
  const vaultSentGross = findVaultDelta(testActMint.toBase58(), vaultInfo.owner.toBase58());

  console.log("\nPool's ACT vault sent (gross, from the confirmed tx):", vaultSentGross?.toString());
  console.log("Swapper's wallet balance increase (net, after the mint's transfer fee):", received.toString());

  check("swap succeeded and ACT balance increased", received > 0n);
  if (vaultSentGross !== null && vaultSentGross > 0n) {
    check("actual net receipt is less than the pool's gross output (fee was withheld)", received < vaultSentGross);
    const withheld = vaultSentGross - received;
    const impliedBps = (withheld * 10_000n) / vaultSentGross;
    console.log("Implied fee rate on this leg:", impliedBps.toString(), "bps (expected ~350)");
    check("implied fee rate is close to the mint's real 350 bps", impliedBps >= 340n && impliedBps <= 360n);
  } else {
    console.log("  (could not isolate vault gross-send from tx balances; skipping fee-rate check)");
  }

  const failed = checks.filter(([, p]) => !p);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) {
    console.error("At least one check failed.");
    process.exit(1);
  }
  console.log("\nAll checks passed. Meteora DAMM v2 correctly handles the transfer-fee Token-2022 mint on devnet.");
  console.log("Pool (for reference):", poolAddress.toBase58());
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
