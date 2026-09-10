#!/usr/bin/env node
/**
 * Aretia — ACT v2 Mint Creation
 * ------------------------------------------------------------------
 * Manual-run tool. It does NOT touch the live v1 mint or v1 treasury in
 * any way, and it does NOT execute anything by default.
 *
 * Creates the v2 ACT mint: a Solana Token-2022 asset with the
 * TransferFeeConfig extension (3.5% fee) and a MetadataPointer extension
 * bridged to a separate Metaplex Token Metadata account -- confirmed by
 * testing on devnet that Metaplex's createV1 requires the pointer to
 * reference its own metadata PDA (not the mint itself), which is the
 * actual supported way to make a Token-2022 mint's metadata visible to
 * both native-Token-2022-aware and legacy-Metaplex-aware tooling from one
 * canonical source, rather than maintaining two independent metadata
 * stores. Mints the full fixed supply once into the v2 treasury vault,
 * hands the two retained authorities to the v2 multisig, and permanently
 * revokes mint authority (the only authority left temporarily held by the
 * deployer by the time phase 5 runs) -- matching the "Path A" decision
 * recorded in WHITEPAPER.md Sec. 11 and TREASURY_V2.md.
 *
 * Run against devnet FIRST (the default) and verify every phase's result
 * on-chain before ever touching --network mainnet, per this project's own
 * established practice (see MINT.md's original deployment record).
 *
 * PHASES -- run one at a time, in order, verifying on-chain state between
 * each before moving to the next. This is deliberate: it is much safer to
 * confirm phase N actually did what it should before phase N+1 builds on
 * it, than to chain everything into one transaction and discover a problem
 * only after several irreversible steps have already run.
 *
 *   1  create     - create the mint account and initialize the
 *                   TransferFeeConfig and MetadataPointer extensions + the
 *                   base mint. MetadataPointer's authority is None from
 *                   creation (it has no revoke instruction -- see that
 *                   phase's comments); transfer-fee-config, withdraw-
 *                   withheld, and mint authority are temporarily held by
 *                   the deployer keypair, not yet handed off or revoked.
 *   2  metadata   - create the separate Metaplex metadata account that the
 *                   MetadataPointer set in phase 1 references
 *                   (isMutable: false from the start).
 *   3  supply     - create the v2 vault's associated token account and
 *                   mint the entire fixed supply into it. This is the
 *                   ONLY mint-to instruction this script ever issues.
 *   4  handoff    - transfer transfer-fee-config authority and
 *                   withdraw-withheld authority from the deployer to the
 *                   v2 multisig vault. Reversible in the sense that the
 *                   multisig could vote to change these again later (see
 *                   WHITEPAPER.md Sec. 14.2) -- NOT a permanent revocation.
 *   5  revoke     - PERMANENT AND IRREVERSIBLE. Revokes mint authority to
 *                   None -- the last authority still held by the deployer
 *                   at this point. Requires the extra
 *                   --i-understand-this-is-permanent flag in addition to
 *                   --execute. Run this only after independently verifying
 *                   every previous phase's on-chain result -- there is no
 *                   phase 6 that undoes it.
 *
 * Safety model:
 *   - Defaults to devnet. Pass --network mainnet explicitly for the real
 *     deployment, only after the full 1-5 sequence has been proven on
 *     devnet first.
 *   - Every phase dry-runs by default; pass --execute to actually submit.
 *   - Phase 5 additionally requires --i-understand-this-is-permanent.
 *   - The mint's own keypair is generated once (phase 1) and saved to
 *     disk next to this script as mint-keypair.<network>.json -- back it
 *     up; phases 2-5 read it back in. It is NOT a treasury or multisig
 *     key and holds no ongoing authority once phase 5 completes, but it
 *     is required to run phases 1-4, so do not delete it prematurely.
 *
 * Usage:
 *   npm install
 *   node create-mint-v2.mjs --phase create                                    # dry run
 *   DEPLOYER_KEYPAIR_PATH=/path/to/deployer.json \
 *     node create-mint-v2.mjs --phase create --execute                        # devnet, real
 *   ... repeat for --phase metadata, supply, handoff ...
 *   DEPLOYER_KEYPAIR_PATH=/path/to/deployer.json \
 *     node create-mint-v2.mjs --phase revoke --execute --i-understand-this-is-permanent
 *
 *   Add --network mainnet to any of the above once the full sequence is
 *   proven correct on devnet.
 *
 * DEPLOYER_KEYPAIR_PATH must point to a Solana CLI-style JSON keypair file
 * for a disposable wallet used only to pay fees and hold temporary
 * authority during setup -- matching v1's own deployer-keypair pattern in
 * MINT.md ("holds no ongoing authority ... can be discarded" once phase 5
 * completes). It should hold enough SOL to cover account rent (roughly
 * 0.01-0.02 SOL is comfortable) plus normal transaction fees.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeTransferFeeConfigInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  createSetAuthorityInstruction,
  AuthorityType,
} from "@solana/spl-token";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair, fromWeb3JsPublicKey, toWeb3JsPublicKey, toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import { createV1, findMetadataPda, TokenStandard } from "@metaplex-foundation/mpl-token-metadata";

// PDA derivation is pure and requires no identity/signer -- a bare Umi
// instance (no keypairIdentity) is enough to compute where the Metaplex
// metadata account for a given mint would live.
function getMetaplexMetadataPda(rpcEndpoint, mintPubkey) {
  const umi = createUmi(rpcEndpoint);
  const [pda] = findMetadataPda(umi, { mint: fromWeb3JsPublicKey(mintPubkey) });
  return toWeb3JsPublicKey(pda);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Settled parameters (see conversation record / WHITEPAPER.md / TREASURY_V2.md) ----
const TOKEN_NAME = "Aretia Finance Protocol";
const TOKEN_SYMBOL = "ACT";
const TOKEN_DECIMALS = 9;
const TOKEN_SUPPLY_WHOLE = 1_000_000_000n;
const TOKEN_SUPPLY_RAW = TOKEN_SUPPLY_WHOLE * 10n ** BigInt(TOKEN_DECIMALS);
const TRANSFER_FEE_BPS = 350; // 3.5%
const TRANSFER_FEE_MAX = BigInt("18446744073709551615"); // u64::MAX -- no absolute cap, matches v1's convention of a very high ceiling; revisit if a real cap is wanted
const METADATA_URI = "https://gateway.irys.xyz/F3xUCKiXTiVtr864MV2CyaQpmBLHnaroqTE8TuTPHxF3";
const V2_MULTISIG_VAULT = new PublicKey("GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA");

// ---- CLI ----
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const UNDERSTAND_PERMANENT = args.includes("--i-understand-this-is-permanent");
const phaseIdx = args.indexOf("--phase");
const PHASE = phaseIdx !== -1 ? args[phaseIdx + 1] : null;
const networkIdx = args.indexOf("--network");
const NETWORK = networkIdx !== -1 ? args[networkIdx + 1] : "devnet";
if (!["devnet", "mainnet"].includes(NETWORK)) throw new Error('--network must be "devnet" or "mainnet"');
const VALID_PHASES = ["create", "metadata", "supply", "handoff", "revoke"];
if (!VALID_PHASES.includes(PHASE)) {
  throw new Error(`--phase must be one of: ${VALID_PHASES.join(", ")}`);
}

const RPC_ENDPOINT =
  process.env.RPC_ENDPOINT ||
  (NETWORK === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");

const MINT_KEYPAIR_PATH = path.join(__dirname, `mint-keypair.${NETWORK}.json`);

function log(...a) {
  console.log(...a);
}

function loadOrThrow(keypairPath, label) {
  if (!fs.existsSync(keypairPath)) {
    throw new Error(`${label} not found at ${keypairPath}`);
  }
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function getDeployer() {
  const p = process.env.DEPLOYER_KEYPAIR_PATH;
  if (!p) throw new Error("Set DEPLOYER_KEYPAIR_PATH to a Solana CLI-style JSON keypair file.");
  return loadOrThrow(p, "Deployer keypair");
}

function getOrCreateMintKeypair() {
  if (fs.existsSync(MINT_KEYPAIR_PATH)) {
    return loadOrThrow(MINT_KEYPAIR_PATH, "Mint keypair");
  }
  const kp = Keypair.generate();
  fs.writeFileSync(MINT_KEYPAIR_PATH, JSON.stringify(Array.from(kp.secretKey)));
  log(`Generated new mint keypair, saved to ${MINT_KEYPAIR_PATH}. Mint address: ${kp.publicKey.toBase58()}`);
  return kp;
}

async function sendPhase(connection, deployer, instructions, label, extraSigners = []) {
  if (!EXECUTE) {
    log(`\nDry run (${label}) - no transaction sent. Instructions that WOULD be sent:`);
    instructions.forEach((ix, i) =>
      log(`  [${i}] program=${ix.programId.toBase58()} keys=${ix.keys.length} dataLen=${ix.data.length}`)
    );
    log("\nRe-run with --execute (and DEPLOYER_KEYPAIR_PATH set) once this looks right.");
    return null;
  }
  const tx = new Transaction().add(...instructions);
  const signers = [deployer, ...extraSigners];
  const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
  log(`\n${label}: submitted and confirmed. Signature: ${sig}`);
  return sig;
}

async function main() {
  const connection = new Connection(RPC_ENDPOINT, "confirmed");
  const deployer = EXECUTE ? getDeployer() : (fs.existsSync(process.env.DEPLOYER_KEYPAIR_PATH || "") ? getDeployer() : Keypair.generate());
  const mintKeypair = getOrCreateMintKeypair();
  const mint = mintKeypair.publicKey;

  log(`Network: ${NETWORK}`);
  log(`Phase: ${PHASE}`);
  log(`Mint address: ${mint.toBase58()}`);
  if (EXECUTE) log(`Deployer: ${deployer.publicKey.toBase58()}`);

  if (PHASE === "create") {
    // The mint account is sized for the TransferFeeConfig and MetadataPointer
    // extensions only. There is no native Token-2022 TokenMetadata content on
    // this mint at all -- see the metadataAddress comment below for why -- so
    // the account never needs to grow beyond this fixed size.
    const mintLen = getMintLen([ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer]);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);
    log(`Mint account size: ${mintLen} bytes (final size -- no later growth needed). Rent-exempt lamports needed: ${lamports}`);

    const ixCreateAccount = SystemProgram.createAccount({
      fromPubkey: EXECUTE ? deployer.publicKey : PublicKey.default,
      newAccountPubkey: mint,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    });
    const ixTransferFee = createInitializeTransferFeeConfigInstruction(
      mint,
      deployer.publicKey, // transfer-fee-config authority -- temporary, handed to multisig in phase 4
      deployer.publicKey, // withdraw-withheld authority -- temporary, handed to multisig in phase 4
      TRANSFER_FEE_BPS,
      TRANSFER_FEE_MAX,
      TOKEN_2022_PROGRAM_ID
    );
    // The pointer targets the separate Metaplex metadata PDA, not the mint
    // itself. Metaplex's createV1 (phase "metadata") validates this exact
    // match and rejects a self-hosted pointer -- confirmed by running this
    // for real on devnet ("metadata address mismatch"). This is the actual
    // supported integration pattern: the pointer bridges native-Token-2022
    // tooling to the same Metaplex-hosted metadata that legacy tooling reads,
    // rather than maintaining two independent metadata stores.
    const metaplexMetadataPda = getMetaplexMetadataPda(RPC_ENDPOINT, mint);
    const ixMetadataPointer = createInitializeMetadataPointerInstruction(
      mint,
      null, // metadata-pointer authority -- None from the start. Token-2022's Update
      // instruction for this extension can only ever change metadataAddress, never
      // authority (confirmed from the SDK's own instruction-data layout, which has
      // no authority field at all) -- so a temporary authority here would be
      // permanent by accident, with no instruction able to later revoke it.
      metaplexMetadataPda,
      TOKEN_2022_PROGRAM_ID
    );
    const ixInitMint = createInitializeMint2Instruction(
      mint,
      TOKEN_DECIMALS,
      deployer.publicKey, // mint authority -- temporary, revoked to None in phase 5
      null, // freeze authority -- never granted, matching v1
      TOKEN_2022_PROGRAM_ID
    );

    await sendPhase(
      connection,
      deployer,
      [ixCreateAccount, ixTransferFee, ixMetadataPointer, ixInitMint],
      "Phase 1 (create)",
      [mintKeypair] // the new account being created must also sign
    );
    if (EXECUTE) {
      log("Note: the mint account creation instruction requires the mint keypair's own signature (it is the new account being created) in addition to the deployer's -- this is handled automatically by web3.js since Transaction.add of a createAccount instruction requires both signers.");
    }
    return;
  }

  if (PHASE === "metadata") {
    // There is no native Token-2022 TokenMetadata content on this mint --
    // the MetadataPointer extension (set in phase 1) bridges directly to the
    // Metaplex metadata account created here, rather than hosting separate
    // content on the mint itself. This means the mint account never grows
    // past its phase-1 size; no lamport top-up is needed for this phase.
    //
    // createMetadataAccountV3 (the older, legacy instruction) has no explicit
    // splTokenProgram account at all -- it silently assumes the classic SPL
    // Token program, and the Metaplex program itself rejects it for this
    // Token-2022 mint with "Instruction not supported for
    // ProgrammableNonFungible assets" (confirmed by running it for real on
    // devnet). createV1 is the newer, Token-2022-aware instruction: it takes
    // splTokenProgram explicitly and an explicit tokenStandard rather than
    // inferring one, which is what a plain fungible Token-2022 asset needs.
    const umi = createUmi(RPC_ENDPOINT).use(keypairIdentity(fromWeb3JsKeypair(EXECUTE ? deployer : Keypair.generate())));
    const [metaplexMetadataPda] = findMetadataPda(umi, { mint: fromWeb3JsPublicKey(mint) });
    const builder = createV1(umi, {
      metadata: metaplexMetadataPda,
      mint: fromWeb3JsPublicKey(mint),
      authority: umi.identity, // mint authority
      payer: umi.identity,
      updateAuthority: fromWeb3JsPublicKey(deployer.publicKey),
      splTokenProgram: fromWeb3JsPublicKey(TOKEN_2022_PROGRAM_ID),
      name: TOKEN_NAME,
      symbol: TOKEN_SYMBOL,
      uri: METADATA_URI,
      sellerFeeBasisPoints: 0,
      creators: null,
      collection: null,
      uses: null,
      collectionDetails: null,
      tokenStandard: TokenStandard.Fungible,
      decimals: TOKEN_DECIMALS,
      printSupply: null,
      isMutable: false, // permanent from creation -- no separate revoke step needed for the Metaplex side
    });
    const metaplexInstructions = builder.getInstructions().map(toWeb3JsInstruction);

    await sendPhase(connection, deployer, metaplexInstructions, "Phase 2 (metadata)");
    return;
  }

  if (PHASE === "supply") {
    const vaultAta = getAssociatedTokenAddressSync(mint, V2_MULTISIG_VAULT, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    log(`v2 vault's associated token account for this mint: ${vaultAta.toBase58()}`);

    const ixCreateAta = createAssociatedTokenAccountIdempotentInstruction(
      EXECUTE ? deployer.publicKey : PublicKey.default,
      vaultAta,
      V2_MULTISIG_VAULT,
      mint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const ixMintTo = createMintToInstruction(
      mint,
      vaultAta,
      deployer.publicKey,
      TOKEN_SUPPLY_RAW,
      [],
      TOKEN_2022_PROGRAM_ID
    );

    log(`This mints ${TOKEN_SUPPLY_WHOLE} whole ACT (${TOKEN_SUPPLY_RAW} raw units) -- the entire fixed supply, once, forever.`);
    await sendPhase(connection, deployer, [ixCreateAta, ixMintTo], "Phase 3 (supply)");
    return;
  }

  if (PHASE === "handoff") {
    const ixHandoffFeeConfig = createSetAuthorityInstruction(
      mint,
      deployer.publicKey,
      AuthorityType.TransferFeeConfig,
      V2_MULTISIG_VAULT,
      [],
      TOKEN_2022_PROGRAM_ID
    );
    const ixHandoffWithdraw = createSetAuthorityInstruction(
      mint,
      deployer.publicKey,
      AuthorityType.WithheldWithdraw,
      V2_MULTISIG_VAULT,
      [],
      TOKEN_2022_PROGRAM_ID
    );
    log(`This hands transfer-fee-config authority and withdraw-withheld authority to the v2 multisig vault (${V2_MULTISIG_VAULT.toBase58()}).`);
    log("This is NOT a permanent revocation -- the multisig can still change these later via 2-of-3 approval, per WHITEPAPER.md Sec. 14.2.");
    await sendPhase(connection, deployer, [ixHandoffFeeConfig, ixHandoffWithdraw], "Phase 4 (handoff)");
    return;
  }

  if (PHASE === "revoke") {
    if (EXECUTE && !UNDERSTAND_PERMANENT) {
      throw new Error(
        "Phase 'revoke' is permanent and irreversible. Re-run with --i-understand-this-is-permanent in addition to --execute once you have independently verified phases 1-4's on-chain results."
      );
    }
    // MetadataPointer authority was already None from phase 1 (there is no
    // native TokenMetadata content on this mint at all -- see phase
    // "create"/"metadata" comments). Only mint authority remains to be
    // revoked here.
    const ixRevokeMint = createSetAuthorityInstruction(
      mint,
      deployer.publicKey,
      AuthorityType.MintTokens,
      null,
      [],
      TOKEN_2022_PROGRAM_ID
    );
    log("This PERMANENTLY revokes: mint authority.");
    log("After this, NOTHING can ever create additional supply, by anyone, ever.");
    log("(MetadataPointer authority was None from creation. Freeze authority was never granted. Metaplex metadata was made immutable at creation in phase 2. None of those need a revoke step here.)");
    await sendPhase(
      connection,
      deployer,
      [ixRevokeMint],
      "Phase 5 (revoke) -- PERMANENT"
    );
    return;
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
