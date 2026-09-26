import { PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";

// Repointed to the v2 multisig, 26 Sept 2026 (was the retired v1 multisig,
// AF8qvhgkZJJE6ascFN4MAwWSEGKpyi6oW6Ht9CySgkmX deriving vault
// 3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg -- see TREASURY.md).
const MULTISIG_PDA = new PublicKey("5yxBrrC3h1PncGayMtAuWtvTx7MSUy2DJfdrnQ72FJGr");
const KNOWN_VAULT_0 = "GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA";

for (const idx of [0, 1]) {
  const [vaultPda, bump] = multisig.getVaultPda({
    multisigPda: MULTISIG_PDA,
    index: idx,
  });
  console.log(`Vault index ${idx}: ${vaultPda.toBase58()} (bump ${bump})`);
}
console.log(`Known vault 0 (from TREASURY_V2.md/MINT_V2.md): ${KNOWN_VAULT_0}`);
