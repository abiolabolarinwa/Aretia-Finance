#!/usr/bin/env node
/**
 * Aretia — Phantom Private Key -> Solana CLI JSON Keypair Converter
 * ------------------------------------------------------------------
 * Converts a Phantom-exported base58 private key into the JSON array
 * format (`Keypair.fromSecretKey`) that propose-harvest.mjs and
 * propose-fee-change.mjs expect via PROPOSER_KEYPAIR_PATH.
 *
 * Runs entirely on your own machine. Nothing it reads or writes ever
 * leaves this process - no network calls, no logging of the key itself.
 * The key you type is masked (not echoed to the terminal).
 *
 * Usage:
 *   node convert-phantom-key.mjs
 *   (prompts for the base58 key, then the output file path)
 *
 * Safety notes:
 *   - Run this somewhere private - not on a shared screen, not while
 *     screen-sharing, not over a remote session you don't fully trust.
 *   - Save the output file OUTSIDE this git repo if at all possible.
 *     It's also covered by .gitignore's *keypair*.json pattern as a
 *     backup, but don't rely on that as the only safeguard.
 *   - This is your real signer identity for the treasury multisig.
 *     Treat the resulting file exactly like a password: never paste
 *     its contents anywhere, including into a chat with an AI
 *     assistant, an issue tracker, a support ticket, or a screenshot.
 *   - When you're done using it for a proposal run, consider deleting
 *     the file and re-running this converter next time, rather than
 *     leaving a long-lived plaintext key sitting on disk indefinitely.
 */

import fs from "node:fs";
import bs58 from "bs58";

function promptHidden(query) {
  return new Promise((resolve) => {
    process.stdout.write(query);
    const stdin = process.stdin;
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (char) => {
      if (char === "\n" || char === "\r" || char === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(value.trim());
      } else if (char === "\u0003") {
        process.stdout.write("\n");
        process.exit(1);
      } else if (char === "\u007f" || char === "\b") {
        value = value.slice(0, -1);
      } else {
        value += char;
      }
    };
    stdin.on("data", onData);
  });
}

function promptVisible(query) {
  return new Promise((resolve) => {
    process.stdout.write(query);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.once("data", (data) => resolve(data.toString().trim()));
  });
}

async function main() {
  console.log("This reads your Phantom private key and writes a JSON keypair file.");
  console.log("Nothing is sent over the network. Input is masked - it won't appear on screen.\n");

  const base58Key = await promptHidden("Paste your Phantom private key (base58), then press Enter: ");
  if (!base58Key) {
    console.error("No input received - aborting.");
    process.exit(1);
  }

  let secretKeyBytes;
  try {
    secretKeyBytes = bs58.decode(base58Key);
  } catch (e) {
    console.error("Could not decode that as base58 - did you copy the full string? Aborting.");
    process.exit(1);
  }

  if (secretKeyBytes.length !== 64) {
    console.error(`Decoded to ${secretKeyBytes.length} bytes, expected 64 - this doesn't look like a valid Solana secret key. Aborting.`);
    process.exit(1);
  }

  const outPath = await promptVisible("\nOutput file path (e.g. C:\\Users\\you\\.aretia-keys\\proposer-keypair.json): ");
  if (!outPath) {
    console.error("No path given - aborting.");
    process.exit(1);
  }

  const dir = outPath.substring(0, Math.max(outPath.lastIndexOf("\\"), outPath.lastIndexOf("/")));
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outPath, JSON.stringify(Array.from(secretKeyBytes)));
  console.log(`\nWrote keypair file to: ${outPath}`);
  console.log("Verify it worked without printing the key itself:");
  console.log(`  node -e "import('@solana/web3.js').then(w=>{const fs=require('fs');const k=w.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('${outPath.replace(/\\/g, "\\\\")}'))));console.log('Public key:', k.publicKey.toBase58());})"`);
  console.log("\nThat public key should match your known signer address, 4DoV9FEZfTokhhPQvZNCFQCom5KUrrcTbdtX3ctWhjdG.");
  console.log("If it doesn't match, delete the file and try again - do not use it.");
}

main();
