/**
 * Runs the real compiled curve (contracts-evm/AretiaCurve.artifact.json) and the real token factory inside an in-process EVM, with a
 * stand-in for the exchange (contracts-evm/test-mocks). It checks the contract against a BigInt model of the curve maths that is itself
 * checked against the Rust crate's vectors, and against the attacks listed in docs/BONDING_CURVE_EVM.md. It is NOT a deployment test.
 *
 * It needs the EVM library, which is deliberately not a dependency of the website. Install it to run this file:
 *   npm i --no-save @ethereumjs/vm @ethereumjs/common @ethereumjs/util @ethereumjs/block
 * Without it the whole file is skipped.
 */
import { describe, expect, it } from 'vitest';
import curveArtifact from '../../../contracts-evm/AretiaCurve.artifact.json';
import factoryArtifact from '../../../contracts-evm/AretiaTokenFactory.artifact.json';
import mockArtifact from '../../../contracts-evm/test-mocks/MockExchange.artifact.json';
import { quoteBuy, quoteSell, deriveCurve, type CurveMath } from './walletCurveCore';
import { encodeCreate } from './walletLaunchEvmTx';
import { evmCurveChain, evmDerive, type EvmCurveChain, type EvmCurveConfig } from './walletCurveEvmCore';
import { EvmCurveFlow } from './walletCurveEvmFlow';

/* eslint-disable @typescript-eslint/no-explicit-any */
let lib: { vm: any; common: any; util: any; block: any } | null = null;
try {
  const mod = (name: string): Promise<any> => import(/* @vite-ignore */ name);
  lib = { vm: await mod('@ethereumjs/vm'), common: await mod('@ethereumjs/common'), util: await mod('@ethereumjs/util'), block: await mod('@ethereumjs/block') };
} catch {
  lib = null;
}

const ETH = 10n ** 18n;
const FEE_BPS = 58n;
const BPS = 10_000n;
const FEE_RECIPIENT = '0x000000000000000000000000000000000000fee1';
const CREATOR = '0x00000000000000000000000000000000000c0de1';
const DEAD = '0x000000000000000000000000000000000000dead';

// ---------------------------------------------------------------- the reference model (curve-math in BigInt, no 64-bit cap)

const ceilDiv = (a: bigint, b: bigint) => a / b + (a % b === 0n ? 0n : 1n);
interface Model {
  vSol: bigint;
  vTok: bigint;
  realSol: bigint;
  realTok: bigint;
}
function mDerive(total: bigint, target: bigint) {
  const vSol0 = (target * 6n) / 17n;
  const lp = (total * vSol0) / (2n * vSol0 + target);
  const c = total - lp;
  return { vSol0, lp, c, vTok0: ceilDiv((vSol0 + target) * c, target) };
}
function mBuy(m: Model, offered: bigint) {
  let fee = ceilDiv(offered * FEE_BPS, BPS);
  if (fee > offered) fee = offered;
  let net = offered - fee;
  if (net === 0n || m.realTok === 0n) return null;
  const k = m.vSol * m.vTok;
  let out = m.vTok - ceilDiv(k, m.vSol + net);
  let gross = offered;
  if (out >= m.realTok) {
    net = ceilDiv(k, m.vTok - m.realTok) - m.vSol;
    gross = ceilDiv(net * BPS, BPS - FEE_BPS);
    fee = gross - net;
    out = m.realTok;
  }
  if (out === 0n || gross > offered) return null;
  return { gross, fee, net, out, next: { vSol: m.vSol + net, vTok: m.vTok - out, realSol: m.realSol + net, realTok: m.realTok - out } as Model };
}
function mSell(m: Model, curveTokens: bigint, tokens: bigint) {
  if (tokens === 0n || m.realTok + tokens > curveTokens) return null;
  const newVTok = m.vTok + tokens;
  const newVSol = ceilDiv(m.vSol * m.vTok, newVTok);
  const gross = m.vSol - newVSol;
  if (gross > m.realSol) return null;
  let fee = ceilDiv(gross * FEE_BPS, BPS);
  if (fee > gross) fee = gross;
  return { gross, fee, net: gross - fee, next: { vSol: newVSol, vTok: newVTok, realSol: m.realSol - gross, realTok: m.realTok + tokens } as Model };
}

describe('the BigInt reference model agrees with the web core (which agrees with the Rust crate)', () => {
  it('on a spread of small curves and trades', () => {
    for (const [total, target] of [[1_000_000_000_000_000n, 85_000_000_000n], [777_000_000_000n, 3_000_000_000n], [123_456_789_012_345n, 100_000_000n]] as const) {
      const d = deriveCurve(total, target)!;
      const m = mDerive(total, target);
      expect({ vSol0: d.vSol0, vTok0: d.vTok0, curveTokens: d.curveTokens, lpTokens: d.lpTokens }).toEqual({ vSol0: m.vSol0, vTok0: m.vTok0, curveTokens: m.c, lpTokens: m.lp });
      let a: CurveMath = { vSol: d.vSol0, vTok: d.vTok0, realSol: 0n, realTok: d.curveTokens };
      let b: Model = { ...a };
      for (const offer of [target / 9n, target / 4n, target / 7n, target * 3n]) {
        const qa = quoteBuy(a, offer, 58);
        const qb = mBuy(b, offer);
        expect(qa === null).toBe(qb === null);
        if (qa && qb) {
          expect([qa.gross, qa.fee, qa.net, qa.tokensOut]).toEqual([qb.gross, qb.fee, qb.net, qb.out]);
          a = qa.next;
          b = qb.next;
        }
      }
      const sa = quoteSell(a, d.curveTokens, (d.curveTokens - a.realTok) / 3n, 58);
      const sb = mSell(b, m.c, (m.c - b.realTok) / 3n);
      expect(sa === null).toBe(sb === null);
      if (sa && sb) expect([sa.gross, sa.fee, sa.net]).toEqual([sb.gross, sb.fee, sb.net]);
    }
  });
});

