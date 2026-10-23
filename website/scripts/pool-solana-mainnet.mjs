/* global process */
// Deployment helper for the Aretia Pool Solana program. It NEVER holds a key, signs or sends anything.
//
//   node scripts/pool-solana-mainnet.mjs prepare [--cluster devnet]                 read-only checks, then prints the deploy commands
//   node scripts/pool-solana-mainnet.mjs verify --program <address> [--cluster devnet]   checks a deployed program is exactly the committed build
//
// MAINNET IS NOT DEPLOYED and the program is UNAUDITED. On mainnet, `verify` demands the treasury multisig as the upgrade authority.
// On devnet it only reports the authority (the devnet test wallet holds it). See docs/ARETIA_POOL.md section 13.
//
// The committed build was made for the DEVNET program id. A mainnet build needs its own id: remake it, commit the new artifact and its sha-256.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
/** The treasury's Squads 2-of-3 vault (index 0): the upgrade authority on mainnet. See TREASURY_V2.md. */
const MULTISIG_VAULT = 'GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA';
const FEE_WALLET = '2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2';
const RENT_MIN_EMPTY_ACCOUNT = 890_880n;
/** The id the committed build is made for: the devnet test program. A mainnet build has its own id. */
const DEVNET_ID = '4EBVWVYhHSo2MZUKfEV32JqcJ2jEorZbRagY63H4pGmc';
const DEVNET_ID_BYTES = new PublicKey(DEVNET_ID).toBytes();

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
if (!['prepare', 'verify'].includes(mode) || !cluster) fail('usage: pool-solana-mainnet.mjs prepare|verify [--program <address>] [--cluster mainnet|devnet] [--rpc url] [--artifact path]');
const conn = new Connection(arg('rpc') ?? cluster.rpc, 'confirmed');
// The node must be on the cluster named: a devnet node given with --cluster mainnet would otherwise "verify" a devnet program.
const genesis = await conn.getGenesisHash().catch((e) => fail(`could not read the genesis hash from the node (${e instanceof Error ? e.message : e}).`));
if (genesis !== cluster.genesis) fail(`the node at ${arg('rpc') ?? cluster.rpc} is not on ${cluster.name}: its genesis hash is ${genesis}, ${cluster.name}'s is ${cluster.genesis}.`);

const artifactPath = arg('artifact') ?? join(root, 'program', 'aretia-pool', 'artifacts', 'aretia_pool.so');
const so = readFileSync(artifactPath);
const soSha = sha256(so);
const pinned = readFileSync(`${artifactPath}.sha256`, 'utf8').trim().split(/\s+/)[0];
if (pinned !== soSha) fail(`${artifactPath} does not match its recorded sha-256 (${pinned}). Do not deploy it.`);
// A build made before a fix to the program source is marked stale next to it; it must be rebuilt and retested, never deployed.
if (existsSync(`${artifactPath}.STALE`)) fail(`${artifactPath} was built before a fix to the program source (see ${artifactPath}.STALE). Rebuild it and run the program tests before deploying.`);

console.log(`cluster ${cluster.name} (genesis ${genesis}), build ${artifactPath}`);
ok(`build is ${so.length} bytes, sha-256 ${soSha}`);

async function commonChecks() {
  const fee = await conn.getAccountInfo(new PublicKey(FEE_WALLET), 'confirmed');
  if (!fee || BigInt(fee.lamports) < RENT_MIN_EMPTY_ACCOUNT) {
    const msg = `the fee wallet ${FEE_WALLET} holds ${sol(fee?.lamports ?? 0)}: fund it with at least 0.002 SOL first, or a small fee payment would fail.`;
    if (clusterKey === 'mainnet') fail(msg);
    console.log(`  note ${msg} (devnet: the tests fund it themselves)`);
  } else ok(`fee wallet ${FEE_WALLET} holds ${sol(fee.lamports)}`);
}

