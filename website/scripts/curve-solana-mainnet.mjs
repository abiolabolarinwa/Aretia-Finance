/* global process */
// Mainnet deployment helper for the Aretia Solana bonding curve. It NEVER holds a key, signs or sends anything.
//
//   node scripts/curve-solana-mainnet.mjs prepare                       read-only checks, then prints the deploy commands
//   node scripts/curve-solana-mainnet.mjs verify --program <address>    checks a deployed program is exactly the audited build
//
// You deploy the printed commands yourself, from your own wallet with the `solana` command line. Then run `verify` on the program id.
// Only after `verify` passes is the id put in CURVE_PROGRAM_ID_MAINNET (walletCurveCore.ts), by hand.
//
// What it checks on chain, and what it will not let pass:
//   - the program is the upgradeable loader's, executable, and its bytes are exactly the committed build (sha-256 of the build, and
//     nothing but zeros after it in the program's data account);
//   - the build was made for this program id (the id is written into the program at build time, and must be found inside it);
//   - the upgrade authority is the treasury multisig vault and nobody else: a single key that can replace the program can take every vault;
//   - Meteora's pool program is there, and the fee wallet already holds at least the rent minimum (a trade whose fee would leave an empty
//     wallet below it fails; see docs/BONDING_CURVE.md section 6, risk 16).
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const METEORA = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
/** The treasury's Squads 2-of-3 vault (index 0): the upgrade authority. See TREASURY_V2.md. */
const MULTISIG_VAULT = 'GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA';
/** Where every trade's fee goes: the management-fee wallet (MANAGEMENT_FEE.md). */
const FEE_WALLET = '2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2';
const RENT_MIN_EMPTY_ACCOUNT = 890_880n; // lamports, a zero-data account

