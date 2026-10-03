#!/usr/bin/env node
/**
 * Aretia — single-sided Meteora DAMM v2 launch pools, from the treasury
 * ------------------------------------------------------------------
 * Creates ACT/USDC and ACT/SOL pools on Meteora DAMM v2 (CP-AMM, program
 * cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG -- the AMM proven with an
 * ACT-like 3.5%-fee Token-2022 mint on devnet, see
 * program/act-presale/scripts/exercise-devnet-meteora-damm.mjs).
 *
 * Each pool is SINGLE-SIDED: it opens at the floor price with only ACT
 * deposited, over a range from the floor to the protocol maximum. Nobody can
 * buy below the floor; buyers pay in USDC or SOL, which builds the other side
 * of the pool. The treasury vault owns the position (via its NFT).
 *
 * Modes:
 *   node create-pools.mjs              DRY RUN (default): builds every
 *                                      instruction and simulates it against
 *                                      live mainnet AS the treasury vault, with
 *                                      no keys. Prints exact rent / SOL needs.
 *   node create-pools.mjs --execute    Drafts one Squads proposal per pool.
 *                                      Nothing moves until 2-of-3 approve and
 *                                      execute in Squads. Needs
 *                                      PROPOSER_KEYPAIR_PATH (a multisig
 *                                      member's key; it can't move funds).
 *
 * Options (env vars):
 *   FLOOR_USD=0.005         floor price per ACT, in USD
 *   ACT_PER_POOL=5000000    ACT deposited into EACH pool (two pools)
 *   POOLS=usdc,sol          which pools to build
 *   POOL_FEE_BPS=25         pool trading fee (0.25%) -- a business choice
 *   SOL_USD=<number>        override the live SOL/USD price for the SOL pool
 *   RPC_ENDPOINT=...        default https://api.mainnet-beta.solana.com
 *   ALLOW_OLD_FEE=1         allow --execute while ACT's 3.5% fee is still active
 *   LOCK_LIQUIDITY=permanent  DEFAULT (decided 1 Oct 2026): permanently lock
 *                           each position right after creation (Meteora
 *                           permanentLockPosition). The ACT and the USDC/SOL
 *                           buyers pay in can then NEVER be withdrawn by
 *                           anyone, the treasury included; the position can
 *                           still claim its trading fees. Traders can always
 *                           buy and sell either way.
 *   LOCK_LIQUIDITY=none     create the pools without the lock.
 *
 * The SOL pool's floor is fixed in SOL at creation: FLOOR_USD / SOL_USD. After
 * that its dollar floor moves with SOL's price. Re-run right before executing.
 *
 * Never prints or stores a private key. A first --execute run should be read
 * as a code review: check every instruction in the Squads UI before approving.
 */
import fs from "node:fs";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getMint, getTransferFeeConfig } from "@solana/spl-token";
import * as multisig from "@sqds/multisig";
import BN from "bn.js";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  CpAmm,
  MAX_SQRT_PRICE,
  deriveCustomizablePoolAddress,
  deriveTokenVaultAddress,
  getBaseFeeParams,
  getSqrtPriceFromPrice,
} from "@meteora-ag/cp-amm-sdk";

// ---- Verified constants (same as scripts/management-fee-proposal) ----
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
const ACT_MINT = new PublicKey("7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG");
const ACT_DECIMALS = 9;
const TREASURY_VAULT = new PublicKey("GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA"); // vault index 0
const MULTISIG_PDA = new PublicKey("5yxBrrC3h1PncGayMtAuWtvTx7MSUy2DJfdrnQ72FJGr");
const VAULT_INDEX = 0;
const EXPECTED_FEE_BPS = 150;

const QUOTES = {
  usdc: { symbol: "USDC", mint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), decimals: 6, program: TOKEN_PROGRAM_ID },
  sol: { symbol: "SOL", mint: new PublicKey("So11111111111111111111111111111111111111112"), decimals: 9, program: TOKEN_PROGRAM_ID },
};

const EXECUTE = process.argv.includes("--execute");
const FLOOR_USD = Number(process.env.FLOOR_USD ?? "0.005");
const ACT_PER_POOL = BigInt(process.env.ACT_PER_POOL ?? "5000000");
const POOLS = (process.env.POOLS ?? "usdc,sol").split(",").map((s) => s.trim()).filter(Boolean);
const POOL_FEE_BPS = Number(process.env.POOL_FEE_BPS ?? "25");
const LOCK = process.env.LOCK_LIQUIDITY ?? "permanent";
if (LOCK !== "none" && LOCK !== "permanent") throw new Error('LOCK_LIQUIDITY must be "permanent" (default) or "none"');

