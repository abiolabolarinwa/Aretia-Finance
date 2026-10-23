import { readFileSync, writeFileSync } from 'node:fs';
import solc from 'solc';
import { Wallet } from 'ethers';
const R = process.argv[2];
const out = {};
for (const [file, ver] of [[`${R}/orders/AretiaOrders.sol`, '0.8.28'], [`${R}/orders/MockOrderVenue.sol`, '0.8.28'], [`${R}/AretiaTokenFactory.sol`, '0.8.26']]) {
  if (solc.version().indexOf(ver) !== 0 && ver !== '0.8.26') throw new Error('solc ' + solc.version());
  const name = file.split('/').pop();
  const input = { language: 'Solidity', sources: { [name]: { content: readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace('pragma solidity 0.8.26;', 'pragma solidity 0.8.28;') } }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const res = JSON.parse(solc.compile(JSON.stringify(input)));
  for (const e of res.errors ?? []) if (e.severity === 'error') { console.log(e.formattedMessage); process.exit(1); }
  for (const [n, c] of Object.entries(res.contracts[name])) out[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}
writeFileSync('artifacts.json', JSON.stringify(out));
console.log(Object.keys(out).join(', '));
