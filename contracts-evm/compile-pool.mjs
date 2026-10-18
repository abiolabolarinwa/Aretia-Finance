// Compiles contracts-evm/AretiaPool.sol exactly as the token factory was compiled: solc 0.8.26, optimizer 200 runs, EVM paris.
// Needs solc-js 0.8.26:  npm i --no-save solc@0.8.26   (run this file from a folder where that resolves)
// Usage: node compile-curve.mjs <path to contracts-evm>
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const solc = require('solc');
if (solc.version().indexOf('0.8.26') !== 0) throw new Error(`need solc 0.8.26, have ${solc.version()}`);
const dir = process.argv[2] ?? '.';
const source = readFileSync(join(dir, 'AretiaPool.sol'), 'utf8').replace(/\r\n/g, '\n');
const input = {
  language: 'Solidity',
  sources: { 'AretiaPool.sol': { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.methodIdentifiers'] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
for (const e of out.errors ?? []) console.error(e.formattedMessage);
if ((out.errors ?? []).some((e) => e.severity === 'error')) process.exit(1);
const c = out.contracts['AretiaPool.sol'].AretiaPool;
const artifact = {
  compiler: 'solc 0.8.26, optimizer 200 runs, evm paris',
  pool: { bytecode: c.evm.bytecode.object, abi: c.abi, selectors: c.evm.methodIdentifiers },
};
writeFileSync(join(dir, 'AretiaPool.artifact.json'), JSON.stringify(artifact, null, 2) + '\n');
writeFileSync(join(dir, 'AretiaPool.standard-input.json'), JSON.stringify(input, null, 2) + '\n');
console.log('bytecode bytes', c.evm.deployedBytecode.object.length / 2, 'selectors', Object.keys(c.evm.methodIdentifiers).length);