const log = (...a) => console.log(...a);

async function liveSolUsd() {
  if (process.env.SOL_USD) return Number(process.env.SOL_USD);
  const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${QUOTES.sol.mint.toBase58()}`);
  if (!res.ok) throw new Error(`SOL price lookup failed (${res.status}); set SOL_USD=<price> to continue`);
  const body = await res.json();
  const price = Number(body?.[QUOTES.sol.mint.toBase58()]?.usdPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error("SOL price lookup returned nothing usable; set SOL_USD=<price>");
  return price;
}

/** Active ACT transfer fee (bps) for the current epoch, read live -- never assumed. */
async function activeActFeeBps(connection) {
  const mint = await getMint(connection, ACT_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const cfg = getTransferFeeConfig(mint);
  const { epoch } = await connection.getEpochInfo();
  const active = BigInt(epoch) >= cfg.newerTransferFee.epoch ? cfg.newerTransferFee : cfg.olderTransferFee;
  return { mint, epoch, bps: active.transferFeeBasisPoints, newer: cfg.newerTransferFee };
}

/** Squads executes inner instructions by CPI; compute-budget instructions can't be CPI'd, so they go on the outer transaction. */
function withoutComputeBudget(ixs) {
  return ixs.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
}

async function buildPool(cpAmm, connection, quoteKey, mintInfo, epoch, positionNft) {
  const q = QUOTES[quoteKey];
  const solUsd = quoteKey === "sol" ? await liveSolUsd() : 1;
  const floorInQuote = FLOOR_USD / solUsd; // quote units per 1 ACT
  // getSqrtPriceFromPrice expects a decimal string; keep enough precision for tiny SOL prices.
  const floorStr = floorInQuote.toFixed(12);
  const minSqrtPrice = getSqrtPriceFromPrice(floorStr, ACT_DECIMALS, q.decimals);
  const maxSqrtPrice = MAX_SQRT_PRICE;
  const tokenAAmount = new BN((ACT_PER_POOL * 10n ** BigInt(ACT_DECIMALS)).toString());

  const liquidityDelta = cpAmm.preparePoolCreationSingleSide({
    tokenAAmount,
    minSqrtPrice,
    maxSqrtPrice,
    initSqrtPrice: minSqrtPrice,
    tokenAInfo: { mint: mintInfo, currentEpoch: epoch },
    collectFeeMode: CollectFeeMode.BothToken,
  });

  const poolFees = {
    baseFee: getBaseFeeParams({
      baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear,
      feeTimeSchedulerParam: { startingFeeBps: POOL_FEE_BPS, endingFeeBps: POOL_FEE_BPS, numberOfPeriod: 0, totalDuration: 0 },
    }),
    compoundingFeeBps: 0,
    padding: 0,
    dynamicFee: null,
  };

  const { tx, pool, position } = await cpAmm.createCustomPool({
    payer: TREASURY_VAULT,
    creator: TREASURY_VAULT,
    positionNft,
    tokenAMint: ACT_MINT,
    tokenBMint: q.mint,
    tokenAAmount,
    tokenBAmount: new BN(0),
    sqrtMinPrice: minSqrtPrice,
    sqrtMaxPrice: maxSqrtPrice,
    liquidityDelta,
    initSqrtPrice: minSqrtPrice,
    poolFees,
    hasAlphaVault: false,
    activationType: ActivationType.Timestamp,
    collectFeeMode: CollectFeeMode.BothToken,
    activationPoint: null,
    tokenAProgram: TOKEN_2022_PROGRAM_ID,
    tokenBProgram: q.program,
    isLockLiquidity: LOCK === "permanent",
  });

  return {
    quoteKey,
    symbol: q.symbol,
    solUsd,
    floorInQuote,
    pool,
    position,
    instructions: withoutComputeBudget(tx.instructions),
    computeBudget: tx.instructions.filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId)),
  };
}

/** Simulates the inner instructions exactly as the vault (and ephemeral signer) would sign them, with no keys. */
async function simulate(connection, built) {
  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: TREASURY_VAULT,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...built.instructions],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  const sim = await connection.simulateTransaction(vtx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    accounts: { encoding: "base64", addresses: [
      TREASURY_VAULT.toBase58(),
      deriveTokenVaultAddress(ACT_MINT, built.pool).toBase58(),
      getAssociatedTokenAddressSync(ACT_MINT, TREASURY_VAULT, true, TOKEN_2022_PROGRAM_ID).toBase58(),
    ] },
  });
  return sim.value;
}

async function main() {
  const connection = new Connection(RPC_ENDPOINT, "confirmed");
  const cpAmm = new CpAmm(connection);
  log(`=== ${EXECUTE ? "EXECUTE MODE - drafts real Squads proposals" : "DRY RUN (default; pass --execute to draft proposals)"} ===`);

  const fee = await activeActFeeBps(connection);
  log(`Current epoch ${fee.epoch}. Active ACT transfer fee: ${fee.bps} bps (scheduled ${fee.newer.transferFeeBasisPoints} bps from epoch ${fee.newer.epoch}).`);
  if (EXECUTE && fee.bps !== EXPECTED_FEE_BPS && !process.env.ALLOW_OLD_FEE) {
    throw new Error(`ACT's active fee is ${fee.bps} bps, not ${EXPECTED_FEE_BPS}. Wait for epoch ${fee.newer.epoch} (or set ALLOW_OLD_FEE=1 to deposit at the old rate).`);
  }

  const vaultSol = (await connection.getBalance(TREASURY_VAULT)) / 1e9;
  const vaultAct = await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(ACT_MINT, TREASURY_VAULT, true, TOKEN_2022_PROGRAM_ID));
  log(`Treasury vault: ${vaultSol} SOL, ${vaultAct.value.uiAmountString} ACT`);
  log(`Liquidity lock: ${LOCK === "permanent" ? "PERMANENT - positions can never be withdrawn (fees still claimable)" : "none - the treasury can withdraw later with a 2-of-3 approval"}`);
  log(`Plan: ${POOLS.length} pool(s) x ${ACT_PER_POOL.toLocaleString("en-US")} ACT, floor $${FLOOR_USD}/ACT, pool trading fee ${POOL_FEE_BPS / 100}%`);
  log(`ACT's own ${fee.bps / 100}% transfer fee applies to each deposit: ~${(Number(ACT_PER_POOL) * fee.bps / 10000).toLocaleString("en-US")} ACT withheld per pool.`);

  let proposer = null;
  let nextIndex = null;
  if (EXECUTE) {
    const keypairPath = process.env.PROPOSER_KEYPAIR_PATH;
    if (!keypairPath) throw new Error("Set PROPOSER_KEYPAIR_PATH to a treasury multisig member's keypair file.");
    proposer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))));
    const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, MULTISIG_PDA);
    nextIndex = BigInt(ms.transactionIndex) + 1n;
    log(`Proposer: ${proposer.publicKey.toBase58()}  next Squads transaction index: ${nextIndex}`);
  }

  let totalLamportsNeeded = 0;
  for (const quoteKey of POOLS) {
    if (!QUOTES[quoteKey]) throw new Error(`Unknown pool "${quoteKey}" (use usdc and/or sol)`);
    // The position NFT mint must sign its own creation. Inside a Squads vault
    // transaction that signer is an ephemeral signer PDA of that transaction.
    let positionNft;
    let transactionIndex = null;
    if (EXECUTE) {
      transactionIndex = nextIndex;
      const [transactionPda] = multisig.getTransactionPda({ multisigPda: MULTISIG_PDA, index: transactionIndex });
      [positionNft] = multisig.getEphemeralSignerPda({ transactionPda, ephemeralSignerIndex: 0 });
      nextIndex += 1n;
    } else {
      positionNft = Keypair.generate().publicKey; // stand-in for the dry run; same account shape
    }

    const built = await buildPool(cpAmm, connection, quoteKey, fee.mint, fee.epoch, positionNft);
    const expectedPool = deriveCustomizablePoolAddress(ACT_MINT, QUOTES[quoteKey].mint);
    log(`\n--- ACT/${built.symbol} ---`);
    if (quoteKey === "sol") log(`SOL/USD used: ${built.solUsd}  ->  floor ${built.floorInQuote.toExponential(6)} SOL per ACT`);
    else log(`Floor: ${built.floorInQuote} USDC per ACT`);
    log(`Pool: ${built.pool.toBase58()}${built.pool.equals(expectedPool) ? "" : "  (!) differs from derived " + expectedPool.toBase58()}`);
    log(`Position: ${built.position.toBase58()}  (owned by the treasury vault via its NFT)`);
    const existing = await connection.getAccountInfo(built.pool);
    if (existing) {
      log("This pool already exists -- skipping.");
      continue;
    }
    log(`Inner instructions: ${built.instructions.length}`);
    built.instructions.forEach((ix, i) => log(`  ${i}: ${ix.programId.toBase58()} (${ix.keys.length} accounts, ${ix.data.length} bytes)`));

    const sim = await simulate(connection, built);
    if (sim.err) {
      log("SIMULATION FAILED:", JSON.stringify(sim.err));
      (sim.logs ?? []).slice(-25).forEach((l) => log("   ", l));
      process.exitCode = 1;
      continue;
    }
    const after = sim.accounts?.[0]?.lamports ?? null;
    const spent = after === null ? null : (await connection.getBalance(TREASURY_VAULT)) - after;
    if (spent !== null) totalLamportsNeeded += spent;
    log(`Simulation OK. Compute units: ${sim.unitsConsumed}. Vault SOL spent (rent + fees): ${spent === null ? "unknown" : (spent / 1e9).toFixed(6)} SOL`);
    // Token account amount sits at bytes 64..72 (same layout for Token and Token-2022).
    const poolActData = sim.accounts?.[1]?.data?.[0];
    if (poolActData) {
      const amount = Buffer.from(poolActData, "base64").readBigUInt64LE(64);
      const vaultAfter = Buffer.from(sim.accounts[2].data[0], "base64").readBigUInt64LE(64);
      const vaultBefore = BigInt((await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(ACT_MINT, TREASURY_VAULT, true, TOKEN_2022_PROGRAM_ID))).value.amount);
      const fmt = (raw) => (Number(raw) / 10 ** ACT_DECIMALS).toLocaleString("en-US", { maximumFractionDigits: 2 });
      log(`ACT leaving the treasury: ${fmt(vaultBefore - vaultAfter)}  ->  in the pool: ${fmt(amount)}  (ACT transfer fee withheld: ${fmt(vaultBefore - vaultAfter - amount)})`);
    }

    if (EXECUTE) {
      const { blockhash } = await connection.getLatestBlockhash();
      const vaultTxIx = multisig.instructions.vaultTransactionCreate({
        multisigPda: MULTISIG_PDA,
        transactionIndex,
        creator: proposer.publicKey,
        vaultIndex: VAULT_INDEX,
        ephemeralSigners: 1,
        transactionMessage: new TransactionMessage({ payerKey: TREASURY_VAULT, recentBlockhash: blockhash, instructions: built.instructions }),
        memo: `Create ACT/${built.symbol} pool: ${ACT_PER_POOL} ACT single-sided from $${FLOOR_USD}`,
      });
      const proposalIx = multisig.instructions.proposalCreate({ multisigPda: MULTISIG_PDA, creator: proposer.publicKey, transactionIndex, isDraft: false });
      // Pool creation is a big inner message: vault transaction + proposal together exceed the 1232-byte packet limit, so send them separately.
      const createTx = new Transaction({ feePayer: proposer.publicKey, recentBlockhash: blockhash }).add(vaultTxIx);
      const createSig = await connection.sendTransaction(createTx, [proposer]);
      await connection.confirmTransaction(createSig, "confirmed");
      const { blockhash: proposalBlockhash } = await connection.getLatestBlockhash();
      const proposalTx = new Transaction({ feePayer: proposer.publicKey, recentBlockhash: proposalBlockhash }).add(proposalIx);
      const sig = await connection.sendTransaction(proposalTx, [proposer]);
      await connection.confirmTransaction(sig, "confirmed");
      log(`Proposal #${transactionIndex} created: vault transaction ${createSig}, proposal ${sig}`);
    }
  }

  const vaultLamports = await connection.getBalance(TREASURY_VAULT);
  log(`\nTotal vault SOL needed for these pools: ${(totalLamportsNeeded / 1e9).toFixed(6)} SOL; vault has ${(vaultLamports / 1e9).toFixed(6)} SOL.`);
  if (totalLamportsNeeded > vaultLamports) log("(!) Top up the treasury vault before executing.");
  if (EXECUTE) {
    log(`\nReview and approve in Squads: https://app.squads.so/squads/${TREASURY_VAULT.toBase58()}/transactions`);
    log("When executing in Squads, give the execute transaction a high compute limit (pool creation is compute-heavy).");
  } else {
    log("\nDry run complete - nothing was sent.");
  }
}

main().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  process.exit(1);
});
