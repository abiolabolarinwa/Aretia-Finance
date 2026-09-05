import { PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";

const MULTISIG_PDA = new PublicKey("AF8qvhgkZJJE6ascFN4MAwWSEGKpyi6oW6Ht9CySgkmX");
const KNOWN_VAULT_0 = "3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg";

for (const idx of [0, 1]) {
  const [vaultPda, bump] = multisig.getVaultPda({
    multisigPda: MULTISIG_PDA,
    index: idx,
  });
  console.log(`Vault index ${idx}: ${vaultPda.toBase58()} (bump ${bump})`);
}
console.log(`Known vault 0 (from TREASURY.md/MINT.md): ${KNOWN_VAULT_0}`);
