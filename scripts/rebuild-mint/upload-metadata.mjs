#!/usr/bin/env node
/**
 * Aretia — ACT v2 Rebuild: Upload Logo + Metadata JSON to Arweave (via Irys)
 * ------------------------------------------------------------------
 * Manual-run tool. It does NOT touch the live ACT v1 mint, the treasury,
 * or anything already deployed -- this only uploads two files to permanent
 * Arweave storage, paid for with a small amount of SOL from whatever
 * keypair you point it at.
 *
 * What it does, in order:
 *   1. Uploads the logo image file first, on its own.
 *   2. Takes the resulting permanent URI and writes it into a fresh copy
 *      of the metadata JSON (both the "image" field and
 *      properties.files[0].uri), so the two files are never out of sync.
 *   3. Uploads that completed metadata JSON as a second, separate file.
 *   4. Prints both resulting URIs. The SECOND one (the metadata JSON's own
 *      URI) is what goes into the on-chain Metaplex metadata account's
 *      "uri" field when the new mint is actually created -- not the image
 *      URI directly.
 *
 * IMPORTANT -- this cannot be undone or edited after the fact:
 *   Arweave storage is content-addressed and permanent by design. Once
 *   uploaded, neither file can be changed, replaced, or deleted. Re-check
 *   token-metadata.json and the logo file themselves before running this
 *   with --execute, especially given the new mint's metadata authority is
 *   planned to be permanently revoked once set (see WHITEPAPER.md Sec. 11,
 *   "Path A").
 *
 * Safety model:
 *   - Runs in dry-run mode by default: checks the keypair's SOL balance,
 *     estimates upload cost for both files, and prints what WOULD happen.
 *     Uploads nothing.
 *   - Pass --execute to actually upload for real.
 *   - Pass --network devnet to test the script's mechanics against Irys's
 *     devnet node first (funded with free devnet SOL). NOTE: a devnet
 *     upload is for testing the script only -- it does not produce a
 *     real, permanent mainnet Arweave URI. The real logo/metadata URIs
 *     used in the final mint must come from a --network mainnet run.
 *
 * Usage:
 *   npm install
 *   node upload-metadata.mjs                                      # dry run, mainnet pricing
 *   node upload-metadata.mjs --network devnet                     # dry run against devnet
 *   KEYPAIR_PATH=/path/to/wallet.json \
 *     node upload-metadata.mjs --network devnet --execute          # real devnet test upload
 *   KEYPAIR_PATH=/path/to/wallet.json \
 *     node upload-metadata.mjs --network mainnet --execute         # real, permanent upload
 *
 * KEYPAIR_PATH must point to a Solana CLI-style JSON keypair file (a plain
 * JSON array of the secret key bytes) for a wallet holding a small amount
 * of SOL. This does not need to be, and should not be, any treasury or
 * multisig-related key -- a disposable wallet funded with a few dollars of
 * SOL is the right choice here, since all it does is pay tiny Irys storage
 * fees. No private key or seed phrase should ever be pasted into chat or
 * committed to this repository.
 */

import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { Uploader } from "@irys/upload";
import { Solana } from "@irys/upload-solana";

const EXECUTE = process.argv.includes("--execute");
const networkFlagIndex = process.argv.indexOf("--network");
const NETWORK = networkFlagIndex !== -1 ? process.argv[networkFlagIndex + 1] : "mainnet";
if (!["mainnet", "devnet"].includes(NETWORK)) {
  throw new Error(`--network must be "mainnet" or "devnet", got "${NETWORK}"`);
}

const LOGO_PATH = path.resolve(
  "../../logo/aretiafinance-square.png"
);
const METADATA_TEMPLATE_PATH = path.resolve("../../token-metadata.json");
const METADATA_OUT_PATH = path.resolve("../../token-metadata.final.json");

function log(...args) {
  console.log(...args);
}

async function getUploader(keypairPath, rawSecretKey) {
  let keyArray;
  if (rawSecretKey) {
    keyArray = rawSecretKey;
  } else {
    const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
    keyArray = Uint8Array.from(secret);
  }
  let builder = Uploader(Solana).withWallet(keyArray);
  if (NETWORK === "devnet") {
    builder = builder.withRpc("https://api.devnet.solana.com").devnet();
  }
  return await builder;
}

