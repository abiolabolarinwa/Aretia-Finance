#!/usr/bin/env node
/**
 * Aretia launch monitor. Read-only: it needs no keys and sends nothing.
 *
 * Prints, for each launch pool: whether it exists yet, the current price, and
 * what sits in its two token vaults (the depth). Then ACT's active transfer
 * fee, the total ACT withheld across all token accounts and the mint (what
 * propose-harvest.mjs would collect), and the treasury vault's SOL balance
 * (it pays rent for proposals and pool creation).
 *
 * Usage:
 *   node monitor.mjs                 # one snapshot
 *   node monitor.mjs --watch 60      # repeat every 60 seconds
 *
 * RPC_ENDPOINT overrides the RPC. The withheld scan uses getProgramAccounts,
 * which some public RPCs refuse; the rest still prints if it fails.
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getTransferFeeConfig,
  getTransferFeeAmount,
  unpackAccount,
} from "@solana/spl-token";
import { CpAmm, getPriceFromSqrtPrice } from "@meteora-ag/cp-amm-sdk";

const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
const ACT_MINT = new PublicKey("7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG");
const ACT_DECIMALS = 9;
const TREASURY_VAULT = new PublicKey("GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA");

// Deterministic addresses, same as README.md / create-pools.mjs.
const POOLS = [
  { pair: "ACT/USDC", quote: "USDC", quoteDecimals: 6, address: new PublicKey("6n8Mvd7xmZs66E5VLGQGvtE31gbKMcTL4S97W4oV6ivX") },
  { pair: "ACT/SOL", quote: "SOL", quoteDecimals: 9, address: new PublicKey("ECJYQzo2YfWTChEnNsaThC5Aeng1hxfbfNG8DQVgkSkb") },
];

const watchIdx = process.argv.indexOf("--watch");
const WATCH_SECONDS = watchIdx >= 0 ? Number(process.argv[watchIdx + 1] ?? "60") : 0;

const fmt = (raw, decimals, digits = 4) =>
  (Number(raw) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: digits });

async function vaultAmount(connection, vault) {
  const { value } = await connection.getTokenAccountBalance(vault, "confirmed");
  return BigInt(value.amount);
}

async function pools(connection, cpAmm) {
  for (const p of POOLS) {
    if (!(await connection.getAccountInfo(p.address))) {
      console.log(`${p.pair.padEnd(9)} not created yet (${p.address.toBase58()})`);
      continue;
    }
    const state = await cpAmm.fetchPoolState(p.address);
    const actIsA = state.tokenAMint.equals(ACT_MINT);
    const [aDec, bDec] = actIsA ? [ACT_DECIMALS, p.quoteDecimals] : [p.quoteDecimals, ACT_DECIMALS];
    const priceAinB = getPriceFromSqrtPrice(state.sqrtPrice, aDec, bDec);
    const price = actIsA ? priceAinB : priceAinB.pow(-1); // quote per ACT
    const [a, b] = await Promise.all([vaultAmount(connection, state.tokenAVault), vaultAmount(connection, state.tokenBVault)]);
    const [act, quote] = actIsA ? [a, b] : [b, a];
    console.log(
      `${p.pair.padEnd(9)} price ${price.toSignificantDigits(6).toString()} ${p.quote}/ACT | ` +
        `depth ${fmt(act, ACT_DECIMALS, 0)} ACT + ${fmt(quote, p.quoteDecimals)} ${p.quote}`
    );
  }
}

async function fee(connection) {
  const mint = await getMint(connection, ACT_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const cfg = getTransferFeeConfig(mint);
  const { epoch } = await connection.getEpochInfo();
  const active = BigInt(epoch) >= cfg.newerTransferFee.epoch ? cfg.newerTransferFee : cfg.olderTransferFee;
  console.log(`ACT fee   ${active.transferFeeBasisPoints} bps active at epoch ${epoch}` +
    (BigInt(epoch) < cfg.newerTransferFee.epoch ? ` (${cfg.newerTransferFee.transferFeeBasisPoints} bps from epoch ${cfg.newerTransferFee.epoch})` : ""));
  return cfg.withheldAmount; // already harvested into the mint, not yet withdrawn
}

async function withheld(connection) {
  const accounts = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: ACT_MINT.toBase58() } }],
  });
  let total = 0n;
  let holding = 0;
  for (const { pubkey, account } of accounts) {
    let decoded;
    try {
      decoded = unpackAccount(pubkey, account, TOKEN_2022_PROGRAM_ID);
    } catch {
      continue;
    }
    const w = getTransferFeeAmount(decoded)?.withheldAmount ?? 0n;
    if (w > 0n) {
      total += w;
      holding++;
    }
  }
  return { total, holding, scanned: accounts.length };
}

async function snapshot(connection, cpAmm) {
  console.log(`\n=== ${new Date().toISOString()} ===`);
  try { await pools(connection, cpAmm); } catch (e) { console.log(`pools     failed: ${e.message}`); }
  let inMint = 0n;
  try { inMint = await fee(connection); } catch (e) { console.log(`fee       failed: ${e.message}`); }
  try {
    const w = await withheld(connection);
    console.log(`withheld  ${fmt(w.total + inMint, ACT_DECIMALS)} ACT (${w.holding} of ${w.scanned} accounts, plus ${fmt(inMint, ACT_DECIMALS)} in the mint)`);
  } catch (e) {
    console.log(`withheld  scan failed (${e.message}); try another RPC_ENDPOINT`);
  }
  try {
    const lamports = await connection.getBalance(TREASURY_VAULT, "confirmed");
    console.log(`vault SOL ${fmt(lamports, 9, 6)} SOL (${TREASURY_VAULT.toBase58()})`);
  } catch (e) { console.log(`vault SOL failed: ${e.message}`); }
}

const connection = new Connection(RPC_ENDPOINT, "confirmed");
const cpAmm = new CpAmm(connection);
await snapshot(connection, cpAmm);
if (WATCH_SECONDS > 0) setInterval(() => snapshot(connection, cpAmm), WATCH_SECONDS * 1000);