if (mode === 'prepare') {
  await commonChecks();
  // The data account is (45-byte header + max length) bytes plus a 36-byte program account; rent is asked from the node (2026-10-23: 5,080 lamports per byte of (128 + length); it was 6,960 before).
  // `solana program deploy` sizes the data account to the build unless --max-len says otherwise (solana-cli 4.2.1); the command passes it explicitly.
  const maxLen = Number(arg('max-len') ?? so.length);
  if (!Number.isInteger(maxLen) || maxLen < so.length) fail(`--max-len must be at least the build's ${so.length} bytes.`);
  const dataRent = await conn.getMinimumBalanceForRentExemption(45 + maxLen);
  const programRent = await conn.getMinimumBalanceForRentExemption(36);
  const rent = dataRent + programRent;
  console.log(`\nCost: ${sol(rent)} of rent (${dataRent} lamports for the data account of ${45 + maxLen} bytes + ${programRent} for the program account), locked in the program's accounts, plus about 0.003 SOL of network fees. Fund the deployer with ${sol(rent + 50_000_000)}. The upload buffer is refunded inside the deploy instruction, so the rent is not needed twice.`);
  console.log("This code holds people's money and is NOT independently audited. Deploying to mainnet is the owner's call, from the owner's own wallet.");
  if (!so.includes(DEVNET_ID_BYTES)) console.log('  note this build does not contain the devnet id; it may already be a mainnet build.');
  else console.log(`\nSTOP: the committed build was made for the DEVNET program id ${DEVNET_ID}. A mainnet program needs its own id written into a rebuilt program (docs/MAINNET_GO_LIVE.md, step 5). Do not deploy this file to mainnet: verify would refuse it, and the program would be unusable.`);
  console.log(`\n1. Deploy the MAINNET build, signing with the deployer (the program key is the one whose address is written into the build):
     solana program deploy "${artifactPath}" --program-id <folder>\\aretia-pool-program.json --max-len ${maxLen} --keypair <deployer-keypair.json> --url ${cluster.name}\n`);
  console.log(`2. Hand the upgrade authority to the treasury multisig straight away (mainnet):
     solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority ${MULTISIG_VAULT} --skip-new-upgrade-authority-signer-check --keypair <deployer-keypair.json> --url ${cluster.name}\n`);
  console.log(`3. Check it:
     node scripts/pool-solana-mainnet.mjs verify --program <PROGRAM_ID>${clusterKey === 'devnet' ? ' --cluster devnet' : ''}\n`);
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
const authority = d[12] === 1 ? new PublicKey(d.subarray(13, 45)).toBase58() : null;
const elf = d.subarray(45);
if (elf.length < so.length) fail(`the deployed program is ${elf.length} bytes, shorter than the build (${so.length}).`);
if (sha256(elf.subarray(0, so.length)) !== soSha) fail(`the deployed program is NOT the committed build (its sha-256 is ${sha256(elf.subarray(0, so.length))}, the build's is ${soSha}).`);
if (elf.subarray(so.length).some((b) => b !== 0)) fail('the program data account has extra non-zero bytes after the build.');
ok(`the deployed bytes are exactly the committed build (sha-256 ${soSha})`);
if (!so.includes(programKey.toBytes())) fail(`this build was made for a different program id: ${programId} is not written into it.`);
ok('the build was made for this program id');

if (clusterKey === 'mainnet') {
  if (authority === null) fail('the program is FINAL (no upgrade authority). That is permanent; confirm that was meant.');
  if (authority !== MULTISIG_VAULT) fail(`the upgrade authority is ${authority}, not the treasury multisig vault ${MULTISIG_VAULT}. Run step 2.`);
  ok(`the upgrade authority is the treasury multisig vault ${MULTISIG_VAULT}`);
  console.log(`\nVerified. Next, by hand: put ${programId} in ARETIA_POOL_PROGRAM_ID_MAINNET (walletAretiaPoolCore.ts) and update the gate test. Not before an audit.`);
} else {
  console.log(`  note upgrade authority on devnet: ${authority ?? 'none (final)'} (not the multisig; fine for a test network, NOT for mainnet)`);
  console.log('\nVerified on devnet.');
}
