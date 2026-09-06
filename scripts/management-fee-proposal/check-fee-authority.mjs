import { Connection, PublicKey } from "@solana/web3.js";

const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "https://solana-rpc.publicnode.com";
const MINT = new PublicKey("BmaBEY6NDbLevUcU59Fgie8JHeqD4UjEFJda8LuSS2yT");
const TRANSFER_FEE_CONFIG = 1;

function readU16LE(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, true);
}
function readU64LE(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true);
}
function readPubkeyOrNone(bytes, offset) {
  const slice = bytes.slice(offset, offset + 32);
  const isZero = slice.every((b) => b === 0);
  return isZero ? null : new PublicKey(slice).toBase58();
}

async function main() {
  const connection = new Connection(RPC_ENDPOINT, "confirmed");
  const info = await connection.getAccountInfo(MINT, "confirmed");
  if (!info) throw new Error("mint account not found");
  const data = new Uint8Array(info.data);

  console.log(`Mint account total length: ${data.length} bytes\n`);

  // Walk the TLV extension region exactly as check-metadata.mjs does.
  const ACCOUNT_TYPE_OFFSET = 165;
  const found = [];
  if (data.length > ACCOUNT_TYPE_OFFSET) {
    let pos = ACCOUNT_TYPE_OFFSET + 1;
    while (pos + 4 <= data.length) {
      const extType = readU16LE(data, pos);
      const extLen = readU16LE(data, pos + 2);
      const extStart = pos + 4;
      if (extStart + extLen > data.length) break;
      found.push({ type: extType, len: extLen, dataStart: extStart });
      pos = extStart + extLen;
    }
  }

  const tfc = found.find((e) => e.type === TRANSFER_FEE_CONFIG);
  if (!tfc) {
    console.log("No TransferFeeConfig extension found on this mint at all.");
    return;
  }
  console.log(`TransferFeeConfig extension found: ${tfc.len} bytes at data offset ${tfc.dataStart}`);
  if (tfc.len !== 108) {
    console.log(`WARNING: expected 108 bytes for TransferFeeConfig, got ${tfc.len}. Layout below may be wrong — treat with suspicion.`);
  }

  const base = tfc.dataStart;
  const configAuthority = readPubkeyOrNone(data, base + 0);
  const withdrawAuthority = readPubkeyOrNone(data, base + 32);
  const withheldAmount = readU64LE(data, base + 64);

  const olderEpoch = readU64LE(data, base + 72);
  const olderMaxFee = readU64LE(data, base + 80);
  const olderBps = readU16LE(data, base + 88);

  const newerEpoch = readU64LE(data, base + 90);
  const newerMaxFee = readU64LE(data, base + 98);
  const newerBps = readU16LE(data, base + 106);

  const currentEpochInfo = await connection.getEpochInfo();

  console.log(`\n--- Authorities ---`);
  console.log(`transfer_fee_config_authority: ${configAuthority ?? "None (zeroed) — nobody can ever change the fee rate again"}`);
  console.log(`withdraw_withheld_authority:   ${withdrawAuthority ?? "None (zeroed) — nobody can harvest withheld fees"}`);

  console.log(`\n--- Fee schedule ---`);
  console.log(`Current on-chain epoch: ${currentEpochInfo.epoch}`);
  console.log(`older_transfer_fee: epoch=${olderEpoch}, basis_points=${olderBps} (${(Number(olderBps) / 100).toFixed(2)}%), max_fee=${olderMaxFee}`);
  console.log(`newer_transfer_fee: epoch=${newerEpoch}, basis_points=${newerBps} (${(Number(newerBps) / 100).toFixed(2)}%), max_fee=${newerMaxFee}`);
  console.log(`withheld_amount currently sitting unharvested in this mint's own withholding: ${withheldAmount}`);

  console.log(`\n--- Conclusion ---`);
  if (!configAuthority) {
    console.log("transfer_fee_config_authority is None: the 4.1% (or whatever basis-points value is live) fee rate is PERMANENTLY FIXED on-chain. Nobody — not the team, not a future governance vote — can ever change it again, the same way mint authority being revoked makes supply permanently fixed.");
  } else {
    console.log(`transfer_fee_config_authority is set to ${configAuthority}. Whoever controls that key/account CAN change the fee rate (subject to Token-2022's mandatory scheduling: a new rate only becomes effective from a future epoch onward, never retroactively). This is not permanently fixed.`);
  }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