// ---------------------------------------------------------------- the EVM world

describe.skipIf(lib === null)('the compiled curve, in an in-process EVM', () => {
  const sel = (sig: string): string => (curveArtifact.curve.selectors as Record<string, string>)[sig]!;
  const word = (v: bigint | string): string => (typeof v === 'string' ? v.replace(/^0x/, '').toLowerCase().padStart(64, '0') : v.toString(16).padStart(64, '0'));
  const call = (sig: string, ...args: (bigint | string)[]): string => '0x' + sel(sig) + args.map(word).join('');

  async function world(opts: { feeRecipient?: string } = {}) {
    const { vm: vmLib, common: commonLib, util, block: blockLib } = lib!;
    const common = new commonLib.Common({ chain: commonLib.Mainnet, hardfork: commonLib.Hardfork.Shanghai });
    const vm = await vmLib.createVM({ common });
    const addr = (a: string) => util.createAddressFromString(a);
    const toBytes = (h: string) => util.hexToBytes(h.startsWith('0x') ? h : '0x' + h);
    const toHex = (b: Uint8Array) => util.bytesToHex(b);
    let now = 1_700_000_000;
    const fund = async (a: string, wei = 10n ** 30n) => vm.stateManager.putAccount(addr(a), util.createAccount({ balance: wei }));
    await fund(CREATOR);

    const exec = async (from: string, to: string | null, data: string, value = 0n, commit = true) => {
      const block = blockLib.createBlock({ header: { timestamp: BigInt(now), number: 1n, gasLimit: 60_000_000n } }, { common });
      if (!commit) await vm.stateManager.checkpoint();
      const r = await vm.evm.runCall({ caller: addr(from), ...(to ? { to: addr(to) } : {}), data: toBytes(data), value, gasLimit: 50_000_000n, skipBalance: false, block });
      if (!commit) await vm.stateManager.revert();
      return r;
    };
    const reason = (ret: Uint8Array): string => {
      const h = toHex(ret);
      if (!h.startsWith('0x08c379a0')) return h;
      const len = Number(BigInt('0x' + h.slice(2 + 8 + 64, 2 + 8 + 128)));
      return Buffer.from(h.slice(2 + 8 + 128, 2 + 8 + 128 + len * 2), 'hex').toString();
    };
    /** Sends a transaction; throws with the contract's revert reason if it fails. */
    const send = async (from: string, to: string, data: string, value = 0n) => {
      const r = await exec(from, to, data, value);
      if (r.execResult.exceptionError) throw new Error(r.execResult.exceptionError.error === 'revert' ? reason(r.execResult.returnValue) : String(r.execResult.exceptionError.error));
      return r;
    };
    /** The revert reason of a transaction that must fail, and nothing changes. */
    const fails = async (from: string, to: string, data: string, value = 0n): Promise<string> => {
      const r = await exec(from, to, data, value);
      expect(r.execResult.exceptionError, 'expected a revert').toBeDefined();
      return reason(r.execResult.returnValue);
    };
    const view = async (to: string, data: string) => toHex((await exec(CREATOR, to, data, 0n, false)).execResult.returnValue);
    const balance = async (a: string): Promise<bigint> => (await vm.stateManager.getAccount(addr(a)))?.balance ?? 0n;

    // The factory, the stand-in exchange and the curve.
    const deploy = async (code: string, args = '') => {
      const r = await exec(CREATOR, null, code + args, 0n);
      expect(r.execResult.exceptionError).toBeUndefined();
      return r.createdAddress!.toString().toLowerCase();
    };
    const factory = await deploy(factoryArtifact.factory.bytecode, word(FEE_RECIPIENT) + word(0n));
    const exchange = await deploy((mockArtifact as any).MockExchange.bytecode);
    const feeTo = opts.feeRecipient ?? FEE_RECIPIENT;
    const curve = await deploy(curveArtifact.curve.bytecode, word(factory) + word(feeTo) + word(exchange));

    let factoryNonce = 1;
    const makeToken = async (creator: string, supply: bigint, decimals = 18) => {
      await fund(creator);
      const data = encodeCreate({ name: 'Test', symbol: 'TST', decimals, supply } as any);
      const r = await send(creator, factory, data, 0n);
      const log = r.execResult.logs.find((l: any) => toHex(l[0]).toLowerCase() === factory)!;
      const token = '0x' + toHex(log[1][1]).slice(-40);
      const nonce = factoryNonce++;
      return { token, nonce };
    };
    const tokenBalance = async (token: string, who: string) => BigInt(await view(token, '0x70a08231' + word(who)));
    const approve = (from: string, token: string, spender: string, amount: bigint) => send(from, token, '0x095ea7b3' + word(spender) + word(amount));

    const read = async (token: string) => {
      const h = (await view(curve, call('curves(address)', token))).slice(2);
      const w = (i: number) => BigInt('0x' + h.slice(i * 64, i * 64 + 64));
      return { status: Number(w(0)), creator: '0x' + h.slice(64 + 24, 128), createdAt: w(2), soldOutAt: w(3), feeBps: w(4), target: w(5), vSol0: w(6), curveTokens: w(7), lpTokens: w(8), vSol: w(9), vTok: w(10), realSol: w(11), realTok: w(12) };
    };
    const open = async (supply: bigint, total: bigint, target: bigint, creator = CREATOR) => {
      const t = await makeToken(creator, supply);
      await approve(creator, t.token, curve, total);
      await send(creator, curve, call('createCurve(address,uint256,uint256,uint256,uint256)', t.token, BigInt(t.nonce), total, target, 0n));
      return t;
    };
    return {
      donate: async (a: string, wei: bigint) => {
        const acc = await vm.stateManager.getAccount(addr(a));
        acc.balance += wei;
        await vm.stateManager.putAccount(addr(a), acc);
      },
      util, vm, now: () => now, advance: (s: number) => (now += s), fund, send, fails, view, balance, addr, curve, factory, exchange, makeToken, tokenBalance, approve, read, open, deploy, exec, toHex,
      buy: (from: string, token: string, wei: bigint, minOut = 0n) => send(from, curve, call('buy(address,uint256)', token, minOut), wei),
      sell: (from: string, token: string, amount: bigint, minOut = 0n) => send(from, curve, call('sell(address,uint256,uint256)', token, amount, minOut)),
      graduate: (from: string, token: string) => send(from, curve, call('graduate(address)', token)),
      abort: (from: string, token: string) => send(from, curve, call('abortMigration(address)', token)),
      mock: (name: string) => (mockArtifact as any)[name],
      mockSel: (name: string, sig: string): string => (mockArtifact as any)[name].selectors[sig],
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const SUPPLY = 10n ** 27n; // a billion tokens at 18 decimals
  const TARGET = 2n * ETH;
  const BUYER = '0x00000000000000000000000000000000000b0b01';
  const OTHER = '0x00000000000000000000000000000000000b0b02';

  it('derives the same split as the model, holds the tokens, and refuses everything it should', async () => {
    const w = await world();
    const t = await w.open(SUPPLY, SUPPLY, TARGET);
    const c = await w.read(t.token);
    const m = mDerive(SUPPLY, TARGET);
    expect(c).toMatchObject({ status: 1, creator: CREATOR, feeBps: 58n, target: TARGET, vSol0: m.vSol0, curveTokens: m.c, lpTokens: m.lp, vSol: m.vSol0, vTok: m.vTok0, realSol: 0n, realTok: m.c });
    expect(await w.tokenBalance(t.token, w.curve)).toBe(SUPPLY);

    // A second curve for the same token, a token the factory did not make, a wrong nonce, and numbers out of range.
    await w.approve(CREATOR, t.token, w.curve, SUPPLY);
    expect(await w.fails(CREATOR, w.curve, call('createCurve(address,uint256,uint256,uint256,uint256)', t.token, BigInt(t.nonce), 1n, TARGET, 0n))).toBe('exists');
    const b = await w.makeToken(CREATOR, SUPPLY);
    await w.approve(CREATOR, b.token, w.curve, SUPPLY);
    expect(await w.fails(CREATOR, w.curve, call('createCurve(address,uint256,uint256,uint256,uint256)', b.token, BigInt(b.nonce + 1), SUPPLY, TARGET, 0n))).toBe('not from the factory');
    expect(await w.fails(CREATOR, w.curve, call('createCurve(address,uint256,uint256,uint256,uint256)', b.token, 0n, SUPPLY, TARGET, 0n))).toBe('not from the factory');
    expect(await w.fails(CREATOR, w.curve, call('createCurve(address,uint256,uint256,uint256,uint256)', b.token, BigInt(b.nonce), 0n, TARGET, 0n))).toBe('total');
    expect(await w.fails(CREATOR, w.curve, call('createCurve(address,uint256,uint256,uint256,uint256)', b.token, BigInt(b.nonce), 1n << 97n, TARGET, 0n))).toBe('total');
    expect(await w.fails(CREATOR, w.curve, call('createCurve(address,uint256,uint256,uint256,uint256)', b.token, BigInt(b.nonce), SUPPLY, ETH / 1000n, 0n))).toBe('target');
    expect(await w.fails(CREATOR, w.curve, call('createCurve(address,uint256,uint256,uint256,uint256)', b.token, BigInt(b.nonce), SUPPLY, 10n ** 25n, 0n))).toBe('target');
  });

  it('lets the creator make the first buy inside the same transaction, or nothing happens at all', async () => {
    const w = await world();
    const t = await w.makeToken(CREATOR, SUPPLY);
    await w.approve(CREATOR, t.token, w.curve, SUPPLY);
    const d = mDerive(SUPPLY, TARGET);
    const q = mBuy({ vSol: d.vSol0, vTok: d.vTok0, realSol: 0n, realTok: d.c }, ETH)!;
    const create = (min: bigint) => call('createCurve(address,uint256,uint256,uint256,uint256)', t.token, BigInt(t.nonce), SUPPLY, TARGET, min);
    // A first buy that would give less than asked reverts the whole creation: no curve, and the tokens never left.
    expect(await w.fails(CREATOR, w.curve, create(q.out + 1n), ETH)).toBe('slippage');
    expect((await w.read(t.token)).status).toBe(0);
    expect(await w.tokenBalance(t.token, CREATOR)).toBe(SUPPLY);
    const before = await w.balance(CREATOR);
    await w.send(CREATOR, w.curve, create(q.out), ETH);
    const c = await w.read(t.token);
    expect([c.vSol, c.vTok, c.realSol, c.realTok]).toEqual([q.next.vSol, q.next.vTok, q.next.realSol, q.next.realTok]);
    expect(await w.tokenBalance(t.token, CREATOR)).toBe(q.out);
    expect(before - (await w.balance(CREATOR))).toBe(q.gross);
    expect(await w.balance(FEE_RECIPIENT)).toBe(q.fee);
    expect(await w.balance(w.curve)).toBe(c.realSol);
  });

  it('refuses a token deployed by someone else, however it is dressed up', async () => {
    const w = await world();
    // The factory makes tokens at addresses fixed by its own nonce. Make a token by hand, with the same constructor, and try it.
    const args = word(160n) + word(224n) + word(18n) + word(SUPPLY) + word(CREATOR) + word(4n) + '5465737400000000000000000000000000000000000000000000000000000000' + word(3n) + '5453540000000000000000000000000000000000000000000000000000000000';
    const own = await w.deploy(factoryArtifact.token.bytecode, args);
    await w.approve(CREATOR, own, w.curve, SUPPLY);
    for (const nonce of [0n, 1n, 2n, 3n, 255n, 256n, 65_536n, 16_777_216n, 4_294_967_295n]) {
      expect(await w.fails(CREATOR, w.curve, call('createCurve(address,uint256,uint256,uint256,uint256)', own, nonce, SUPPLY, TARGET, 0n))).toBe('not from the factory');
    }
    expect(await w.fails(CREATOR, w.curve, call('createCurve(address,uint256,uint256,uint256,uint256)', own, 4_294_967_296n, SUPPLY, TARGET, 0n))).toBe('nonce');
  });

  it('works for every factory nonce size: the token address the contract derives is the one the factory made', async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) {
      const t = await w.makeToken(CREATOR, SUPPLY);
      const expected = w.util.bytesToHex(w.util.generateAddress(w.util.hexToBytes(w.factory), w.util.intToBytes(t.nonce))).toLowerCase();
      expect(t.token).toBe(expected);
    }
  });

  it('prices every buy and sell exactly as the model does, and the fee reaches the recipient to the wei', async () => {
    const w = await world();
    const t = await w.open(SUPPLY, SUPPLY, TARGET);
    await w.fund(BUYER);
    const d = mDerive(SUPPLY, TARGET);
    let m: Model = { vSol: d.vSol0, vTok: d.vTok0, realSol: 0n, realTok: d.c };
    let feeTotal = 0n;
    for (const offer of [ETH / 10n, ETH / 3n, ETH / 50n, ETH / 5n]) {
      const q = mBuy(m, offer)!;
      const before = await w.tokenBalance(t.token, BUYER);
      const ethBefore = await w.balance(BUYER);
      const buyRun = await w.buy(BUYER, t.token, offer, q.out);
      process.stdout.write(`GAS buy ${buyRun.execResult.executionGasUsed}
`);
      expect(buyRun.execResult.executionGasUsed < 200_000n).toBe(true);
      expect((await w.tokenBalance(t.token, BUYER)) - before).toBe(q.out);
      expect(ethBefore - (await w.balance(BUYER))).toBe(q.gross);
      m = q.next;
      feeTotal += q.fee;
      const c = await w.read(t.token);
      expect([c.vSol, c.vTok, c.realSol, c.realTok]).toEqual([m.vSol, m.vTok, m.realSol, m.realTok]);
    }
    expect(await w.balance(FEE_RECIPIENT)).toBe(feeTotal);
    const held = await w.tokenBalance(t.token, BUYER);
    const s = mSell(m, d.c, held / 2n)!;
    await w.approve(BUYER, t.token, w.curve, held / 2n);
    const ethBefore = await w.balance(BUYER);
    const sellRun = await w.sell(BUYER, t.token, held / 2n, s.net);
    process.stdout.write(`GAS sell ${sellRun.execResult.executionGasUsed}
`);
    expect(sellRun.execResult.executionGasUsed < 200_000n).toBe(true);
    expect((await w.balance(BUYER)) - ethBefore).toBe(s.net);
    expect(await w.balance(FEE_RECIPIENT)).toBe(feeTotal + s.fee);
    const c = await w.read(t.token);
    expect([c.vSol, c.vTok, c.realSol, c.realTok]).toEqual([s.next.vSol, s.next.vTok, s.next.realSol, s.next.realTok]);
    // The contract holds exactly what it owes.
    expect(await w.balance(w.curve)).toBe(c.realSol);
    expect(BigInt(await w.view(w.curve, call('totalOwed()')))).toBe(c.realSol);
  });

  it('refuses a buy or sell below the limit, dust, and selling more than was ever sold', async () => {
    const w = await world();
    const t = await w.open(SUPPLY, SUPPLY, TARGET);
    await w.fund(BUYER);
    const d = mDerive(SUPPLY, TARGET);
    const q = mBuy({ vSol: d.vSol0, vTok: d.vTok0, realSol: 0n, realTok: d.c }, ETH)!;
    expect(await w.fails(BUYER, w.curve, call('buy(address,uint256)', t.token, q.out + 1n), ETH)).toBe('slippage');
    expect(await w.fails(BUYER, w.curve, call('buy(address,uint256)', t.token, 0n), 0n)).toBe('amount');
    expect(await w.fails(BUYER, w.curve, call('buy(address,uint256)', t.token, 0n), 1n)).toBe('amount');
    await w.buy(BUYER, t.token, ETH);
    const held = await w.tokenBalance(t.token, BUYER);
    await w.approve(BUYER, t.token, w.curve, held);
    expect(await w.fails(BUYER, w.curve, call('sell(address,uint256,uint256)', t.token, held, 10n ** 30n))).toBe('slippage');
    expect(await w.fails(BUYER, w.curve, call('sell(address,uint256,uint256)', t.token, 0n, 0n))).toBe('amount');
    // Someone holding tokens that did not come from the curve cannot sell more than the curve has handed out.
    await w.approve(CREATOR, t.token, w.curve, 1n);
    expect(await w.fails(CREATOR, w.curve, call('sell(address,uint256,uint256)', t.token, 1n, 0n))).toBe('balance');
  });

  it('cuts an oversized buy to what is left, sends the rest back, and closes', async () => {
    const w = await world();
    const t = await w.open(SUPPLY, SUPPLY, TARGET);
    await w.fund(BUYER);
    const d = mDerive(SUPPLY, TARGET);
    const q = mBuy({ vSol: d.vSol0, vTok: d.vTok0, realSol: 0n, realTok: d.c }, 100n * ETH)!;
    const before = await w.balance(BUYER);
    await w.buy(BUYER, t.token, 100n * ETH);
    expect(before - (await w.balance(BUYER))).toBe(q.gross);
    expect(q.gross < 100n * ETH).toBe(true);
    const c = await w.read(t.token);
    expect(c.status).toBe(2);
    expect(c.realTok).toBe(0n);
    expect(c.realSol > TARGET - 10n && c.realSol < TARGET + 10n).toBe(true);
    expect(await w.fails(BUYER, w.curve, call('buy(address,uint256)', t.token, 0n), ETH)).toBe('not trading');
    await w.approve(BUYER, t.token, w.curve, 5n);
    expect(await w.fails(BUYER, w.curve, call('sell(address,uint256,uint256)', t.token, 5n, 0n))).toBe('not open');
  });

  it('cannot be drained by a long random run of buys and sells, and tracks the model each step', async () => {
    const w = await world();
    const t = await w.open(SUPPLY, SUPPLY, 20n * ETH);
    const people = ['0x00000000000000000000000000000000000a0001', '0x00000000000000000000000000000000000a0002', '0x00000000000000000000000000000000000a0003'];
    for (const p of people) await w.fund(p);
    const d = mDerive(SUPPLY, 20n * ETH);
    let m: Model = { vSol: d.vSol0, vTok: d.vTok0, realSol: 0n, realTok: d.c };
    let seed = 0x9e3779b97f4a7c15n;
    const next = () => {
      seed ^= (seed << 13n) & 0xffffffffffffffffn;
      seed ^= seed >> 7n;
      seed ^= (seed << 17n) & 0xffffffffffffffffn;
      return seed;
    };
    for (let step = 0; step < 60; step++) {
      const who = people[Number(next() % 3n)]!;
      const held = await w.tokenBalance(t.token, who);
      if (held > 0n && next() % 2n === 0n) {
        const amount = (held * (1n + (next() % 100n))) / 100n || 1n;
        const s = mSell(m, d.c, amount);
        await w.approve(who, t.token, w.curve, amount);
        if (s) {
          await w.sell(who, t.token, amount, s.net);
          m = s.next;
        } else expect(await w.fails(who, w.curve, call('sell(address,uint256,uint256)', t.token, amount, 0n))).toBeTruthy();
      } else {
        const offer = ETH / 1000n + (next() % (6n * ETH));
        const q = mBuy(m, offer);
        if (q) {
          await w.buy(who, t.token, offer, q.out);
          m = q.next;
        } else expect(await w.fails(who, w.curve, call('buy(address,uint256)', t.token, 0n), offer)).toBeTruthy();
      }
      const c = await w.read(t.token);
      expect([c.vSol, c.vTok, c.realSol, c.realTok], `step ${step}`).toEqual([m.vSol, m.vTok, m.realSol, m.realTok]);
      expect(c.vSol - c.realSol).toBe(d.vSol0);
      expect(await w.balance(w.curve)).toBe(c.realSol);
      if (c.status !== 1) break;
    }
  });

  it('refuses a seller that tries to re-enter while it is being paid', async () => {
    const w = await world();
    const t = await w.open(SUPPLY, SUPPLY, TARGET);
    const re = await w.deploy((w.mock('Reenter') as any).bytecode, word(w.curve) + word(t.token));
    await w.donate(re, 10n ** 20n);
    const rs = (sig: string) => '0x' + w.mockSel('Reenter', sig);
    await w.send(CREATOR, re, rs('buyOnce(uint256)') + word(0n).slice(0, 0) + word(0n), ETH / 2n);
    const held = await w.tokenBalance(t.token, re);
    expect(held > 0n).toBe(true);
    await w.send(CREATOR, re, rs('approveCurve(uint256)') + word(held));
    await w.send(CREATOR, re, rs('setMode(uint256)') + word(2n));
    // The sale pays the contract, whose receive function tries to sell again from inside the payment.
    await w.send(CREATOR, re, rs('sellOnce(uint256)') + word(held / 2n));
    expect(BigInt(await w.view(re, rs('blocked()')))).toBe(1n);
    expect(BigInt(await w.view(re, rs('nestedOk()')))).toBe(0n);
    const c = await w.read(t.token);
    expect(await w.balance(w.curve)).toBe(c.realSol);
  });

  async function soldOut(w: World, creator = CREATOR) {
    const t = await w.open(SUPPLY, SUPPLY, TARGET, creator);
    await w.fund(BUYER);
    await w.buy(BUYER, t.token, 100n * ETH);
    expect((await w.read(t.token)).status).toBe(2);
    return t;
  }
  const graduateCall = (token: string) => call('graduate(address)', token);

  it('graduates into the exchange: liquidity to the dead address, the pool at the curve’s price, nothing left owed', async () => {
    const w = await world();
    const t = await soldOut(w);
    const before = await w.read(t.token);
    const gradRun = await w.graduate(OTHER, t.token);
    process.stdout.write(`GAS graduate (stand-in exchange) ${gradRun.execResult.executionGasUsed}
`);
    const after = await w.read(t.token);
    expect(after.status).toBe(3);
    expect(after.realSol).toBe(0n);
    expect(BigInt(await w.view(w.curve, call('totalOwed()')))).toBe(0n);
    const pair = '0x' + (await w.view(w.exchange, '0x' + w.mockSel('MockExchange', 'getPair(address,address)') + word(t.token) + word('0x00000000000000000000000000000000000bee70'))).slice(-40);
    expect(await w.tokenBalance(t.token, pair)).toBe(before.lpTokens);
    // The exchange recorded the dead address as the liquidity's owner.
    const to = await w.view(w.exchange, '0x' + w.mockSel('MockExchange', 'lastLiquidityTo()'));
    expect('0x' + to.slice(-40)).toBe(DEAD);
    // The pool holds the whole raise and the whole pool allocation (the mock keeps coin in the exchange, as the real pair would).
    expect(await w.balance(w.exchange)).toBeGreaterThanOrEqual(before.realSol - before.realSol / 1000n);
    // Closed: no second graduation, no trades.
    expect(await w.fails(OTHER, w.curve, graduateCall(t.token))).toBe('not sold out');
    expect(await w.fails(BUYER, w.curve, call('buy(address,uint256)', t.token, 0n), ETH)).toBe('not trading');
  });

  it('refuses to graduate into a pool someone made at another price, and lets holders out after a week', async () => {
    const w = await world();
    const t = await soldOut(w);
    const c = await w.read(t.token);
    // Someone opens the pool first at half the right price (twice the tokens for the same coin).
    await w.send(CREATOR, w.exchange, '0x' + w.mockSel('MockExchange', 'seedPool(address,uint112,uint112)') + word(t.token) + word(c.lpTokens * 2n) + word(c.realSol));
    const why = await w.fails(OTHER, w.curve, graduateCall(t.token));
    expect(why === 'INSUFFICIENT_A_AMOUNT' || why === 'INSUFFICIENT_B_AMOUNT' || why === 'pool price').toBe(true);
    expect((await w.read(t.token)).status).toBe(2);
    expect(await w.fails(OTHER, w.curve, call('abortMigration(address)', t.token))).toBe('too early');
    w.advance(7 * 24 * 3600 - 5);
    expect(await w.fails(OTHER, w.curve, call('abortMigration(address)', t.token))).toBe('too early');
    w.advance(10);
    await w.abort(OTHER, t.token);
    expect((await w.read(t.token)).status).toBe(4);
    // Buying stays closed; selling reopens and every holder can leave.
    expect(await w.fails(BUYER, w.curve, call('buy(address,uint256)', t.token, 0n), ETH)).toBe('not trading');
    const held = await w.tokenBalance(t.token, BUYER);
    await w.approve(BUYER, t.token, w.curve, held);
    await w.sell(BUYER, t.token, held);
    const after = await w.read(t.token);
    expect(after.realTok).toBe(after.curveTokens);
    expect(after.realSol < 100n).toBe(true);
    expect(await w.balance(w.curve)).toBeGreaterThanOrEqual(after.realSol);
  });

  it('accepts no coin from anyone but the exchange, and has no way to change anything', async () => {
    const w = await world();
    expect(await w.fails(CREATOR, w.curve, '0x', 1n)).toBe('no deposits');
    // The ABI has no owner, admin, setter, upgrade or withdraw function.
    const names = (curveArtifact.curve.abi as { type: string; name?: string; stateMutability?: string }[]).filter((x) => x.type === 'function');
    for (const f of names) expect(/owner|admin|set[A-Z]|upgrade|withdraw|rescue|sweep|pause/i.test(f.name!)).toBe(false);
    expect(names.map((f) => f.name).sort()).toEqual(['DEAD', 'DUST_BPS', 'FEE_BPS', 'MAX_TARGET', 'MAX_TOTAL', 'MIN_TARGET', 'PRICE_TOLERANCE_BPS', 'ABORT_AFTER', 'abortMigration', 'buy', 'createCurve', 'curves', 'factory', 'feeRecipient', 'graduate', 'quoteBuy', 'router', 'sell', 'totalOwed', 'weth'].sort());
    // Donations of coin by self-destruct-style means cannot be tested here, but the accounting never reads the balance, only the stored numbers.
    const t = await w.open(SUPPLY, SUPPLY, TARGET);
    await w.fund(BUYER);
    await w.donate(w.curve, 5n * ETH);
    const d = mDerive(SUPPLY, TARGET);
    const q = mBuy({ vSol: d.vSol0, vTok: d.vTok0, realSol: 0n, realTok: d.c }, ETH)!;
    await w.buy(BUYER, t.token, ETH, q.out);
    const c = await w.read(t.token);
    expect([c.vSol, c.realSol]).toEqual([q.next.vSol, q.next.realSol]);
  });

  // ---------------------------------------------------------------- the web flow, driving the real compiled contract

  /** The page's flow, wired to the in-process EVM: reads, simulation, and a "wallet" that sends from whichever account is selected. */
  function flowFor(w: World, getChain: () => EvmCurveChain) {
    let account = CREATOR;
    const receipts = new Map<string, { status: string }>();
    let hashCounter = 0;
    let clock = 0;
    const sent: any[] = [];
    const hex = (n: bigint) => '0x' + n.toString(16);
    const simulate = async (tx: any, commit: boolean) => w.exec(tx.from ?? CREATOR, tx.to, tx.data, BigInt(tx.value ?? '0x0'), commit);
    const read = async (method: string, params: unknown[]): Promise<unknown> => {
      const p = params as any[];
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_getCode') return w.toHex(await w.vm.stateManager.getCode(w.addr(p[0])));
      if (method === 'eth_getBalance') return hex((await w.vm.stateManager.getAccount(w.addr(p[0])))?.balance ?? 0n);
      if (method === 'eth_getTransactionCount') return hex((await w.vm.stateManager.getAccount(w.addr(p[0])))?.nonce ?? 0n);
      if (method === 'eth_gasPrice') return hex(20_000_000_000n);
      if (method === 'eth_estimateGas' || method === 'eth_call') {
        const r = await simulate(p[0], false);
        if (r.execResult.exceptionError) throw new Error(`execution reverted: ${r.execResult.returnValue.length ? Buffer.from(w.toHex(r.execResult.returnValue).slice(2 + 8 + 128), 'hex').toString().replace(/\0/g, '').trim() : ''}`);
        return method === 'eth_call' ? w.toHex(r.execResult.returnValue) : hex(r.execResult.executionGasUsed + 21_000n);
      }
      if (method === 'eth_getTransactionReceipt') return receipts.get(p[0]) ?? null;
      throw new Error(`unexpected ${method}`);
    };
    const adapter = {
      getAccounts: async () => [account],
      getChainId: async () => 1,
      switchChain: async () => undefined,
      sendTransaction: async (tx: any) => {
        sent.push(tx);
        const r = await simulate(tx, true);
        const hash = '0x' + (++hashCounter).toString(16).padStart(64, '0');
        receipts.set(hash, { status: r.execResult.exceptionError ? '0x0' : '0x1' });
        return hash;
      },
    };
    const flow = new EvmCurveFlow({ adapter, read, now: () => (clock += 60_000), nowSeconds: () => w.now(), sleep: async () => undefined } as any);
    void getChain;
    return { flow, sent, as: (a: string) => void (account = a) };
  }

  async function chainFor(w: World): Promise<EvmCurveChain> {
    const base = evmCurveChain('ethereum', { ethereum: w.curve })!;
    return { ...base, factory: w.factory };
  }
  const configFor = (chain: EvmCurveChain, token: string, nonce: number, total: bigint, target: bigint, firstBuy = 0n): EvmCurveConfig => ({
    chain,
    creator: CREATOR,
    token,
    tokenSymbol: 'TST',
    tokenDecimals: 18,
    tokenSupply: SUPPLY,
    factoryNonce: BigInt(nonce),
    totalRaw: total,
    targetWei: target,
    firstBuyWei: firstBuy,
    derived: evmDerive(total, target)!,
  });

  it('the web flow opens a curve, with the creator’s own first buy, against the real contract', async () => {
    const w = await world();
    const chain = await chainFor(w);
    const t = await w.makeToken(CREATOR, SUPPLY);
    const f = flowFor(w, () => chain);
    // The factory proof: the flow finds the nonce from the factory's own account nonce.
    const info = await f.flow.loadToken(chain, CREATOR, t.token);
    expect(info).toMatchObject({ symbol: 'TST', decimals: 18, supply: SUPPLY, held: SUPPLY, factoryNonce: BigInt(t.nonce) });
    const other = await w.makeToken(CREATOR, SUPPLY);
    expect((await f.flow.loadToken(chain, CREATOR, other.token))!.factoryNonce).toBe(BigInt(other.nonce));
    expect((await f.flow.loadToken(chain, CREATOR, w.curve))?.factoryNonce ?? null).toBeNull();

    const config = configFor(chain, t.token, t.nonce, SUPPLY, TARGET, ETH);
    const review = await f.flow.prepareCreate(config);
    expect(review.blockers).toEqual([]);
    const steps: string[] = [];
    const out = await f.flow.create(review, (p) => steps.push(p));
    expect(out.differences).toEqual([]);
    expect(out.hashes).toHaveLength(2);
    expect(steps[0]).toBe('checking');
    expect(steps.at(-1)).toBe('done');
    expect(f.sent).toHaveLength(2);
    const c = await w.read(t.token);
    const d = mDerive(SUPPLY, TARGET);
    const q = mBuy({ vSol: d.vSol0, vTok: d.vTok0, realSol: 0n, realTok: d.c }, ETH)!;
    expect([c.vSol, c.vTok, c.realSol, c.realTok]).toEqual([q.next.vSol, q.next.vTok, q.next.realSol, q.next.realTok]);
    expect(await w.tokenBalance(t.token, CREATOR)).toBe(q.out);
    // The same curve cannot be opened twice.
    expect((await f.flow.prepareCreate(config)).blockers.join(' ')).toMatch(/already exists/);
  });

  it('the web flow buys, sells, sells the curve out, and graduates, against the real contract', async () => {
    const w = await world();
    const chain = await chainFor(w);
    const t = await w.open(SUPPLY, SUPPLY, TARGET);
    const f = flowFor(w, () => chain);
    await w.fund(BUYER);
    f.as(BUYER);
    let curve = (await f.flow.loadCurve(chain, t.token))!;
    expect(curve.status).toBe('trading');

    const buyReview = await f.flow.prepareBuy(chain, BUYER, curve, t.token, ETH);
    expect(buyReview.blockers).toEqual([]);
    expect(buyReview.quote!.fee).toBe((ETH * 58n + 9_999n) / 10_000n);
    const bought = await f.flow.buy(buyReview);
    expect(bought.differences).toEqual([]);
    expect(bought.tokensAfter).toBe(buyReview.quote!.tokensOut);

    curve = (await f.flow.loadCurve(chain, t.token))!;
    const sellReview = await f.flow.prepareSell(chain, BUYER, curve, t.token, buyReview.quote!.tokensOut / 2n);
    expect(sellReview.blockers).toEqual([]);
    const sold = await f.flow.sell(sellReview);
    expect(sold.differences).toEqual([]);
    expect(sold.hashes).toHaveLength(2);
    expect(sold.tokensAfter).toBe(buyReview.quote!.tokensOut - buyReview.quote!.tokensOut / 2n);

    curve = (await f.flow.loadCurve(chain, t.token))!;
    const rest = await f.flow.prepareBuy(chain, BUYER, curve, t.token, 100n * ETH);
    expect(rest.blockers).toEqual([]);
    expect(rest.quote!.soldOut).toBe(true);
    await f.flow.buy(rest);
    curve = (await f.flow.loadCurve(chain, t.token))!;
    expect(curve.status).toBe('soldOut');

    // Closed for trading; too early to unwind; graduation goes through.
    expect((await f.flow.prepareBuy(chain, BUYER, curve, t.token, ETH)).blockers.join(' ')).toMatch(/not open for buying/);
    expect((await f.flow.prepareAbort(chain, BUYER, curve, t.token)).blockers.join(' ')).toMatch(/seven days/);
    const grad = await f.flow.prepareGraduate(chain, BUYER, curve, t.token);
    expect(grad.blockers).toEqual([]);
    const out = await f.flow.graduate(grad);
    expect(out.differences).toEqual([]);
    expect((await f.flow.loadCurve(chain, t.token))!.status).toBe('migrated');
  });

  it('the web flow unwinds a curve whose pool someone made first, and lets holders sell back', async () => {
    const w = await world();
    const chain = await chainFor(w);
    const t = await soldOut(w);
    const f = flowFor(w, () => chain);
    f.as(BUYER);
    let curve = (await f.flow.loadCurve(chain, t.token))!;
    const c = await w.read(t.token);
    await w.send(CREATOR, w.exchange, '0x' + w.mockSel('MockExchange', 'seedPool(address,uint112,uint112)') + word(t.token) + word(c.lpTokens * 2n) + word(c.realSol));
    // The page refuses before sending: the network would refuse, and it says why.
    const grad = await f.flow.prepareGraduate(chain, BUYER, curve, t.token);
    expect(grad.blockers.join(' ')).toMatch(/already exists at another price/);
    w.advance(7 * 24 * 3600 + 10);
    curve = (await f.flow.loadCurve(chain, t.token))!;
    const abort = await f.flow.prepareAbort(chain, BUYER, curve, t.token);
    expect(abort.blockers).toEqual([]);
    expect((await f.flow.abort(abort)).differences).toEqual([]);
    curve = (await f.flow.loadCurve(chain, t.token))!;
    expect(curve.status).toBe('aborted');
    const held = await w.tokenBalance(t.token, BUYER);
    const sell = await f.flow.prepareSell(chain, BUYER, curve, t.token, held);
    expect(sell.blockers).toEqual([]);
    expect((await f.flow.sell(sell)).differences).toEqual([]);
  });

  it('the web flow will not sign a transaction that is not the one reviewed', async () => {
    const w = await world();
    const chain = await chainFor(w);
    const t = await w.open(SUPPLY, SUPPLY, TARGET);
    await w.fund(BUYER);
    const f = flowFor(w, () => chain);
    f.as(BUYER);
    const curve = (await f.flow.loadCurve(chain, t.token))!;
    const review = await f.flow.prepareBuy(chain, BUYER, curve, t.token, ETH);
    // Someone swaps the amount of coin in the built transaction for a bigger one, or the curve for another contract.
    await expect(f.flow.buy({ ...review, tx: { ...review.tx, value: '0x' + (10n * ETH).toString(16) } })).rejects.toThrow(/Not signing/);
    await expect(f.flow.buy({ ...review, tx: { ...review.tx, to: BUYER } })).rejects.toThrow(/Not signing/);
    expect(f.sent).toHaveLength(0);
    // A review with blockers is never sent, and a changed wallet account stops it.
    await expect(f.flow.buy({ ...review, blockers: ['x'] })).rejects.toMatchObject({ nothingSent: true });
    f.as(OTHER);
    await expect(f.flow.buy(review)).rejects.toThrow(/account selected in your wallet changed/);
    expect(f.sent).toHaveLength(0);
  });
});
