import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { VM } from '@ethereumjs/vm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { Address, Account, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { encodeFunctionData, decodeFunctionResult, encodeAbiParameters, parseAbi } from 'viem';
const require = createRequire(import.meta.url);
export const art = (p) => JSON.parse(readFileSync(p, 'utf8'));
const curveArt = art('../../../../../contracts-evm/AretiaCurve.artifact.json').curve;
const facArt = art('../../../../../contracts-evm/AretiaTokenFactory.artifact.json');
const U = (n) => require('@uniswap/v2-' + n);
export const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Shanghai });
export const vm = await VM.create({ common });
export const addr = (h) => Address.fromString(h);
export async function fund(a, wei) { await vm.stateManager.putAccount(addr(a), Account.fromAccountData({ balance: wei })); }
let ts = 1_700_000_000n;
export function warp(s) { ts += BigInt(s); }
export async function run(from, to, data, value = 0n) {
  const r = await vm.evm.runCall({ caller: addr(from), to: to ? addr(to) : undefined, data: hexToBytes(data), value, gasLimit: 30_000_000n, origin: addr(from), block: { header: { timestamp: ts, number: 100n, baseFeePerGas: 0n, gasLimit: 30_000_000n, coinbase: Address.zero(), prevRandao: new Uint8Array(32), difficulty: 0n, getBlobGasPrice: () => 0n } } });
  const e = r.execResult;
  let reason = null;
  if (e.exceptionError) { const rv = bytesToHex(e.returnValue); if (rv.startsWith('0x08c379a0')) { const len = parseInt(rv.slice(10+64, 10+128),16); reason = Buffer.from(rv.slice(10+128, 10+128+len*2),'hex').toString(); } else reason = e.exceptionError.error; }
  return { ok: !e.exceptionError, ret: bytesToHex(e.returnValue), created: r.createdAddress?.toString(), reason, gas: e.executionGasUsed };
}
export async function deploy(from, bytecode, ctorHex = '') { const r = await run(from, undefined, (bytecode.startsWith('0x') ? bytecode : '0x' + bytecode) + ctorHex); if (!r.ok) throw new Error('deploy failed ' + r.reason); return r.created; }
export async function call(from, to, abi, fn, args = [], value = 0n) {
  const data = encodeFunctionData({ abi, functionName: fn, args });
  const r = await run(from, to, data, value);
  if (r.ok) { try { r.out = decodeFunctionResult({ abi, functionName: fn, data: r.ret }); } catch {} }
  return r;
}
export const ctor = (types, vals) => encodeAbiParameters(types.map((t) => ({ type: t })), vals).slice(2);
export const curveAbi = curveArt.abi, facAbi = facArt.factory.abi, tokAbi = parseAbi(["function approve(address,uint256) returns (bool)","function transfer(address,uint256) returns (bool)","function balanceOf(address) view returns (uint256)"]);
export const pairAbi = U('core/build/UniswapV2Pair.json').abi, ufacAbi = U('core/build/UniswapV2Factory.json').abi, wethAbi = U('periphery/build/WETH9.json').abi, routerAbi = U('periphery/build/UniswapV2Router02.json').abi;
export async function setup(i = 1) {
  const DEP = '0x' + (0x10 + i).toString(16).repeat(20); await fund(DEP, 10n ** 30n);
  const weth = await deploy(DEP, U('periphery/build/WETH9.json').bytecode);
  const ufac = await deploy(DEP, U('core/build/UniswapV2Factory.json').bytecode, ctor(['address'], [DEP]));
  const router = await deploy(DEP, U('periphery/build/UniswapV2Router02.json').bytecode, ctor(['address', 'address'], [ufac, weth]));
  const FEE = '0x000000000000000000000000000000000000fee1';
  const factory = await deploy(DEP, facArt.factory.bytecode, ctor(['address', 'uint256'], [FEE, 0n]));
  const curve = await deploy(DEP, curveArt.bytecode, ctor(['address', 'address', 'address'], [factory, FEE, router]));
  return { DEP, weth, ufac, router, factory, curve, FEE };
}