const CLUSTERS = {
  mainnet: { name: 'mainnet-beta', rpc: 'https://solana-rpc.publicnode.com', genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' },
  devnet: { name: 'devnet', rpc: 'https://api.devnet.solana.com', genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' },
};

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const fail = (msg) => {
  console.error(`Stop: ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`  ok   ${msg}`);
const sol = (lamports) => `${(Number(lamports) / 1e9).toFixed(4)} SOL`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const mode = process.argv[2];
const clusterKey = arg('cluster') ?? 'mainnet';
const cluster = CLUSTERS[clusterKey];
if (!['prepare', 'verify'].includes(mode) || !cluster) fail('usage: curve-solana-mainnet.mjs prepare|verify [--program <address>] [--cluster mainnet|devnet] [--rpc url] [--artifact path]');
const conn = new Connection(arg('rpc') ?? cluster.rpc, 'confirmed');
// The node must be on the cluster named: a devnet node given with --cluster mainnet would otherwise "verify" a devnet program.
const genesis = await conn.getGenesisHash().catch((e) => fail(`could not read the genesis hash from the node (${e instanceof Error ? e.message : e}).`));
if (genesis !== cluster.genesis) fail(`the node at ${arg('rpc') ?? cluster.rpc} is not on ${cluster.name}: its genesis hash is ${genesis}, ${cluster.name}'s is ${cluster.genesis}.`);

const artifactPath = arg('artifact') ?? join(root, 'program', 'aretia-curve', 'artifacts', 'aretia_curve.so');
const so = readFileSync(artifactPath);
const soSha = sha256(so);
const pinned = readFileSync(`${artifactPath}.sha256`, 'utf8').trim().split(/\s+/)[0];
if (pinned !== soSha) fail(`${artifactPath} does not match its recorded sha-256 (${pinned}). Do not deploy it.`);
// A build made before a fix to the program source is marked stale next to it; it must be rebuilt and retested, never deployed.
if (existsSync(`${artifactPath}.STALE`)) fail(`${artifactPath} was built before a fix to the program source (see ${artifactPath}.STALE). Rebuild it and run the program tests before deploying.`);

console.log(`cluster ${cluster.name} (genesis ${genesis}), build ${artifactPath}`);
ok(`build is ${so.length} bytes, sha-256 ${soSha}`);

const account = async (address) => conn.getAccountInfo(new PublicKey(address), 'confirmed');

async function commonChecks() {
  const meteora = await account(METEORA);
  if (!meteora?.executable) fail(`Meteora's pool program ${METEORA} is not on ${cluster.name}.`);
  ok(`Meteora pool program ${METEORA} is on ${cluster.name}`);
  const fee = await account(FEE_WALLET);
  if (!fee || BigInt(fee.lamports) < RENT_MIN_EMPTY_ACCOUNT) fail(`the fee wallet ${FEE_WALLET} holds ${sol(fee?.lamports ?? 0)}: fund it with at least 0.002 SOL first, or the first small trade would fail.`);
  ok(`fee wallet ${FEE_WALLET} holds ${sol(fee.lamports)}`);
}

if (mode === 'prepare') {
  await commonChecks();
  // The upgradeable loader keeps the program in a data account of (45-byte header + max length) bytes, and a small program account (36 bytes).
  // `solana program deploy` sizes the data account to the build itself unless --max-len says otherwise (checked with solana-cli 4.2.1), and the
  // commands below pass --max-len explicitly. Rent is asked from the node here: 2026-10-23 it was 5,080 lamports per byte of (128 + length); the older figure of 6,960 gave the 2.75 SOL once quoted.
  const maxLen = Number(arg('max-len') ?? so.length);
  if (!Number.isInteger(maxLen) || maxLen < so.length) fail(`--max-len must be at least the build's ${so.length} bytes.`);
  const dataRent = await conn.getMinimumBalanceForRentExemption(45 + maxLen);
  const programRent = await conn.getMinimumBalanceForRentExemption(36);
  const rent = dataRent + programRent;
  // The upload buffer (the same size again) is refunded to the payer inside the deploy instruction before the data account is paid for, so the
  // wallet never needs the rent twice. A deploy that runs short stops with the buffer kept: top up and resume it with --buffer.
  console.log(`\nCost: ${sol(rent)} of rent (${dataRent} lamports for the program data account of ${45 + maxLen} bytes + ${programRent} for the program account), which stays locked in those accounts, plus about 0.003 SOL of network fees for the roughly 400 upload transactions. Fund the deployer with ${sol(rent + 50_000_000)} (rent, fees and a margin); what is left over stays in the deployer.`);
  console.log("The 2.75 SOL once quoted, and the 1.6133 SOL measured on devnet for a smaller, older build (about 231 KB), both used the old rent rate of 6,960 lamports per byte; the node's rate is lower now.");
  console.log("Doing this deploys code that holds buyers' money and is NOT independently audited. It is the owner's call, from the owner's own wallet.\n");
  console.log(`0. BEFORE deploying, re-run the program tests with Meteora's CURRENT mainnet binary (six migration and fee tests skip without it). From the repo root, PowerShell:
     solana program dump cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG meteora_cp_amm.so --url ${cluster.name}
     $env:METEORA_CP_AMM_SO = (Resolve-Path meteora_cp_amm.so).Path
     $env:ARETIA_CURVE_SO = (Resolve-Path program\\aretia-curve\\artifacts\\aretia_curve.so).Path
     cargo test --manifest-path program\\aretia-curve\\tests\\Cargo.toml
     All tests must pass with none skipped; if any fails, do not deploy.\n`);
  console.log(`1. Make the program's own key once, and keep it (it signs only this first deployment). Print its address:
     solana-keygen new --no-bip39-passphrase --outfile <folder>\\aretia-curve-program.json
     solana address --keypair <folder>\\aretia-curve-program.json
     The address must be CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu, the id written into this build. If it is not, the build must be remade (docs/BONDING_CURVE.md).\n`);
  console.log(`2. Deploy the committed build, signing with your own wallet (the deployer):
     solana program deploy "${artifactPath}" --program-id <folder>\\aretia-curve-program.json --max-len ${maxLen} --keypair <your-deployer-keypair.json> --url ${cluster.name}\n`);
  console.log(`3. Hand the upgrade authority to the treasury multisig straight away. After this, nobody alone can replace the program:
     solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority ${MULTISIG_VAULT} --skip-new-upgrade-authority-signer-check --keypair <your-deployer-keypair.json> --url ${cluster.name}\n`);
  console.log(`4. Check it, and send me only the program id:
     node scripts/curve-solana-mainnet.mjs verify --program <PROGRAM_ID>${clusterKey === 'devnet' ? ' --cluster devnet' : ''}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------- verify
const programId = arg('program');
if (!programId) fail('verify needs --program <address>');
let programKey;
try {
  programKey = new PublicKey(programId);
} catch {
  fail(`"${programId}" is not a Solana address.`);
}

await commonChecks();

const program = await conn.getAccountInfo(programKey, 'confirmed');
if (!program) fail(`there is no account at ${programId} on ${cluster.name}.`);
if (program.owner.toBase58() !== LOADER || !program.executable) fail(`${programId} is not an executable program of the upgradeable loader.`);
const header = Buffer.from(program.data);
if (header.length !== 36 || header.readUInt32LE(0) !== 2) fail('the program account has an unexpected layout.');
const dataAddress = new PublicKey(header.subarray(4, 36));
ok(`${programId} is an upgradeable program, data account ${dataAddress.toBase58()}`);

const pd = await conn.getAccountInfo(dataAddress, 'confirmed');
if (!pd || pd.owner.toBase58() !== LOADER) fail('the program data account is missing or not the loader\'s.');
const d = Buffer.from(pd.data);
if (d.length < 45 || d.readUInt32LE(0) !== 3) fail('the program data account has an unexpected layout.');
const hasAuthority = d[12] === 1;
const authority = hasAuthority ? new PublicKey(d.subarray(13, 45)).toBase58() : null;
const elf = d.subarray(45);
if (elf.length < so.length) fail(`the deployed program is ${elf.length} bytes, shorter than the build (${so.length}).`);
const deployed = elf.subarray(0, so.length);
if (sha256(deployed) !== soSha) fail(`the deployed program is NOT the committed build (its sha-256 is ${sha256(deployed)}, the build's is ${soSha}).`);
if (elf.subarray(so.length).some((b) => b !== 0)) fail('the program data account has extra non-zero bytes after the build.');
ok(`the deployed bytes are exactly the committed build (sha-256 ${soSha})`);
if (!so.includes(programKey.toBytes())) fail(`this build was made for a different program id: ${programId} is not written into it. Remake the build for this id.`);
ok('the build was made for this program id');

if (authority === null) fail('the program is FINAL (no upgrade authority). That is permanent; confirm that was meant before using it.');
if (authority !== MULTISIG_VAULT) fail(`the upgrade authority is ${authority}, not the treasury multisig vault ${MULTISIG_VAULT}. One key that can replace the program can take every vault: run step 3.`);
ok(`the upgrade authority is the treasury multisig vault ${MULTISIG_VAULT}`);

console.log(`\nVerified. Next, by hand: put ${programId} in CURVE_PROGRAM_ID_MAINNET (walletCurveCore.ts), update the gate test, and rehearse with a small curve (docs/MAINNET_GO_LIVE.md, step 4 has the exact edit).`);
