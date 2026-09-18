import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, getTransferFeeConfig, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import fs from "node:fs";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const tokens = JSON.parse(fs.readFileSync(new URL("./devnet-test-tokens.json", import.meta.url), "utf8"));
const mintAddr = new PublicKey(tokens.testActMint);

const mint = await getMint(connection, mintAddr, "confirmed", TOKEN_2022_PROGRAM_ID);
const feeConfig = getTransferFeeConfig(mint);
console.log(JSON.stringify(feeConfig, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

const epochInfo = await connection.getEpochInfo();
console.log("current epoch:", epochInfo.epoch);
