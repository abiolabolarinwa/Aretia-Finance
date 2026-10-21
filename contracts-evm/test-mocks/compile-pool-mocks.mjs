import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
// solc is looked up from the current folder first (e.g. contracts-evm/test with its node_modules), then next to this file.
const solc = (() => {
  try {
    return createRequire(join(process.cwd(), 'noop.js'))('solc');
  } catch {
    return createRequire(import.meta.url)('solc');
  }
})();
const dir = process.argv[2];
const file = 'PoolMocks.sol';
const source = readFileSync(join(dir, 'test-mocks', file), 'utf8').replace(/\r\n/g, '\n');
const input = { language: 'Solidity', sources: { [file]: { content: source } }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.methodIdentifiers'] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
for (const e of out.errors ?? []) console.error(e.formattedMessage);
if ((out.errors ?? []).some((e) => e.severity === 'error')) process.exit(1);
const res = { compiler: 'solc 0.8.26, optimizer 200 runs, evm paris. TEST ONLY.' };
for (const [name, c] of Object.entries(out.contracts[file])) res[name] = { bytecode: c.evm.bytecode.object, abi: c.abi, selectors: c.evm.methodIdentifiers };
writeFileSync(join(dir, 'test-mocks', 'PoolMocks.artifact.json'), JSON.stringify(res, null, 2) + '\n');
console.log(Object.keys(res).join(','));
