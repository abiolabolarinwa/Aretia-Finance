/* global process */
// Deployment helper and verifier for the two EVM helper contracts: AretiaCurveRescue and AretiaPairSeeder. It NEVER holds a key, signs or
// sends anything: `prepare` and `verify` only read the chain.
//
//   npm i --no-save viem
//   node scripts/evm-helpers-mainnet.mjs prepare --chain ethereum --helper rescue     read-only checks, gas estimate, writes the unsigned creation data
//   node scripts/evm-helpers-mainnet.mjs prepare --chain ethereum --helper seeder
//   node scripts/evm-helpers-mainnet.mjs verify  --chain ethereum --helper rescue --address 0x...
//   DEPLOYER_KEY_FILE=<file> node scripts/evm-helpers-mainnet.mjs send --chain ethereum --helper rescue --yes-mainnet   deploys it (reads a key; owner's machine only)
//
// Chains: ethereum, bnb, polygon. You deploy the data `prepare` writes yourself, from the owner's own wallet (a contract-creation
// transaction: no "to", value 0, that data). Then run `verify` on the address it created. Only after `verify` passes is the address written
// into EVM_CURVE_RESCUE_ADDRESSES (walletCurveEvmCore.ts) or EVM_PAIR_SEEDER_ADDRESSES (walletPoolEvmCore.ts), by hand.
//
// Both helpers hold nothing, have no owner and no upgrade path. They are NOT independently audited. See docs/BONDING_CURVE_EVM.md section 16.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const require = createRequire(import.meta.url);
const { createPublicClient, http, isAddress, keccak256 } = require('viem');

