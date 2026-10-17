/* global process */
// Deploys Aretia's token factory and bonding curve to a TEST network, and nothing else.
//
//   npm i --no-save viem
//   node scripts/deploy-curve-testnet.mjs --chain sepolia                 (a dry run: reads the network, estimates, sends nothing)
//   DEPLOYER_KEY_FILE=<file holding a 0x private key> node scripts/deploy-curve-testnet.mjs --chain sepolia --send
//
// Safety, by construction:
//  - Only the test networks listed below. The mainnet chain ids (1, 56, 137) are refused by name, whatever else is passed.
//  - The key is read from a file you name, used to sign, and never printed or stored. Use a throwaway key that holds only test coins.
//  - Without --send nothing is signed or sent.
//  - It checks the chain id the node reports, and that the exchange router is really there and answers WETH() and factory().
// It prints the addresses to put in LAUNCH_EVM_CHAINS (factory) and EVM_CURVE_ADDRESSES (curve), which stays a human step.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const require = createRequire(import.meta.url);
const { createPublicClient, createWalletClient, http, isAddress, parseEther } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');

const FEE_ADDRESS = '0xeb8725e16e504036c2166aa47804d88ecc4d0945';
const MAINNETS = new Set([1, 56, 137, 8453, 10, 42161, 43114]);
const NETWORKS = {
  sepolia: { chainId: 11155111, rpc: 'https://ethereum-sepolia-rpc.publicnode.com', router: '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3', fee: '0.0001', symbol: 'ETH' },
  bscTestnet: { chainId: 97, rpc: 'https://bsc-testnet-rpc.publicnode.com', router: null, fee: '0.0001', symbol: 'tBNB' },
  polygonAmoy: { chainId: 80002, rpc: 'https://polygon-amoy-bor-rpc.publicnode.com', router: null, fee: '0.1', symbol: 'POL' },
};

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1]?.startsWith('--') ? true : (process.argv[i + 1] ?? true);
};
const fail = (msg) => {
  console.error(`Refusing: ${msg}`);
  process.exit(1);
};

const chainKey = arg('chain');
const net = NETWORKS[chainKey];
if (!net) fail(`--chain must be one of ${Object.keys(NETWORKS).join(', ')}.`);
if (MAINNETS.has(net.chainId)) fail('that is a mainnet. This script only deploys to test networks.');
const router = arg('router') && arg('router') !== true ? arg('router') : net.router;
if (!router || !isAddress(router)) fail(`no exchange router is known for ${chainKey}; pass one you have checked with --router 0x...`);
const rpc = arg('rpc') && arg('rpc') !== true ? arg('rpc') : net.rpc;
const send = process.argv.includes('--send');

const factoryArt = JSON.parse(readFileSync(join(root, 'contracts-evm', 'AretiaTokenFactory.artifact.json'), 'utf8'));
const curveArt = JSON.parse(readFileSync(join(root, 'contracts-evm', 'AretiaCurve.artifact.json'), 'utf8'));

const pub = createPublicClient({ transport: http(rpc) });
const reported = await pub.getChainId();
if (reported !== net.chainId) fail(`the node at ${rpc} reports chain ${reported}, not ${net.chainId}.`);
if (MAINNETS.has(reported)) fail('the node reports a mainnet.');

const code = await pub.getCode({ address: router });
if (!code || code === '0x') fail(`there is no contract at the router address ${router} on ${chainKey}.`);
const word = (data) => '0x' + data.slice(-40).toLowerCase();
const weth = word((await pub.call({ to: router, data: '0xad5c4648' })).data);
const exFactory = word((await pub.call({ to: router, data: '0xc45a0155' })).data);
console.log(`network    ${chainKey} (chain ${reported})`);
console.log(`router     ${router}  WETH ${weth}  factory ${exFactory}`);

const pad = (v) => v.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const feeWei = parseEther(net.fee);
const noPrefix = (h) => h.replace(/^0x/, '');
const factoryData = `0x${noPrefix(factoryArt.factory.bytecode)}${pad(FEE_ADDRESS)}${feeWei.toString(16).padStart(64, '0')}`;

let from;
let account;
if (send) {
  const file = process.env.DEPLOYER_KEY_FILE;
  if (!file) fail('--send needs DEPLOYER_KEY_FILE, a file holding a throwaway 0x private key with test coins.');
  const key = readFileSync(file, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail('the key file must hold one 0x-prefixed 64-digit private key and nothing else.');
  account = privateKeyToAccount(key);
  from = account.address;
} else from = '0x00000000000000000000000000000000000c0de1';
console.log(`deployer   ${from}${send ? '' : '  (dry run: a placeholder)'}`);

const estimate = async (data, label) => {
  try {
    // A creation call that returns code proves the constructor runs to the end on this network; the gas figure is the node's own estimate.
    const made = await pub.call({ account: from, data });
    const bytes = ((made.data ?? '0x').length - 2) / 2;
    const gas = await pub.estimateGas({ account: from, data });
    console.log(`${label.padEnd(10)} constructor runs, leaves ${bytes} bytes of code; the node estimates up to about ${gas} gas (public nodes overestimate a deployment)`);
    return gas;
  } catch (e) {
    console.log(`${label.padEnd(10)} could not be estimated here: ${String(e.shortMessage ?? e.message).split('\n')[0]}`);
    return null;
  }
};
await estimate(factoryData, 'factory');
const placeholderFactory = '0x0000000000000000000000000000000000000f4c';
await estimate(`0x${noPrefix(curveArt.curve.bytecode)}${pad(placeholderFactory)}${pad(FEE_ADDRESS)}${pad(router)}`, 'curve');

if (!send) {
  console.log('\nDry run only. Nothing was signed or sent. Add --send (and DEPLOYER_KEY_FILE) to deploy.');
  process.exit(0);
}

const balance = await pub.getBalance({ address: from });
console.log(`balance    ${balance} wei`);
if (balance === 0n) fail('the deployer holds no test coins on this network.');
const wallet = createWalletClient({ account, transport: http(rpc) });
const deploy = async (data, label) => {
  const hash = await wallet.sendTransaction({ data, chain: null });
  console.log(`${label.padEnd(10)} sent ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) fail(`${label} failed (${hash}).`);
  console.log(`${label.padEnd(10)} at ${receipt.contractAddress.toLowerCase()}`);
  return receipt.contractAddress.toLowerCase();
};
const factory = await deploy(factoryData, 'factory');
const curve = await deploy(`0x${noPrefix(curveArt.curve.bytecode)}${pad(factory)}${pad(FEE_ADDRESS)}${pad(router)}`, 'curve');
const readWeth = word((await pub.call({ to: curve, data: '0x' + curveArt.curve.selectors['weth()'] })).data);
if (readWeth !== weth) fail('the deployed curve does not report the exchange’s wrapped coin.');

console.log('\nPut these in the web code, by hand, after checking them:');
console.log(JSON.stringify({ chain: chainKey, chainId: reported, factory, factoryFeeWei: feeWei.toString(), curve, router, feeAddress: FEE_ADDRESS }, null, 2));
