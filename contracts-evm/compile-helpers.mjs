// Compiles the two helpers that work AROUND the deployed, immutable AretiaCurve (contracts-evm/AretiaCurveRescue.sol and
// contracts-evm/AretiaPairSeeder.sol) exactly as the curve was compiled: solc 0.8.26, optimizer 200 runs, EVM paris.
// Needs solc-js 0.8.26:  npm i --no-save solc@0.8.26   (run this file from a folder where that resolves, e.g. contracts-evm/test after
// `npm i` there; see contracts-evm/test/README.md)
// Usage: node compile-helpers.mjs <path to contracts-evm>
// Writes, per contract: <Name>.artifact.json ({ compiler, helper: { bytecode, deployedBytecode, abi, selectors } }) and
// <Name>.standard-input.json (the exact compiler input, for explorer verification), and prints the runtime bytecode's sha-256.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// solc is looked up from the current folder first (e.g. contracts-evm/test with its node_modules), then next to this file.
const fromCwd = createRequire(join(process.cwd(), 'noop.js'));
const solc = (() => {
  try {
    return fromCwd('solc');
  } catch {
    return createRequire(import.meta.url)('solc');
  }
})();
if (solc.version().indexOf('0.8.26') !== 0) throw new Error(`need solc 0.8.26, have ${solc.version()}`);
const dir = process.argv[2] ?? '.';
for (const name of ['AretiaCurveRescue', 'AretiaPairSeeder']) {
  const file = `${name}.sol`;
  const source = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
  const input = {
    language: 'Solidity',
    sources: { [file]: { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.methodIdentifiers'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  for (const e of out.errors ?? []) console.error(e.formattedMessage);
  if ((out.errors ?? []).some((e) => e.severity === 'error')) process.exit(1);
  const c = out.contracts[file][name];
  const artifact = {
    compiler: 'solc 0.8.26, optimizer 200 runs, evm paris',
    helper: { bytecode: c.evm.bytecode.object, deployedBytecode: c.evm.deployedBytecode.object, abi: c.abi, selectors: c.evm.methodIdentifiers },
  };
  writeFileSync(join(dir, `${name}.artifact.json`), JSON.stringify(artifact, null, 2) + '\n');
  writeFileSync(join(dir, `${name}.standard-input.json`), JSON.stringify(input, null, 2) + '\n');
  const sha = createHash('sha256').update(Buffer.from(c.evm.deployedBytecode.object, 'hex')).digest('hex');
  console.log(name, 'runtime bytes', c.evm.deployedBytecode.object.length / 2, 'sha256', sha, 'selectors', JSON.stringify(c.evm.methodIdentifiers));
}