/** The audited curve, deployed at the same address on all three chains. */
const CURVE = '0x4e85bc5bd6f08fa87ceb749372e34226556837e8';
// The exchange router, the exchange's factory and the wrapped coin, as in curve-mainnet.mjs. They are re-read from the chain below.
const CHAINS = {
  ethereum: { chainId: 1, coin: 'ETH', rpc: 'https://ethereum-rpc.publicnode.com', router: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', exFactory: '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f', wrapped: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
  bnb: { chainId: 56, coin: 'BNB', rpc: 'https://bsc-rpc.publicnode.com', router: '0x10ed43c718714eb63d5aa57b78b54704e256024e', exFactory: '0xca143ce32fe78f1f7019d7d551a6402fc5350c73', wrapped: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' },
  polygon: { chainId: 137, coin: 'POL', rpc: 'https://polygon-bor-rpc.publicnode.com', router: '0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff', exFactory: '0x5757371414417b8c6caad45baef941abc7d3ab32', wrapped: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270' },
};
const HELPERS = {
  rescue: { file: 'AretiaCurveRescue.artifact.json', name: 'AretiaCurveRescue', runtimeSha256: '2035a510b035a908ed1ec558676b1b262465c3456498997e3c34d9172b568d1e', slot: 'EVM_CURVE_RESCUE_ADDRESSES (walletCurveEvmCore.ts)' },
  seeder: { file: 'AretiaPairSeeder.artifact.json', name: 'AretiaPairSeeder', runtimeSha256: 'e65f98ae048c927a6e585cd406ad9c2d2f468fa12acd1655e0ed515c892a9b43', slot: 'EVM_PAIR_SEEDER_ADDRESSES (walletPoolEvmCore.ts)' },
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

const mode = process.argv[2];
const chainKey = arg('chain');
const helperKey = arg('helper');
const net = CHAINS[chainKey];
const helper = HELPERS[helperKey];
if (!['prepare', 'verify', 'send'].includes(mode) || !net || !helper) fail(`usage: evm-helpers-mainnet.mjs prepare|verify|send --chain ${Object.keys(CHAINS).join('|')} --helper rescue|seeder [--address 0x...] [--rpc url]`);
const rpc = arg('rpc') ?? net.rpc;

const art = JSON.parse(readFileSync(join(root, 'contracts-evm', helper.file), 'utf8')).helper;
const pub = createPublicClient({ transport: http(rpc) });
const tail = (d) => '0x' + d.slice(-40).toLowerCase();
const call = async (to, data) => (await pub.call({ to, data })).data ?? '0x';
const pad = (a) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const sel = (sig) => '0x' + art.selectors[sig];

console.log(`chain ${chainKey}, helper ${helper.name}, node ${rpc}`);
const reported = await pub.getChainId();
if (reported !== net.chainId) fail(`the node reports chain ${reported}, expected ${net.chainId}.`);
ok(`node is chain ${reported}`);

// The committed build is the one the docs pin (docs/BONDING_CURVE_EVM.md section 16): as compiled, immutables are zero.
const compiledSha = createHash('sha256').update(Buffer.from(art.deployedBytecode.replace(/^0x/, ''), 'hex')).digest('hex');
if (compiledSha !== helper.runtimeSha256) fail(`the committed ${helper.name} build has runtime sha-256 ${compiledSha}, not the pinned ${helper.runtimeSha256}. Do not deploy it.`);
ok(`committed build matches the pinned runtime sha-256 ${compiledSha}`);

for (const [label, addr] of [['exchange router', net.router], ['exchange factory', net.exFactory], ['wrapped coin', net.wrapped], ...(helperKey === 'rescue' ? [['Aretia curve', CURVE]] : [])]) {
  const code = await pub.getCode({ address: addr });
  if (!code || code === '0x') fail(`no contract at the ${label} ${addr} on ${chainKey}.`);
  ok(`${label} ${addr} has code`);
}
if (tail(await call(net.router, '0xad5c4648')) !== net.wrapped) fail('the router reports a different wrapped coin.');
if (tail(await call(net.router, '0xc45a0155')) !== net.exFactory) fail('the router reports a different exchange factory.');
ok('router points at the expected exchange factory and wrapped coin');
if (helperKey === 'rescue') {
  const curveSel = (s) => '0x' + JSON.parse(readFileSync(join(root, 'contracts-evm', 'AretiaCurve.artifact.json'), 'utf8')).curve.selectors[s];
  if (tail(await call(CURVE, curveSel('router()'))) !== net.router) fail('the curve on this chain points at a different router.');
  if (tail(await call(CURVE, curveSel('weth()'))) !== net.wrapped) fail('the curve on this chain points at a different wrapped coin.');
  ok('the curve points at this chain\'s router and wrapped coin');
}

const constructorArg = helperKey === 'rescue' ? CURVE : net.router;
const creation = `0x${art.bytecode.replace(/^0x/, '')}${pad(constructorArg)}`;
// The runtime code this creation data produces, by running the constructor in a read-only call. A deployed helper must equal it exactly
// (the curve / router and what it reads from them are immutables, so part of the code), so `verify` needs nothing but this.
const expectedRuntime = (await pub.call({ data: creation })).data;
if (!expectedRuntime || expectedRuntime === '0x') fail('the constructor does not run to the end on this network.');
const codeHash = keccak256(expectedRuntime);

if (mode === 'prepare') {
  const out = join(process.cwd(), `${helperKey}-${chainKey}-creation.json`);
  writeFileSync(out, JSON.stringify({ chain: chainKey, chainId: net.chainId, to: null, value: '0', data: creation, constructor: helperKey === 'rescue' ? { curve: CURVE } : { router: net.router }, expectedRuntimeKeccak: codeHash }, null, 2));
  ok(`constructor runs; the runtime is ${(expectedRuntime.length - 2) / 2} bytes, keccak ${codeHash}`);
  try {
    const gas = await pub.estimateGas({ account: '0x00000000000000000000000000000000000c0de1', data: creation });
    const price = await pub.getGasPrice();
    const cost = gas * price;
    console.log(`  gas about ${gas}, at ${price} wei per gas right now about ${Number(cost) / 1e18} ${net.coin} (budget double that: gas prices move)`);
  } catch (e) {
    console.log(`  gas could not be estimated here: ${String(e.shortMessage ?? e.message).split('\n')[0]}`);
  }
  console.log(`\nWrote ${out}`);
  console.log('Deploy it as a contract-creation transaction (no "to", value 0, this data) from the owner wallet. Nothing was signed or sent.');
  console.log(`Then: node scripts/evm-helpers-mainnet.mjs verify --chain ${chainKey} --helper ${helperKey} --address <the new contract>`);
  process.exit(0);
}

if (mode === 'send') {
  // For the OWNER to run on their own machine only; this session never runs it. The contract has no owner, so the deploying wallet gets no power
  // over it: use a wallet holding only enough coin for gas. DEPLOYER_KEY_FILE=<file with one 0x key> node scripts/evm-helpers-mainnet.mjs send --chain ethereum --helper rescue --yes-mainnet
  if (!process.argv.includes('--yes-mainnet')) fail('send puts a real contract on a real network. Add --yes-mainnet to confirm.');
  const file = process.env.DEPLOYER_KEY_FILE;
  if (!file) fail('send needs DEPLOYER_KEY_FILE, a file holding one 0x private key (a wallet funded only for gas).');
  const key = readFileSync(file, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail('the key file must hold one 0x-prefixed 64-digit private key and nothing else.');
  const { createWalletClient } = require('viem');
  const { privateKeyToAccount } = require('viem/accounts');
  const account = privateKeyToAccount(key);
  const gas = await pub.estimateGas({ account: account.address, data: creation });
  const price = await pub.getGasPrice();
  const balance = await pub.getBalance({ address: account.address });
  const limit = (gas * 12n) / 10n;
  console.log(`  deployer ${account.address}  balance ${balance} wei`);
  console.log(`  gas about ${gas} at ${price} wei, so about ${gas * price} wei; worst case with a 20% margin ${limit * price} wei`);
  if (balance < limit * price) fail('the deployer wallet does not hold enough coin for gas.');
  const wallet = createWalletClient({ account, transport: http(rpc) });
  const hash = await wallet.sendTransaction({ data: creation, chain: null, gas: limit });
  console.log(`  sent ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) fail(`the deployment failed (${hash}).`);
  console.log(`  deployed at ${receipt.contractAddress.toLowerCase()}; run verify on it next`);
  process.exit(0);
}

const address = arg('address');
if (!address || !isAddress(address)) fail('verify needs --address 0x... of the deployed helper.');
const live = await pub.getCode({ address });
if (!live || live === '0x') fail(`no contract at ${address}.`);
if (live.toLowerCase() !== expectedRuntime.toLowerCase()) fail(`the code at ${address} is NOT the committed ${helper.name} build for ${chainKey} (keccak ${keccak256(live)}, expected ${codeHash}). Do not use it.`);
ok(`code at ${address} is byte-for-byte the committed build (keccak ${codeHash})`);
const read = async (sig) => call(address, sel(sig));
const checks = helperKey === 'rescue' ? [['curve()', CURVE], ['weth()', net.wrapped], ['pairFactory()', net.exFactory]] : [['router()', net.router], ['weth()', net.wrapped], ['pairFactory()', net.exFactory]];
for (const [sig, want] of checks) {
  if (tail(await read(sig)) !== want) fail(`${sig} does not read back ${want}.`);
  ok(`${sig} = ${want}`);
}
const held = await pub.getBalance({ address });
ok(`holds ${held} wei (it is meant to hold nothing)`);
console.log(`\nVerified. Next, by hand: put ${address.toLowerCase()} in ${helper.slot} for ${chainKey}, update the test that pins it as null, and verify the source on the explorer (contracts-evm/VERIFY.md).`);
