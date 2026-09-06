#!/usr/bin/env node
/**
 * Aretia — Verify a submitted Squads proposal's actual contents.
 * ------------------------------------------------------------------
 * Read-only. Fetches the on-chain VaultTransaction account for a given
 * transaction index and decodes the real instruction(s) inside it,
 * rather than trusting what any proposal script printed about what it
 * submitted. Use this before approving anything in the Squads UI.
 *
 * Usage: node verify-proposal.mjs <transactionIndex>
 */
import { Connection, PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";

const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
const MULTISIG_PDA = new PublicKey("AF8qvhgkZJJE6ascFN4MAwWSEGKpyi6oW6Ht9CySgkmX");
const ACT_MINT = new PublicKey("BmaBEY6NDbLevUcU59Fgie8JHeqD4UjEFJda8LuSS2yT");

const index = BigInt(process.argv[2] || "1");

async function main() {
  const connection = new Connection(RPC_ENDPOINT, "confirmed");

  const [transactionPda] = multisig.getTransactionPda({ multisigPda: MULTISIG_PDA, index });
  console.log(`Vault transaction PDA (index ${index}): ${transactionPda.toBase58()}`);

  const vaultTx = await multisig.accounts.VaultTransaction.fromAccountAddress(connection, transactionPda);
  const msg = vaultTx.message;
  const accountKeys = msg.accountKeys.map((k) => k.toBase58());

  console.log(`\nCreator: ${vaultTx.creator.toBase58()}`);
  console.log(`Number of instructions in this proposal: ${msg.instructions.length}`);

  msg.instructions.forEach((ix, i) => {
    const programId = accountKeys[ix.programIdIndex];
    // NOTE: accountIndexes is a Uint8Array - calling .map() directly on it forces
    // the callback's return value back through ToNumber (Uint8Array.map always
    // returns a Uint8Array), silently corrupting string pubkeys to 0. Convert with
    // Array.from() first.
    const keys = Array.from(ix.accountIndexes).map((idx) => accountKeys[idx]);
    const data = Buffer.from(ix.data);
    console.log(`\n--- Instruction ${i} ---`);
    console.log(`  Program: ${programId}`);
    console.log(`  Accounts: ${keys.join(", ")}`);
    console.log(`  Data (hex): ${data.toString("hex")}`);

    // Decode assuming this is spl-token-2022's SetTransferFee layout:
    // u8 instruction (26 = TransferFeeExtension), u8 subInstruction (5 = SetTransferFee),
    // u16 transferFeeBasisPoints (LE), u64 maximumFee (LE)
    if (data.length === 12) {
      const instruction = data.readUInt8(0);
      const subInstruction = data.readUInt8(1);
      const bps = data.readUInt16LE(2);
      const maxFee = data.readBigUInt64LE(4);
      console.log(`  Decoded: instruction=${instruction} subInstruction=${subInstruction} transferFeeBasisPoints=${bps} maximumFee=${maxFee}`);
      if (keys[0] === ACT_MINT.toBase58()) {
        console.log(`  -> Targets the ACT mint: YES`);
      } else {
        console.log(`  -> WARNING: does not target the known ACT mint (${ACT_MINT.toBase58()})`);
      }
    }
  });
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