async function main() {
  if (!fs.existsSync(LOGO_PATH)) {
    throw new Error(`Logo file not found at ${LOGO_PATH}`);
  }
  if (!fs.existsSync(METADATA_TEMPLATE_PATH)) {
    throw new Error(`Metadata template not found at ${METADATA_TEMPLATE_PATH}`);
  }

  const logoBytes = fs.readFileSync(LOGO_PATH);
  const logoSizeKb = (logoBytes.length / 1024).toFixed(1);

  log(`Network: ${NETWORK}`);
  log(`Logo file: ${LOGO_PATH} (${logoSizeKb} KB)`);
  log(`Metadata template: ${METADATA_TEMPLATE_PATH}`);

  if (!EXECUTE) {
    log("\n--- DRY RUN (no upload performed, no keypair required) ---");
    // A throwaway, never-funded, never-persisted keypair -- just to satisfy
    // the SDK's constructor so we can ask its pricing endpoint a real
    // question. It never signs or spends anything.
    const throwaway = Keypair.generate();
    const uploader = await getUploader(null, throwaway.secretKey);
    const metadataEstimateBytes = fs.statSync(METADATA_TEMPLATE_PATH).size + 200; // template + the URI text that will replace the placeholder
    const logoPrice = await uploader.getPrice(logoBytes.length);
    const metadataPrice = await uploader.getPrice(metadataEstimateBytes);
    const totalAtomic = logoPrice.plus(metadataPrice);
    log(`Real quoted cost (${NETWORK} Irys node):`);
    log(`  Logo (${logoBytes.length} bytes):        ${uploader.utils.fromAtomic(logoPrice)} ${uploader.token}`);
    log(`  Metadata JSON (~${metadataEstimateBytes} bytes): ${uploader.utils.fromAtomic(metadataPrice)} ${uploader.token}`);
    log(`  Total:                            ${uploader.utils.fromAtomic(totalAtomic)} ${uploader.token}`);
    if (NETWORK === "devnet") {
      log("\nDevnet run: testing the script's mechanics only -- does NOT produce a real, permanent mainnet URI. Fund a devnet wallet via a Solana devnet faucet to actually test-execute.");
    } else {
      log("\nMake sure KEYPAIR_PATH's wallet holds at least the total above, plus normal Solana transaction fees, before running with --execute.");
    }
    return;
  }

  const keypairPath = process.env.KEYPAIR_PATH;
  if (!keypairPath) {
    throw new Error("Set KEYPAIR_PATH to a Solana CLI-style JSON keypair file to actually upload.");
  }

  const uploader = await getUploader(keypairPath);
  const balance = await uploader.getLoadedBalance();
  log(`\nWallet: ${uploader.address}`);
  log(`Irys node balance (already funded, ready to spend on uploads): ${uploader.utils.fromAtomic(balance)} ${uploader.token}`);

  // Irys uses a pre-funded balance model: SOL sitting in the wallet is not
  // itself spendable for uploads until explicitly deposited into Irys's own
  // balance via fund(). Top up if the current Irys balance is short of what
  // both uploads will actually cost.
  const metadataEstimateBytes = fs.statSync(METADATA_TEMPLATE_PATH).size + 200;
  const logoPriceNeeded = await uploader.getPrice(logoBytes.length);
  const metadataPriceNeeded = await uploader.getPrice(metadataEstimateBytes);
  const totalNeeded = logoPriceNeeded.plus(metadataPriceNeeded);
  if (balance.isLessThan(totalNeeded)) {
    const shortfall = totalNeeded.minus(balance);
    log(`\nIrys balance is short by ${uploader.utils.fromAtomic(shortfall)} ${uploader.token}. Funding now (on-chain transaction from your wallet to Irys)...`);
    const fundTx = await uploader.fund(shortfall);
    log(`Funded. Transaction: ${fundTx.id}`);
  }

  // ---- Step 1: upload the logo image ----
  log("\nUploading logo image...");
  const logoReceipt = await uploader.uploadFile(LOGO_PATH, {
    tags: [{ name: "Content-Type", value: "image/png" }],
  });
  const logoUri = `https://gateway.irys.xyz/${logoReceipt.id}`;
  log(`Logo uploaded. Permanent URI: ${logoUri}`);

  // ---- Step 2: fill the metadata JSON with the real logo URI ----
  const metadata = JSON.parse(fs.readFileSync(METADATA_TEMPLATE_PATH, "utf8"));
  metadata.image = logoUri;
  if (metadata.properties && Array.isArray(metadata.properties.files) && metadata.properties.files[0]) {
    metadata.properties.files[0].uri = logoUri;
  }
  fs.writeFileSync(METADATA_OUT_PATH, JSON.stringify(metadata, null, 2));
  log(`\nWrote completed metadata to ${METADATA_OUT_PATH} (image URI filled in).`);

  // ---- Step 3: upload the completed metadata JSON ----
  log("Uploading metadata JSON...");
  const metadataReceipt = await uploader.uploadFile(METADATA_OUT_PATH, {
    tags: [{ name: "Content-Type", value: "application/json" }],
  });
  const metadataUri = `https://gateway.irys.xyz/${metadataReceipt.id}`;
  log(`Metadata JSON uploaded. Permanent URI: ${metadataUri}`);

  log("\n--- Result ---");
  log(`Logo URI (for reference only):        ${logoUri}`);
  log(`Metadata URI (use THIS in the mint):  ${metadataUri}`);
  log("\nVerify both URIs resolve correctly in a browser before using the metadata URI in mint creation.");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
