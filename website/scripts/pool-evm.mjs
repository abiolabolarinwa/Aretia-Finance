/* global process */
// Deployment helper and verifier for Aretia Pool on Ethereum-style chains (contracts-evm/AretiaPool.sol).
//
//   npm i --no-save viem
//   node scripts/pool-evm.mjs prepare --chain ethereum                     MAINNET: read-only checks, then writes the unsigned creation data. Never signs.
//   node scripts/pool-evm.mjs verify  --chain ethereum --address 0x...     MAINNET or test: checks a deployed pool is exactly the committed build
//   DEPLOYER_KEY_FILE=<file holding a throwaway 0x key> node scripts/pool-evm.mjs deploy --chain sepolia   TEST NETWORKS ONLY: deploys the token factory and the pool
//
// Chains: ethereum, bnb, polygon (prepare, verify) and sepolia, bscTestnet, polygonAmoy (all three modes).
// There is no mainnet `deploy`. On a mainnet you deploy the data `prepare` prints yourself, from the owner's own wallet, then run `verify`.
// Only after `verify` passes is the address written into EVM_POOL_ADDRESSES (and the flag turned on), by hand.
//
// Safety, by construction: `deploy` refuses every mainnet chain id by name, reads its key from a file you name, never prints or stores it,
// and signs nothing without --send. `prepare` and `verify` only read.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const require = createRequire(import.meta.url);
const { createPublicClient, http, isAddress, keccak256 } = require('viem');

