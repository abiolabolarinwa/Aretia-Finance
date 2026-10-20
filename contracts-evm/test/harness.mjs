// In-process EVM harness for the contracts in contracts-evm/. Runs the COMMITTED artifacts (never a fresh build) inside @ethereumjs/vm,
// with the real Uniswap V2 factory, router and WETH9 builds from npm. See README.md in this folder for how to install and run.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VM } from '@ethereumjs/vm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { Address, Account, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { encodeFunctionData, decodeFunctionResult, encodeAbiParameters, parseAbi, decodeEventLog } from 'viem';
export { decodeEventLog };

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..');
export const art = (name) => JSON.parse(readFileSync(join(REPO, name), 'utf8'));
const U = (n) => require('@uniswap/v2-' + n);

export const E = 10n ** 18n;
export const DEAD = '0x000000000000000000000000000000000000dEaD';
export const FEE = '0x000000000000000000000000000000000000fee1';

export const curveArt = art('AretiaCurve.artifact.json').curve;
export const facArt = art('AretiaTokenFactory.artifact.json').factory;
export const rescueArt = art('AretiaCurveRescue.artifact.json').helper;
export const seederArt = art('AretiaPairSeeder.artifact.json').helper;
export const poolArt = art('AretiaPool.artifact.json').pool;
export const poolMocks = art('test-mocks/PoolMocks.artifact.json');

export const tokAbi = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
]);
export const pairAbi = U('core/build/UniswapV2Pair.json').abi;
export const ufacAbi = U('core/build/UniswapV2Factory.json').abi;
export const wethAbi = U('periphery/build/WETH9.json').abi;
export const routerAbi = U('periphery/build/UniswapV2Router02.json').abi;

export const ctor = (types, vals) => encodeAbiParameters(types.map((t) => ({ type: t })), vals).slice(2);
export const addr = (h) => Address.fromString(h);

/** A fresh chain. Every test makes its own, so tests never share state. */
export async function world() {
  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Shanghai });
  const vm = await VM.create({ common });
  let ts = 1_700_000_000n;
  const W = {
    vm,
    warp(s) {
      ts += BigInt(s);
    },
    now: () => ts,
    async fund(a, wei) {
      await vm.stateManager.putAccount(addr(a), Account.fromAccountData({ balance: wei }));
    },
    async balance(a) {
      return (await vm.stateManager.getAccount(addr(a)))?.balance ?? 0n;
    },
    async code(a) {
      return vm.stateManager.getContractCode(addr(a));
    },
    /** A real call: state changes stay, and the caller's balance pays value (gas price is zero). */
    async run(from, to, data, value = 0n) {
      const r = await vm.evm.runCall({
        caller: addr(from),
        to: to ? addr(to) : undefined,
        data: hexToBytes(data),
        value,
        gasLimit: 30_000_000n,
        origin: addr(from),
        block: { header: { timestamp: ts, number: 100n, baseFeePerGas: 0n, gasLimit: 30_000_000n, coinbase: Address.zero(), prevRandao: new Uint8Array(32), difficulty: 0n, getBlobGasPrice: () => 0n } },
      });
      const e = r.execResult;
      let reason = null;
      if (e.exceptionError) {
        const rv = bytesToHex(e.returnValue);
        if (rv.startsWith('0x08c379a0')) {
          const len = parseInt(rv.slice(10 + 64, 10 + 128), 16);
          reason = Buffer.from(rv.slice(10 + 128, 10 + 128 + len * 2), 'hex').toString();
        } else reason = e.exceptionError.error;
      }
      const logs = (e.logs ?? []).map(([a, topics, data]) => ({ address: bytesToHex(a), topics: topics.map((t) => bytesToHex(t)), data: bytesToHex(data) }));
      return { ok: !e.exceptionError, ret: bytesToHex(e.returnValue), created: r.createdAddress?.toString(), reason, gas: e.executionGasUsed, logs };
    },
    async deploy(from, bytecode, ctorHex = '') {
      const r = await W.run(from, undefined, (bytecode.startsWith('0x') ? bytecode : '0x' + bytecode) + ctorHex);
      if (!r.ok) throw new Error('deploy failed ' + r.reason);
      return r.created;
    },
    async call(from, to, abi, fn, args = [], value = 0n) {
      const data = encodeFunctionData({ abi, functionName: fn, args });
      const r = await W.run(from, to, data, value);
      if (r.ok) {
        try {
          r.out = decodeFunctionResult({ abi, functionName: fn, data: r.ret });
        } catch {
          // no decodable output
        }
      }
      return r;
    },
    /** A call that must succeed; returns its decoded output. */
    async must(from, to, abi, fn, args = [], value = 0n) {
      const r = await W.call(from, to, abi, fn, args, value);
      if (!r.ok) throw new Error(`${fn} reverted: ${r.reason}`);
      return r;
    },
    async view(to, abi, fn, args = []) {
      return (await W.must('0x' + '9'.repeat(40), to, abi, fn, args)).out;
    },
  };
  return W;
}

/** WETH, the real Uniswap V2 factory and router, Aretia's token factory (fee 0) and the curve, as deployed on mainnet but locally. */
export async function exchange(W, deployer = '0x' + '11'.repeat(20)) {
  await W.fund(deployer, 10n ** 30n);
  const weth = await W.deploy(deployer, U('periphery/build/WETH9.json').bytecode);
  const ufac = await W.deploy(deployer, U('core/build/UniswapV2Factory.json').bytecode, ctor(['address'], [deployer]));
  const router = await W.deploy(deployer, U('periphery/build/UniswapV2Router02.json').bytecode, ctor(['address', 'address'], [ufac, weth]));
  return { deployer, weth, ufac, router };
}

export async function curveWorld(W) {
  const x = await exchange(W);
  const factory = await W.deploy(x.deployer, facArt.bytecode, ctor(['address', 'uint256'], [FEE, 0n]));
  const curve = await W.deploy(x.deployer, curveArt.bytecode, ctor(['address', 'address', 'address'], [factory, FEE, x.router]));
  const rescue = await W.deploy(x.deployer, rescueArt.bytecode, ctor(['address'], [curve]));
  return { ...x, factory, curve, rescue, nonce: 0n };
}

/** Makes a factory token held by `creator`. The factory's CREATE nonces start at 1. */
export async function makeToken(W, S, creator, supply, decimals = 18) {
  const r = await W.must(creator, S.factory, facArt.abi, 'create', ['T', 'T', decimals, supply]);
  S.nonce += 1n;
  return { token: r.out.toLowerCase(), nonce: S.nonce };
}

export async function reservesOf(W, pair, token) {
  const [r0, r1] = await W.view(pair, pairAbi, 'getReserves');
  const t0 = (await W.view(pair, pairAbi, 'token0')).toLowerCase();
  return t0 === token.toLowerCase() ? { rT: r0, rC: r1 } : { rT: r1, rC: r0 };
}
