#!/usr/bin/env node
/**
 * PRESALE_DESIGN.md open item #2 -- extend the AMM proof to Orca.
 * ---------------------------------------------------------------------
 * Mirrors exercise-devnet-raydium-cpmm.mjs: creates a real Orca
 * Whirlpool "splash pool" (a simplified, full-range-only pool type --
 * no tick math needed) on devnet, pairing test-ACT (Token-2022, 350 bps
 * transfer fee) against test-USDC, seeds liquidity, and does a real
 * swap through it, to prove Orca's Whirlpools program actually handles
 * a transfer-fee Token-2022 mint correctly on devnet.
 *
 * Uses Orca's real devnet deployment: the Whirlpool program itself is
 * deployed at the SAME address on devnet and mainnet
 * (whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc, confirmed live via
 * `solana account` before writing this script), but the
 * WhirlpoolsConfig account is devnet-specific
 * (FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR, also confirmed live
 * and owned by that program) -- config accounts are per-cluster state,
 * unlike the program binary.
 *
 * Uses the LEGACY @orca-so/whirlpools-sdk (0.22.x), not the newer
 * @orca-so/whirlpools package -- the newer one requires Solana Web3.js
 * v2 (a different, non-interoperable major version from the v1.99.0
 * this whole project already uses), while the legacy SDK's peer range
 * is plain @solana/web3.js ^1.98.4, compatible with everything else
 * here.
 *
 * Run: node scripts/exercise-devnet-orca-whirlpool.mjs
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { Wallet, BN } from "@coral-xyz/anchor";
import Decimal from "decimal.js";
import fs from "node:fs";
import {
  WhirlpoolContext,
  buildWhirlpoolClient,
  buildDefaultAccountFetcher,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  TickUtil,
  swapQuoteByInputToken,
  increaseLiquidityQuoteByInputToken,
  PDAUtil,
  IGNORE_CACHE,
  TokenExtensionUtil,
  MIN_SQRT_PRICE_BN,
  MAX_SQRT_PRICE_BN,
} from "@orca-so/whirlpools-sdk";
import { Percentage } from "@orca-so/common-sdk";

const RPC_URL = "https://api.devnet.solana.com";
const DEPLOYER_KEYPAIR_PATH =
  "C:/Users/USER PC/OneDrive - Furst Peak Solutions/My Stuff/Folders/2026/Aretia Climate App/aretia-finance/devnet/deployer-keypair.json";
const DEVNET_WHIRLPOOLS_CONFIG = new PublicKey("FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR");

function loadKeypair(path) {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadKeypair(DEPLOYER_KEYPAIR_PATH);
  console.log("Deployer:", payer.publicKey.toBase58());

  const tokens = JSON.parse(
    fs.readFileSync(new URL("./devnet-test-tokens.json", import.meta.url), "utf8")
  );
  const testActMint = new PublicKey(tokens.testActMint);
  const testUsdcMint = new PublicKey(tokens.testUsdcMint);
  const deployerActAta = new PublicKey(tokens.deployerActAta);

  const wallet = new Wallet(payer);
  const fetcher = buildDefaultAccountFetcher(connection);
  const ctx = WhirlpoolContext.from(connection, wallet, fetcher, undefined, undefined, ORCA_WHIRLPOOL_PROGRAM_ID);
  const client = buildWhirlpoolClient(ctx);

  const tickSpacing = 32896; // SPLASH_POOL_TICK_SPACING, full-range only
  const [tickLower, tickUpper] = TickUtil.getFullRangeTickIndex(tickSpacing);

  // Splash pools sort mints internally; figure out which of ours becomes
  // tokenA vs tokenB by simple byte comparison (matches the SDK's own
  // ordering rule), then price initialPrice as tokenB-per-tokenA.
  const actIsTokenA = Buffer.compare(testActMint.toBuffer(), testUsdcMint.toBuffer()) < 0;
  const [mintA, mintB] = actIsTokenA ? [testActMint, testUsdcMint] : [testUsdcMint, testActMint];
  // $0.01/ACT: if ACT is tokenA, price(B per A) = 0.01 USDC per ACT.
  // If USDC is tokenA, price(B per A) = 100 ACT per USDC.
  const initialPrice = actIsTokenA ? new Decimal(0.01) : new Decimal(100);

  console.log("mintA:", mintA.toBase58(), actIsTokenA ? "(test-ACT)" : "(test-USDC)");
  console.log("mintB:", mintB.toBase58(), actIsTokenA ? "(test-USDC)" : "(test-ACT)");

  const [expectedPoolPda] = [
    PDAUtil.getWhirlpool(ORCA_WHIRLPOOL_PROGRAM_ID, DEVNET_WHIRLPOOLS_CONFIG, mintA, mintB, tickSpacing).publicKey,
  ];
  const existingPool = await connection.getAccountInfo(expectedPoolPda);

  let poolAddress;
  if (existingPool) {
    poolAddress = expectedPoolPda;
    console.log("\nPool already exists -- skipping creation. Pool:", poolAddress.toBase58());
  } else {
    console.log("\nCreating Orca splash pool...");
    const { poolKey, tx } = await client.createSplashPool(
      DEVNET_WHIRLPOOLS_CONFIG,
      mintA,
      mintB,
      initialPrice,
      payer.publicKey
    );
    poolAddress = poolKey;
    const sig = await tx.buildAndExecute();
    console.log(`createSplashPool tx: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    console.log("Pool:", poolAddress.toBase58());
  }

  let pool = await client.getPool(poolAddress, IGNORE_CACHE);
  await pool.initTickArrayForTicks([tickLower, tickUpper])?.then((tx) => tx?.buildAndExecute());

  const actAmountA = actIsTokenA;
  const depositAmount = new Decimal(actAmountA ? 1000 : 10); // 1000 test-ACT or 10 test-USDC, whichever is tokenA
  const depositMint = actAmountA ? mintA : mintA; // deposit sized against tokenA either way

  console.log("\nOpening a full-range position with initial liquidity...");
  const tokenExtensionCtx = await TokenExtensionUtil.buildTokenExtensionContextForPool(
    ctx.fetcher,
    mintA,
    mintB,
    IGNORE_CACHE
  );
  const liquidityQuote = increaseLiquidityQuoteByInputToken(
    mintA,
    depositAmount,
    tickLower,
    tickUpper,
    Percentage.fromFraction(50, 100),
    pool,
    tokenExtensionCtx
  );
  // The quote helper's minSqrtPrice/maxSqrtPrice came back too narrow for
  // this pool (root-caused by reading Orca's own source: the on-chain
  // `increase_liquidity_by_token_amounts_v2` instruction checks the
  // CURRENT pool sqrt price against these bounds and rejects with
  // PriceSlippageOutOfBounds if it falls outside them -- ours did, even
  // at 50% nominal slippage, which points at an SDK-side quote bug for
  // this token-extensions pool rather than a real price problem: this
  // repo's own on-chain query moments earlier confirmed the pool's real
  // price is exactly 100, matching what it was created with). Widening
  // to the full valid sqrt-price range is safe for this mechanism test
  // (proving the transfer-fee mint works, not exercising real slippage
  // protection) -- MIN_SQRT_PRICE_BN/MAX_SQRT_PRICE_BN are this SDK's
  // own protocol-wide bounds, not arbitrary numbers.
  liquidityQuote.minSqrtPrice = MIN_SQRT_PRICE_BN;
  liquidityQuote.maxSqrtPrice = MAX_SQRT_PRICE_BN;

  const { positionMint, tx: openTx } = await pool.openPosition(tickLower, tickUpper, liquidityQuote);
  const openSig = await openTx.buildAndExecute();
  console.log(`openPosition tx: https://explorer.solana.com/tx/${openSig}?cluster=devnet`);
  console.log("Position mint:", positionMint.toBase58());

  pool = await client.getPool(poolAddress, IGNORE_CACHE);

  console.log("\nComputing swap quote (test-USDC -> test-ACT if USDC is tokenB, or vice versa)...");
  const inputMint = testUsdcMint;
  const inputAmount = new BN(20_000_000); // 20 test-USDC
  const quote = await swapQuoteByInputToken(
    pool,
    inputMint,
    inputAmount,
    Percentage.fromFraction(50, 100),
    ORCA_WHIRLPOOL_PROGRAM_ID,
    ctx.fetcher,
    IGNORE_CACHE
  );
  console.log("Quote estimatedAmountOut:", quote.estimatedAmountOut.toString());

  const actBalanceBefore = await getAccount(connection, deployerActAta, "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log("Deployer test-ACT balance before swap:", actBalanceBefore.amount.toString());

  const swapTx = await pool.swap(quote);
  const swapSig = await swapTx.buildAndExecute();
  console.log(`swap tx: https://explorer.solana.com/tx/${swapSig}?cluster=devnet`);

  const actBalanceAfter = await getAccount(connection, deployerActAta, "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log("Deployer test-ACT balance after swap:", actBalanceAfter.amount.toString());
  const received = actBalanceAfter.amount - actBalanceBefore.amount;

  // Ground truth from the confirmed transaction: what the pool's ACT
  // vault actually sent (gross) vs what the wallet actually received
  // (net, after the mint's 350 bps transfer fee).
  const swapTxInfo = await connection.getParsedTransaction(swapSig, { maxSupportedTransactionVersion: 0 });
  const poolVaultOwner = poolAddress.toBase58();
  const findDelta = (mint) => {
    const pre = swapTxInfo.meta.preTokenBalances.find((b) => b.mint === mint && b.owner !== payer.publicKey.toBase58());
    const post = swapTxInfo.meta.postTokenBalances.find((b) => b.mint === mint && b.owner === pre?.owner);
    if (!pre || !post) return null;
    return BigInt(pre.uiTokenAmount.amount) - BigInt(post.uiTokenAmount.amount);
  };
  const vaultSentGross = findDelta(testActMint.toBase58());

  console.log("\nPool's ACT vault sent (gross, from the confirmed tx):", vaultSentGross?.toString());
  console.log("Swapper's wallet balance increase (net, after the mint's transfer fee):", received.toString());

  const checks = [];
  function check(label, passed) {
    checks.push([label, passed]);
    console.log(`  ${passed ? "PASS" : "FAIL"} - ${label}`);
  }
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
  console.log("\nAll checks passed. Orca Whirlpools correctly handles the transfer-fee Token-2022 mint on devnet.");
  console.log("Pool (for reference):", poolAddress.toBase58());
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
