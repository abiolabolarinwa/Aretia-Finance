// PoC harness: runs the committed AretiaPool artifact (byte-identical to a fresh solc 0.8.26 build) in @ethereumjs/vm 8.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { VM } = require('@ethereumjs/vm');
const { Common, Chain, Hardfork } = require('@ethereumjs/common');
const { Address, Account, hexToBytes, bytesToHex } = require('@ethereumjs/util');
const { Block } = require('@ethereumjs/block');
const { keccak256 } = require('ethereum-cryptography/keccak.js');

const REPO = '../../../../../contracts-evm/';
export const poolArt = require(REPO + 'AretiaPool.artifact.json').pool;
export const facArt = require(REPO + 'AretiaTokenFactory.artifact.json');
export const mocks = require(REPO + 'test-mocks/PoolMocks.artifact.json');

const enc = new TextEncoder();
export const sel = (sig) => bytesToHex(keccak256(enc.encode(sig))).slice(2, 10);
export const w = (v) => (typeof v === 'string' ? v.replace(/^0x/, '').toLowerCase().padStart(64, '0') : typeof v === 'boolean' ? (v ? '1' : '0').padStart(64, '0') : BigInt(v).toString(16).padStart(64, '0'));
export const call = (sig, ...a) => '0x' + sel(sig) + a.map(w).join('');
export const ETH = 10n ** 18n;

export async function world() {
  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Shanghai });
  const vm = await VM.create({ common });
  let ts = 1_700_000_000n;
  const block = () => Block.fromBlockData({ header: { timestamp: ts, number: 1n, gasLimit: 60_000_000n } }, { common });
  const fund = async (a, wei = 10n ** 30n) => vm.stateManager.putAccount(Address.fromString(a), Account.fromAccountData({ balance: wei }));
  const exec = async (from, to, data, value = 0n) => {
    const r = await vm.evm.runCall({ caller: Address.fromString(from), ...(to ? { to: Address.fromString(to) } : {}), data: hexToBytes(data), value, gasLimit: 30_000_000n, block: block() });
    const err = r.execResult.exceptionError;
    let reason = '';
    if (err) {
      const ret = bytesToHex(r.execResult.returnValue);
      if (ret.startsWith('0x08c379a0')) { const len = parseInt(ret.slice(74, 138), 16); reason = Buffer.from(ret.slice(138, 138 + len * 2), 'hex').toString(); }
      else reason = err.error;
    }
    return { ok: !err, reason, ret: bytesToHex(r.execResult.returnValue), created: r.createdAddress?.toString(), gas: r.execResult.executionGasUsed };
  };
  const deploy = async (from, bytecode, args = '') => { const r = await exec(from, null, '0x' + bytecode.replace(/^0x/, '') + args); if (!r.ok) throw new Error('deploy ' + r.reason); return r.created; };
  const view = async (to, data) => (await exec('0x' + '9'.repeat(40), to, data)).ret;
  const bal = async (a) => (await vm.stateManager.getAccount(Address.fromString(a)))?.balance ?? 0n;
  const words = (hex) => Array.from({ length: (hex.length - 2) / 64 }, (_, i) => BigInt('0x' + hex.slice(2 + i * 64, 66 + i * 64)));
  return { vm, exec, deploy, view, bal, fund, words, setTs: (t) => (ts = t) };
}

/** Deploys factory + pool, makes a token held by `creator`. Returns addresses. */
export async function setup(W, { feeRecipient = '0x000000000000000000000000000000000000fee1', creationFee = 42n * 10n ** 14n, supply = 10n ** 27n, creator, deployer = '0x' + 'd'.repeat(40) } = {}) {

  await W.fund(deployer);
  const factory = await W.deploy(deployer, facArt.factory.bytecode, w(feeRecipient) + w(1n));
  // create(string,string,uint8,uint256)
  const strWord = (s) => w(BigInt(s.length)) + Buffer.from(s).toString('hex').padEnd(64, '0');
  const data = '0x' + sel('create(string,string,uint8,uint256)') + w(128n) + w(192n) + w(18n) + w(supply) + strWord('Tok') + strWord('TOK');
  const r = await W.exec(creator, factory, data, 1n);
  if (!r.ok) throw new Error('create token ' + r.reason);
  const token = '0x' + r.ret.slice(26);
  const pool = await W.deploy(deployer, poolArt.bytecode, w(factory) + w(feeRecipient) + w(creationFee));
  return { factory, token, pool, creationFee, nonce: 1n };
}
export const CREATE_SIG = 'createPool((address,uint256,uint256,uint256,uint256,uint256,bool,address,uint256,uint256))';