const FEE_ADDRESS = '0xeb8725e16e504036c2166aa47804d88ecc4d0945';
const MAINNET_IDS = new Set([1, 56, 137, 8453, 10, 42161, 43114]);
// The token factory (the chain's Aretia launcher; null on a test network until `deploy` makes one) and the creation fee in wei, which must
// equal the factory's own fee: walletLaunchEvmCore.ts. Fees: 0.0042 ETH, 0.014 BNB, 105 POL; tests 0.0001, 0.0001, 0.1.
const CHAINS = {
  ethereum: { chainId: 1, test: false, rpc: 'https://ethereum-rpc.publicnode.com', factory: '0x951a22270faa7d1c25efad2356c414cbddaba324', fee: 4_200_000_000_000_000n },
  bnb: { chainId: 56, test: false, rpc: 'https://bsc-rpc.publicnode.com', factory: '0xc3eb98c45795cffb10b61178332cc6fcbbc0385c', fee: 14_000_000_000_000_000n },
  polygon: { chainId: 137, test: false, rpc: 'https://polygon-bor-rpc.publicnode.com', factory: '0xca1aa427ba5906d00377a835dd9b36b049034f0c', fee: 105_000_000_000_000_000_000n },
  sepolia: { chainId: 11155111, test: true, rpc: 'https://ethereum-sepolia-rpc.publicnode.com', factory: null, fee: 100_000_000_000_000n },
  bscTestnet: { chainId: 97, test: true, rpc: 'https://bsc-testnet-rpc.publicnode.com', factory: null, fee: 100_000_000_000_000n },
  polygonAmoy: { chainId: 80002, test: true, rpc: 'https://polygon-amoy-bor-rpc.publicnode.com', factory: null, fee: 100_000_000_000_000_000n },
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
if (!['prepare', 'verify', 'deploy'].includes(mode) || !net) fail(`usage: pool-evm.mjs prepare|verify|deploy --chain ${Object.keys(CHAINS).join('|')} [--address 0x...] [--factory 0x...] [--rpc url] [--send]`);
if (mode === 'deploy' && (!net.test || MAINNET_IDS.has(net.chainId))) fail('deploy only works on a test network. For a mainnet use prepare, deploy the printed data yourself, then verify.');
const rpc = arg('rpc') ?? net.rpc;
const factory = (arg('factory') ?? net.factory)?.toLowerCase() ?? null;

const art = JSON.parse(readFileSync(join(root, 'contracts-evm', 'AretiaPool.artifact.json'), 'utf8'));
const factoryArt = JSON.parse(readFileSync(join(root, 'contracts-evm', 'AretiaTokenFactory.artifact.json'), 'utf8'));
const pub = createPublicClient({ transport: http(rpc) });
const tail = (d) => '0x' + d.slice(-40).toLowerCase();
const call = async (to, data) => (await pub.call({ to, data })).data ?? '0x';
const pad = (v) => (typeof v === 'bigint' ? v.toString(16) : v.replace(/^0x/, '').toLowerCase()).padStart(64, '0');
const sel = (sig) => '0x' + art.pool.selectors[sig];
const noPrefix = (h) => h.replace(/^0x/, '');

console.log(`chain ${chainKey}, node ${rpc}`);
const reported = await pub.getChainId();
if (reported !== net.chainId) fail(`the node reports chain ${reported}, expected ${net.chainId}.`);
if (net.test && MAINNET_IDS.has(reported)) fail('the node reports a mainnet.');
ok(`node is chain ${reported}`);

if (!isAddress(FEE_ADDRESS)) fail('fee address is not an address.');
// The fee address must be an ordinary account: a contract that refuses coin there would make every trade revert.
const feeCode = await pub.getCode({ address: FEE_ADDRESS });
if (feeCode && feeCode !== '0x') fail(`the fee address ${FEE_ADDRESS} has code on ${chainKey}, so it might refuse coin and block every trade.`);
ok('fee address is an ordinary account (no code), so it can always receive coin');

const send = process.argv.includes('--send');
let account;
let deployFrom = '0x00000000000000000000000000000000000c0de1';
if (mode === 'deploy' && send) {
  const file = process.env.DEPLOYER_KEY_FILE;
  if (!file) fail('--send needs DEPLOYER_KEY_FILE, a file holding a throwaway 0x private key with test coins.');
  const key = readFileSync(file, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail('the key file must hold one 0x-prefixed 64-digit private key and nothing else.');
  const { privateKeyToAccount } = require('viem/accounts');
  account = privateKeyToAccount(key);
  deployFrom = account.address;
}

let poolFactory = factory;
const deployTx = async (data, label) => {
  const { createWalletClient } = require('viem');
  const wallet = createWalletClient({ account, transport: http(rpc) });
  const hash = await wallet.sendTransaction({ data, chain: null });
  console.log(`  ${label} sent ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) fail(`${label} failed (${hash}).`);
  console.log(`  ${label} at ${receipt.contractAddress.toLowerCase()}`);
  return receipt.contractAddress.toLowerCase();
};

if (mode === 'deploy') {
  console.log(`deployer ${deployFrom}${send ? '' : '  (dry run: a placeholder)'}`);
  const factoryData = `0x${noPrefix(factoryArt.factory.bytecode)}${pad(FEE_ADDRESS)}${pad(net.fee)}`;
  if (!poolFactory) {
    if (!send) {
      console.log('  no token factory is known on this network; a real run deploys one first (same bytecode and constructor as mainnet, test fee).');
      poolFactory = '0x0000000000000000000000000000000000000f4c';
    } else {
      const balance = await pub.getBalance({ address: deployFrom });
      if (balance === 0n) fail('the deployer holds no test coins on this network.');
      poolFactory = await deployTx(factoryData, 'token factory');
    }
  }
  const poolData = `0x${noPrefix(art.pool.bytecode)}${pad(poolFactory)}${pad(FEE_ADDRESS)}${pad(net.fee)}`;
  try {
    const made = await pub.call({ account: deployFrom, data: poolData });
    const gas = await pub.estimateGas({ account: deployFrom, data: poolData });
    console.log(`  pool constructor runs, leaves ${((made.data ?? '0x').length - 2) / 2} bytes of code; the node estimates up to about ${gas} gas`);
  } catch (e) {
    console.log(`  pool could not be estimated here: ${String(e.shortMessage ?? e.message).split('\n')[0]}`);
  }
  if (!send) {
    console.log('\nDry run only. Nothing was signed or sent. Add --send (and DEPLOYER_KEY_FILE) to deploy.');
    process.exit(0);
  }
  const balance = await pub.getBalance({ address: deployFrom });
  console.log(`  balance ${balance} wei`);
  if (balance === 0n) fail('the deployer holds no test coins on this network.');
  const pool = await deployTx(poolData, 'pool');
  console.log('\nPut these in the web code, by hand, after running verify:');
  console.log(JSON.stringify({ chain: chainKey, chainId: reported, factory: poolFactory, creationFeeWei: net.fee.toString(), pool, feeAddress: FEE_ADDRESS }, null, 2));
  console.log(`\nNext: node scripts/pool-evm.mjs verify --chain ${chainKey} --address ${pool} --factory ${poolFactory}`);
  process.exit(0);
}

// prepare and verify
if (!poolFactory || !isAddress(poolFactory)) fail('no token factory is known for this chain; pass --factory 0x... (a test network has none until deploy makes one).');
const factoryCode = await pub.getCode({ address: poolFactory });
if (!factoryCode || factoryCode === '0x') fail(`no contract at the Aretia token factory ${poolFactory} on ${chainKey}.`);
ok(`Aretia token factory ${poolFactory} has code`);
if (tail(await call(poolFactory, '0x' + factoryArt.factory.selectors['feeRecipient()'])) !== FEE_ADDRESS) fail('the token factory pays its fee to a different address from the Aretia fee address.');
if (BigInt(await call(poolFactory, '0x' + factoryArt.factory.selectors['fee()'])) !== net.fee) fail(`the token factory's fee is not ${net.fee} wei, so the pool's creation fee would not equal the token-creation fee.`);
ok(`token factory fee = ${net.fee} wei and pays ${FEE_ADDRESS}`);

const creation = `0x${noPrefix(art.pool.bytecode)}${pad(poolFactory)}${pad(FEE_ADDRESS)}${pad(net.fee)}`;
// The runtime code this creation data produces, by running the constructor in a read-only call. A deployed pool must equal it exactly
// (factory, fee address and creation fee are immutables, so they are part of the code), so `verify` needs nothing but this.
const expectedRuntime = (await pub.call({ data: creation })).data;
if (!expectedRuntime || expectedRuntime === '0x') fail('the constructor does not run to the end on this network.');
const codeHash = keccak256(expectedRuntime);

if (mode === 'prepare') {
  const out = join(process.cwd(), `pool-${chainKey}-creation.json`);
  writeFileSync(out, JSON.stringify({ chain: chainKey, chainId: net.chainId, to: null, value: '0', data: creation, constructor: { factory: poolFactory, feeRecipient: FEE_ADDRESS, creationFee: net.fee.toString() }, expectedRuntimeKeccak: codeHash }, null, 2));
  ok(`constructor runs; the runtime is ${(expectedRuntime.length - 2) / 2} bytes, keccak ${codeHash}`);
  console.log(`\nWrote ${out}`);
  console.log('Deploy it as a contract-creation transaction (no "to", value 0, this data) from the owner wallet. Nothing was signed or sent.');
  console.log(`Then: node scripts/pool-evm.mjs verify --chain ${chainKey} --address <the new contract>`);
  process.exit(0);
}

const address = arg('address');
if (!address || !isAddress(address)) fail('verify needs --address 0x... of the deployed pool.');
const live = await pub.getCode({ address });
if (!live || live === '0x') fail(`no contract at ${address}.`);
if (live.toLowerCase() !== expectedRuntime.toLowerCase()) fail(`the code at ${address} is NOT the committed build for ${chainKey} (keccak ${keccak256(live)}, expected ${codeHash}). Do not use it.`);
ok(`code at ${address} is byte-for-byte the committed build (keccak ${codeHash})`);
const read = async (sig) => call(address, sel(sig));
if (tail(await read('factory()')) !== poolFactory) fail('factory() does not read back the token factory.');
ok(`factory() = ${poolFactory}`);
if (tail(await read('feeRecipient()')) !== FEE_ADDRESS) fail('feeRecipient() does not read back the Aretia fee address.');
ok(`feeRecipient() = ${FEE_ADDRESS}`);
if (BigInt(await read('creationFee()')) !== net.fee) fail(`creationFee() is not ${net.fee} wei.`);
ok(`creationFee() = ${net.fee} wei (equal to the token factory's fee)`);
for (const [sig, want] of [['PROTOCOL_SHARE_BPS()', 2000n], ['FEE_LOW_BPS()', 25n], ['FEE_HIGH_BPS()', 100n], ['MIN_L()', 10n ** 12n]]) {
  if (BigInt(await read(sig)) !== want) fail(`${sig} is not ${want}.`);
  ok(`${sig} = ${want}`);
}
const owed = BigInt(await read('totalOwed()'));
const held = await pub.getBalance({ address });
if (held < owed) fail(`the contract holds ${held} wei but owes ${owed}: it is insolvent.`);
ok(`solvent: holds ${held} wei, owes ${owed}`);
// The post-review build (October 2026) owes the protocol share instead of paying it inside trades; it must have the pull-payment reads.
if (!art.pool.selectors['protocolOwed()'] || !art.pool.selectors['withdrawProtocolFees()']) fail('the committed artifact is not the post-review build (no protocolOwed / withdrawProtocolFees).');
ok(`protocolOwed() = ${BigInt(await read('protocolOwed()'))} wei (anyone may pay it to the fee address with withdrawProtocolFees())`);
console.log(`\nVerified. Next, by hand: put ${address.toLowerCase()} in EVM_POOL_ADDRESSES.${chainKey} and its deployment block in EVM_POOL_DEPLOY_BLOCKS.${chainKey}, update the gate test, and turn the flag on only for a watched rehearsal.`);
