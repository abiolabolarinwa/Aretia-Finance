/* global process */
// Mainnet deployment helper for the Aretia bonding curve. It NEVER holds a key, signs or sends anything.
//
//   npm i --no-save viem
//   node scripts/curve-mainnet.mjs prepare --chain ethereum                    read-only checks, then writes the unsigned creation data
//   node scripts/curve-mainnet.mjs verify  --chain ethereum --address 0x...    checks a deployed curve is exactly the audited build
//
// Chains: ethereum, bnb, polygon. You deploy the printed data yourself, from the owner's own wallet or hardware wallet
// (a contract-creation transaction: no "to", the data below, zero value). Then run `verify` on the address it created.
// Only after `verify` passes is the address put in EVM_CURVE_ADDRESSES (and the flag turned on), by hand.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const require = createRequire(import.meta.url);
const { createPublicClient, http, isAddress, keccak256 } = require('viem');

const FEE_ADDRESS = '0xeb8725e16e504036c2166aa47804d88ecc4d0945';
// Token factory (the chain's Aretia launcher), the exchange router, and the exchange's own factory and wrapped coin, as in
// walletLaunchEvmCore.ts and walletPoolEvmCore.ts. They are re-read from the chain below, so a typo here cannot pass.
const CHAINS = {
  ethereum: { chainId: 1, rpc: 'https://ethereum-rpc.publicnode.com', factory: '0x951a22270faa7d1c25efad2356c414cbddaba324', router: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', exFactory: '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f', wrapped: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
  bnb: { chainId: 56, rpc: 'https://bsc-rpc.publicnode.com', factory: '0xc3eb98c45795cffb10b61178332cc6fcbbc0385c', router: '0x10ed43c718714eb63d5aa57b78b54704e256024e', exFactory: '0xca143ce32fe78f1f7019d7d551a6402fc5350c73', wrapped: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' },
  polygon: { chainId: 137, rpc: 'https://polygon-bor-rpc.publicnode.com', factory: '0xca1aa427ba5906d00377a835dd9b36b049034f0c', router: '0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff', exFactory: '0x5757371414417b8c6caad45baef941abc7d3ab32', wrapped: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270' },
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
const net = CHAINS[chainKey];
if (!['prepare', 'verify', 'send'].includes(mode) || !net) fail(`usage: curve-mainnet.mjs prepare|verify|send --chain ${Object.keys(CHAINS).join('|')} [--address 0x...] [--rpc url]`);
const rpc = arg('rpc') ?? net.rpc;

const art = JSON.parse(readFileSync(join(root, 'contracts-evm', 'AretiaCurve.artifact.json'), 'utf8'));
const pub = createPublicClient({ transport: http(rpc) });
const tail = (d) => '0x' + d.slice(-40).toLowerCase();
const call = async (to, data) => (await pub.call({ to, data })).data ?? '0x';
const pad = (a) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const sel = (sig) => '0x' + art.curve.selectors[sig];

console.log(`chain ${chainKey}, node ${rpc}`);
const reported = await pub.getChainId();
if (reported !== net.chainId) fail(`the node reports chain ${reported}, expected ${net.chainId}.`);
ok(`node is chain ${reported}`);

// 1. The three contracts the curve is pinned to are really what we think they are.
for (const [label, addr] of [['Aretia token factory', net.factory], ['exchange router', net.router], ['exchange factory', net.exFactory], ['wrapped coin', net.wrapped]]) {
  const code = await pub.getCode({ address: addr });
  if (!code || code === '0x') fail(`no contract at the ${label} ${addr} on ${chainKey}.`);
  ok(`${label} ${addr} has code`);
}
if (tail(await call(net.router, '0xad5c4648')) !== net.wrapped) fail('the router reports a different wrapped coin.');
if (tail(await call(net.router, '0xc45a0155')) !== net.exFactory) fail('the router reports a different exchange factory.');
ok('router points at the expected exchange factory and wrapped coin');
if (!isAddress(FEE_ADDRESS)) fail('fee address is not an address.');

const args = `${pad(net.factory)}${pad(FEE_ADDRESS)}${pad(net.router)}`;
const creation = `0x${art.curve.bytecode.replace(/^0x/, '')}${args}`;

// The runtime code this creation data produces, by running the constructor in a read-only call. A deployed curve must equal it exactly
// (the pinned addresses are part of the code), so `verify` needs nothing but this.
const expectedRuntime = (await pub.call({ data: creation })).data;
if (!expectedRuntime || expectedRuntime === '0x') fail('the constructor does not run to the end on this network.');
const codeHash = keccak256(expectedRuntime);

if (mode === 'prepare') {
  const out = join(process.cwd(), `curve-${chainKey}-creation.json`);
  writeFileSync(out, JSON.stringify({ chain: chainKey, chainId: net.chainId, to: null, value: '0', data: creation, constructor: { factory: net.factory, feeRecipient: FEE_ADDRESS, router: net.router }, expectedRuntimeKeccak: codeHash }, null, 2));
  ok(`constructor runs; the runtime is ${(expectedRuntime.length - 2) / 2} bytes, keccak ${codeHash}`);
  console.log(`\nWrote ${out}`);
  console.log('Deploy it as a contract-creation transaction (no "to", value 0, this data) from the owner wallet. Nothing was signed or sent.');
  console.log('Then: node scripts/curve-mainnet.mjs verify --chain', chainKey, '--address <the new contract>');
  process.exit(0);
}

if (mode === 'send') {
  // For the OWNER to run on their own machine. The contract has no owner, so the deploying wallet gets no power over it:
  // use a fresh wallet holding only enough coin for gas. DEPLOYER_KEY_FILE=<file with one 0x key> node scripts/curve-mainnet.mjs send --chain ethereum --yes-mainnet
  if (!process.argv.includes('--yes-mainnet')) fail('send puts a real contract on a real network. Add --yes-mainnet to confirm.');
  const file = process.env.DEPLOYER_KEY_FILE;
  if (!file) fail('send needs DEPLOYER_KEY_FILE, a file holding one 0x private key (a fresh wallet funded only for gas).');
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
if (!address || !isAddress(address)) fail('verify needs --address 0x... of the deployed curve.');
const live = await pub.getCode({ address });
if (!live || live === '0x') fail(`no contract at ${address}.`);
if (live.toLowerCase() !== expectedRuntime.toLowerCase()) fail(`the code at ${address} is NOT the audited build for ${chainKey} (keccak ${keccak256(live)}, expected ${codeHash}). Do not use it.`);
ok(`code at ${address} is byte-for-byte the audited build (keccak ${codeHash})`);
const read = async (sig) => call(address, sel(sig));
const checks = [
  ['factory()', net.factory],
  ['feeRecipient()', FEE_ADDRESS],
  ['router()', net.router],
  ['weth()', net.wrapped],
];
for (const [sig, want] of checks) {
  if (tail(await read(sig)) !== want) fail(`${sig} does not read back ${want}.`);
  ok(`${sig} = ${want}`);
}
if (BigInt(await read('FEE_BPS()')) !== 58n) fail('FEE_BPS is not 58.');
ok('FEE_BPS = 58 (0.58%)');
if (BigInt(await read('totalOwed()')) !== 0n) fail('totalOwed is not zero on a fresh contract.');
ok('totalOwed = 0');
console.log(`\nVerified. Next, by hand: put ${address.toLowerCase()} in EVM_CURVE_ADDRESSES.${chainKey}, update the gate test, and turn the flag on only for a watched rehearsal.`);
