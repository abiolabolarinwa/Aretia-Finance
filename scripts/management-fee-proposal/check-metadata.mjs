import { Connection, PublicKey } from "@solana/web3.js";

const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "https://solana-rpc.publicnode.com";
const MINT = new PublicKey("BmaBEY6NDbLevUcU59Fgie8JHeqD4UjEFJda8LuSS2yT");
const METADATA_POINTER = 18;
const TOKEN_METADATA = 19;

function readU16LE(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, true);
}

async function main() {
  const connection = new Connection(RPC_ENDPOINT, "confirmed");
  const info = await connection.getAccountInfo(MINT, "confirmed");
  if (!info) throw new Error("mint account not found");
  const data = new Uint8Array(info.data);

  console.log(`Mint account total length: ${data.length} bytes`);
  console.log(`Base Mint struct: 82 bytes. AccountType boundary: 165 bytes.`);

  const ACCOUNT_TYPE_OFFSET = 165;
  const found = [];
  if (data.length > ACCOUNT_TYPE_OFFSET) {
    const accountType = data[ACCOUNT_TYPE_OFFSET];
    console.log(`AccountType byte at offset 165: ${accountType} (1 = Mint)`);
    let pos = ACCOUNT_TYPE_OFFSET + 1;
    while (pos + 4 <= data.length) {
      const extType = readU16LE(data, pos);
      const extLen = readU16LE(data, pos + 2);
      const extStart = pos + 4;
      if (extStart + extLen > data.length) {
        console.log(`  (stopping: extension at pos ${pos} claims length ${extLen}, exceeds remaining account data)`);
        break;
      }
      found.push({ type: extType, len: extLen, offset: pos });
      pos = extStart + extLen;
    }
  } else {
    console.log("Account data ends before the extension region even begins — no extensions of any kind.");
  }

  console.log(`\nExtensions found (${found.length}):`);
  found.forEach((e) => {
    let name = "type " + e.type;
    if (e.type === 1) name = "TransferFeeConfig";
    if (e.type === METADATA_POINTER) name = "MetadataPointer";
    if (e.type === TOKEN_METADATA) name = "TokenMetadata";
    console.log(`  - ${name} (type=${e.type}) at byte offset ${e.offset}, data length ${e.len}`);
  });

  const hasMetadataPointer = found.some((e) => e.type === METADATA_POINTER);
  const hasTokenMetadata = found.some((e) => e.type === TOKEN_METADATA);
  console.log(`\nMetadataPointer extension present: ${hasMetadataPointer}`);
  console.log(`TokenMetadata extension present: ${hasTokenMetadata}`);
  console.log(hasMetadataPointer
    ? "\n-> Native Token-2022 metadata IS possible (pointer slot already reserved)."
    : "\n-> Native Token-2022 metadata is NOT possible: MetadataPointer is a fixed-length extension and was never allocated at mint creation. It cannot be added retroactively.");
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
