// Compiles contracts-evm/AretiaLaunchFactory.sol (which imports AretiaToken from AretiaTokenFactory.sol) as the other contracts here were
// compiled: solc 0.8.26, optimizer 200 runs, EVM paris.
// Needs solc-js 0.8.26:  npm i --no-save solc@0.8.26   (run from a folder where that resolves, e.g. contracts-evm/test after `npm i`)
// Usage: node ../compile-launch.mjs ..
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const solc = (() => {
  try {
    return createRequire(join(process.cwd(), 'noop.js'))('solc');
  } catch {
    return createRequire(import.meta.url)('solc');
  }
})();
if (solc.version().indexOf('0.8.26') !== 0) throw new Error(`need solc 0.8.26, have ${solc.version()}`);
const dir = process.argv[2] ?? '.';
const read = (f) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n');
const input = {
  language: 'Solidity',
  sources: { 'AretiaLaunchFactory.sol': { content: read('AretiaLaunchFactory.sol') }, 'AretiaTokenFactory.sol': { content: read('AretiaTokenFactory.sol') } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.methodIdentifiers'] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
for (const e of out.errors ?? []) console.error(e.formattedMessage);
if ((out.errors ?? []).some((e) => e.severity === 'error')) process.exit(1);
const c = out.contracts['AretiaLaunchFactory.sol'].AretiaLaunchFactory;
const t = out.contracts['AretiaTokenFactory.sol'].AretiaToken;
const artifact = {
  compiler: 'solc 0.8.26, optimizer 200 runs, evm paris',
  launch: { bytecode: '0x' + c.evm.bytecode.object, abi: c.abi, selectors: c.evm.methodIdentifiers },
  token: { selectors: t.evm.methodIdentifiers },
};
writeFileSync(join(dir, 'AretiaLaunchFactory.artifact.json'), JSON.stringify(artifact, null, 2) + '\n');
writeFileSync(join(dir, 'AretiaLaunchFactory.standard-input.json'), JSON.stringify(input, null, 2) + '\n');
console.log('bytecode bytes', c.evm.deployedBytecode.object.length / 2, c.evm.methodIdentifiers);
