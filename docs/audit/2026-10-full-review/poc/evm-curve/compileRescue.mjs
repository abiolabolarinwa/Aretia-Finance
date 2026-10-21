import { readFileSync, writeFileSync } from 'node:fs'; import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const solc = require('solc');
const input = { language:'Solidity', sources:{'R.sol':{content:readFileSync('Rescue.sol','utf8')}}, settings:{optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:'paris',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
const o = JSON.parse(solc.compile(JSON.stringify(input))); for (const e of o.errors||[]) console.log(e.formattedMessage);
writeFileSync('Rescue.json', JSON.stringify(o.contracts['R.sol'].Rescue));
