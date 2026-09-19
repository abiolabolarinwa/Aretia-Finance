#!/usr/bin/env node
/**
 * PRESALE_DESIGN.md open item #2 -- DEX/AMM Token-2022 compatibility.
 * ---------------------------------------------------------------------
 * Creates a real Raydium CPMM pool on devnet for test-ACT (Token-2022,
 * 3.5% TransferFeeConfig -- the same throwaway mint used by the presale
 * exercise scripts) paired against test-USDC, seeds it with initial
 * liquidity, then does a real swap through it -- to prove Raydium's
 * CPMM actually handles a transfer-fee Token-2022 mint correctly on
 * devnet, not just that its docs say it should.
 *
 * Uses Raydium's own devnet CPMM deployment
 * (DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb, confirmed live via
 * `solana account` before writing this script) and one of its
 * pre-existing standard fee-tier config accounts (index 0, 0.25% trade
 * fee, confirmed live on devnet and decoded directly via
 * CpmmConfigInfoLayout rather than trusting Raydium's api-v3 endpoint,
 * which does not serve devnet pool/config data).
 *
 * This is throwaway devnet liquidity with throwaway test tokens -- it
 * does not touch the real ACT mint, and proves nothing about mainnet
 * pool economics, only that the CPMM program's transfer-fee handling
 * works mechanically against a mint shaped like ours (Token-2022,
 * uncapped maximum_fee, 350 bps).
 *
 * Run: node scripts/exercise-devnet-raydium-cpmm.mjs
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import BN from "bn.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Raydium,
  TxVersion,
  DEVNET_PROGRAM_ID,
  getCpmmPdaAmmConfigId,
  CpmmConfigInfoLayout,
  CurveCalculator,
  FeeOn,
} from "@raydium-io/raydium-sdk-v2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RPC_URL = "https://api.devnet.solana.com";
const DEPLOYER_KEYPAIR_PATH =
  path.resolve(__dirname, "../../../devnet/deployer-keypair.json");

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

  const raydium = await Raydium.load({
    connection,
    cluster: "devnet",
    owner: payer,
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: "confirmed",
  });

  // Fee config: use the real, confirmed-live devnet AMM config for index 0
  // (0.25% trade fee), decoded directly from its on-chain account rather
  // than Raydium's api-v3 (which doesn't serve devnet config data).
  const configId = getCpmmPdaAmmConfigId(DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM, 0).publicKey;
  const configInfo = await connection.getAccountInfo(configId);
  if (!configInfo) throw new Error("devnet CPMM config index 0 not found on-chain");
  const decoded = CpmmConfigInfoLayout.decode(configInfo.data);
  const feeConfig = {
    id: configId.toBase58(),
    index: decoded.index,
    protocolFeeRate: decoded.protocolFeeRate.toNumber(),
    tradeFeeRate: decoded.tradeFeeRate.toNumber(),
    fundFeeRate: decoded.fundFeeRate.toNumber(),
    createPoolFee: decoded.createPoolFee.toString(),
    creatorFeeRate: decoded.creatorFeeRate.toNumber(),
  };
  console.log("Fee config:", feeConfig);

  const mintA = { address: testActMint.toBase58(), decimals: 9, programId: TOKEN_2022_PROGRAM_ID.toBase58() };
  const mintB = { address: testUsdcMint.toBase58(), decimals: 6, programId: TOKEN_PROGRAM_ID.toBase58() };

  // Seed liquidity: 1000 test-ACT (gross, pre-fee) against 10 test-USDC --
  // roughly matches the presale's $0.01/ACT price once the 3.5% transfer
  // fee is netted out of the ACT side. Small amounts; this is a
  // mechanism test, not a real liquidity seeding rehearsal.
  const mintAAmount = new BN(1000).mul(new BN(10).pow(new BN(9)));
  const mintBAmount = new BN(10).mul(new BN(10).pow(new BN(6)));

  // Pool from a prior successful run of this script -- checked directly
  // rather than re-derived, since Raydium normalizes mintA/mintB ordering
  // internally and re-deriving with our own (possibly reversed) order
  // could silently miss it.
  const KNOWN_POOL_ID = new PublicKey("DwhXfWKGbs92NrhpFY7bXH9zzcGjNHX7kNvrsThM8aUj");
  const existingPool = await connection.getAccountInfo(KNOWN_POOL_ID);

  let poolId;
  if (existingPool) {
    poolId = KNOWN_POOL_ID.toBase58();
    console.log("\nPool already exists -- skipping createPool. Pool ID:", poolId);
  } else {
    console.log("\nCreating CPMM pool...");
    const { execute, extInfo } = await raydium.cpmm.createPool({
      programId: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
      poolFeeAccount: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC,
      mintA,
      mintB,
      mintAAmount,
      mintBAmount,
      startTime: new BN(0),
      feeConfig,
      addSupportMintExt: true, // test-ACT has the TransferFeeConfig extension
      associatedOnly: false,
      ownerInfo: { useSOLBalance: true },
      txVersion: TxVersion.LEGACY,
    });

    poolId = extInfo.address.poolId.toBase58();
    console.log("Pool ID:", poolId);

    const { txId: createTxId } = await execute({ sendAndConfirm: true });
    console.log(`createPool tx: https://explorer.solana.com/tx/${createTxId}?cluster=devnet`);
  }

  console.log("\nFetching pool info back from RPC...");
  const { poolInfo, poolKeys, rpcData } = await raydium.cpmm.getPoolInfoFromRpc(poolId);
  console.log("On-chain reserves -- baseReserve:", rpcData.baseReserve.toString(), "quoteReserve:", rpcData.quoteReserve.toString());

  // Swap 20 test-USDC -> test-ACT (mintB -> mintA), through the pool we
  // just created, to exercise the fee-on-transfer path on both legs:
  // the input transfer (plain USDC, no fee) and the output transfer
  // (test-ACT, 3.5% fee withheld on the way out to the swapper).
  const inputMint = testUsdcMint.toBase58();
  const inputAmount = new BN(20).mul(new BN(10).pow(new BN(6))); // 20 test-USDC
  const baseIn = inputMint === poolInfo.mintA.address;

  const swapResult = CurveCalculator.swapBaseInput(
    inputAmount,
    baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
    baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
    rpcData.configInfo.tradeFeeRate,
    rpcData.configInfo.creatorFeeRate,
    rpcData.configInfo.protocolFeeRate,
    rpcData.configInfo.fundFeeRate,
    rpcData.feeOn === FeeOn.BothToken || rpcData.feeOn === FeeOn.OnlyTokenB
  );
  console.log("\nComputed swap result:", {
    inputAmount: swapResult.inputAmount.toString(),
    outputAmount: swapResult.outputAmount.toString(),
    tradeFee: swapResult.tradeFee?.toString(),
  });

  const deployerActAta = new PublicKey(tokens.deployerActAta);
  const actBalanceBefore = await getAccount(connection, deployerActAta, "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log("Deployer test-ACT balance before swap:", actBalanceBefore.amount.toString());

  const { execute: executeSwap } = await raydium.cpmm.swap({
    poolInfo,
    poolKeys,
    inputAmount,
    swapResult,
    slippage: 0.05,
    baseIn,
    txVersion: TxVersion.LEGACY,
  });

  const { txId: swapTxId } = await executeSwap({ sendAndConfirm: true });
  console.log(`swap tx: https://explorer.solana.com/tx/${swapTxId}?cluster=devnet`);

  const actBalanceAfter = await getAccount(connection, deployerActAta, "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log("Deployer test-ACT balance after swap:", actBalanceAfter.amount.toString());
  const actReceivedNet = actBalanceAfter.amount - actBalanceBefore.amount;

  // Ground truth: read what the pool's ACT vault actually sent, straight
  // from the confirmed transaction's token balances -- not from our own
  // off-chain CurveCalculator estimate, which turned out to diverge from
  // the real on-chain amount by ~1-2% (a real, if minor, reminder that an
  // off-chain quote is an estimate, not a guarantee -- exactly why this
  // swap needed a wider slippage tolerance than the first, too-tight
  // attempt used).
  const swapTx = await connection.getParsedTransaction(swapTxId, { maxSupportedTransactionVersion: 0 });
  const actVaultOwner = poolKeys.authority.toString();
  const findBalance = (balances, owner) =>
    balances.find((b) => b.mint === testActMint.toBase58() && b.owner === owner)?.uiTokenAmount.amount;
  const vaultActBefore = BigInt(findBalance(swapTx.meta.preTokenBalances, actVaultOwner) ?? "0");
  const vaultActAfter = BigInt(findBalance(swapTx.meta.postTokenBalances, actVaultOwner) ?? "0");
  const vaultSentGross = vaultActBefore - vaultActAfter;

  console.log("\nPool ACT vault sent (gross, from the confirmed tx):", vaultSentGross.toString());
  console.log("Swapper's wallet balance increase (net, after the mint's transfer fee):", actReceivedNet.toString());

  const feeWasWithheld = actReceivedNet > 0n && actReceivedNet < vaultSentGross;
  const roughlyMatchesFeeRate = (() => {
    const withheld = vaultSentGross - actReceivedNet;
    const impliedBps = (withheld * 10_000n) / vaultSentGross;
    console.log("Implied fee rate on this leg:", impliedBps.toString(), "bps (expected ~350)");
    return impliedBps >= 340n && impliedBps <= 360n;
  })();

  console.log("\nChecks:");
  const checks = [
    ["swap succeeded and ACT balance increased", actReceivedNet > 0n],
    ["actual net receipt is less than the pool's gross output (fee was withheld)", feeWasWithheld],
    ["implied fee rate is close to the mint's real 350 bps", roughlyMatchesFeeRate],
  ];
  let allPassed = true;
  for (const [label, passed] of checks) {
    console.log(`  ${passed ? "PASS" : "FAIL"} - ${label}`);
    if (!passed) allPassed = false;
  }
  if (!allPassed) {
    console.error("\nAt least one check failed.");
    process.exit(1);
  }
  console.log("\nAll checks passed. Raydium CPMM correctly handles the transfer-fee Token-2022 mint on devnet.");
  console.log("Pool ID (for reference):", poolId);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
