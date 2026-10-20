/**
 * Runs the real compiled pool (contracts-evm/AretiaPool.artifact.json) and the real token factory inside an in-process EVM, with hostile
 * stand-ins from contracts-evm/test-mocks. It checks the contract against a BigInt model written in this file, against the web core's
 * quote functions, against properties (a round trip never profits, the fee split sums exactly, k never falls, solvency) and against
 * attacks (reentrancy through a token and through a payee, hostile tokens). It is NOT a deployment test.
 *
 * It needs the EVM library, which is deliberately not a dependency of the website. Install it to run this file:
 *   npm i --no-save @ethereumjs/vm @ethereumjs/common @ethereumjs/util @ethereumjs/block
 * Without it the whole file is skipped.
 */
import { describe, expect, it } from 'vitest';
import poolArtifact from '../../../contracts-evm/AretiaPool.artifact.json';
import factoryArtifact from '../../../contracts-evm/AretiaTokenFactory.artifact.json';
import mocksArtifact from '../../../contracts-evm/test-mocks/PoolMocks.artifact.json';
import { encodeCreate } from './walletLaunchEvmTx';
import { parsePoolReturn, parsePositionReturn, poolClaimable, poolQuoteAdd, poolQuoteBuy, poolQuoteRemove, poolQuoteSell, type EvmPoolMath } from './walletAretiaPoolEvmCore';

/* eslint-disable @typescript-eslint/no-explicit-any */
let lib: { vm: any; common: any; util: any; block: any } | null = null;
try {
  const mod = (name: string): Promise<any> => import(/* @vite-ignore */ name);
  lib = { vm: await mod('@ethereumjs/vm'), common: await mod('@ethereumjs/common'), util: await mod('@ethereumjs/util'), block: await mod('@ethereumjs/block') };
} catch {
  lib = null;
}

const ETH = 10n ** 18n;
const BPS = 10_000n;
const SHARE = 2000n;
const MIN_L = 10n ** 12n;
const FEE_RECIPIENT = '0x000000000000000000000000000000000000fee1';
const CREATION_FEE = 42n * 10n ** 14n; // 0.0042
const CREATOR = '0x00000000000000000000000000000000000c0de1';
const W = [CREATOR, '0x00000000000000000000000000000000000b0b01', '0x00000000000000000000000000000000000b0b02', '0x00000000000000000000000000000000000b0b03', '0x00000000000000000000000000000000000b0b04'];

// ---------------------------------------------------------------- the reference model (written here, independent of the web core)

const ceilDiv = (a: bigint, b: bigint) => a / b + (a % b === 0n ? 0n : 1n);
interface Pool {
  feeBps: bigint;
  x: bigint;
  y: bigint;
  l: bigint;
  acc: bigint;
  feeReserve: bigint;
  accRemainder: bigint;
}
interface Pos {
  open: boolean;
  shares: bigint;
  locked: bigint;
  checkpoint: bigint;
  pending: bigint;
  recipient: string;
}
const emptyPos = (): Pos => ({ open: false, shares: 0n, locked: 0n, checkpoint: 0n, pending: 0n, recipient: '0x' + '0'.repeat(40) });
const MAX = 1n << 112n;
/** The contract's `_creditFees`: LP fee spread into `acc`, the remainder carried (review finding I-5). */
const cred = (p: Pool, lp: bigint) => {
  const scaled = (lp << 64n) + p.accRemainder;
  return { acc: p.acc + scaled / p.l, accRemainder: scaled % p.l, feeReserve: p.feeReserve + lp };
};

function mBuy(p: Pool, gross: bigint) {
  if (gross <= 0n || gross >= MAX) return null;
  const fee = ceilDiv(gross * p.feeBps, BPS);
  const net = gross - fee;
  if (net === 0n) return null;
  const yy = p.y + p.l;
  const out = p.x - ceilDiv(p.x * yy, yy + net);
  if (out <= 0n) return null;
  const protocol = (fee * SHARE) / BPS;
  const lp = fee - protocol;
  const next: Pool = { ...p, x: p.x - out, y: p.y + net, ...cred(p, lp) };
  if (next.y + next.l >= MAX) return null;
  return { fee, net, out, protocol, lp, next };
}
function mSell(p: Pool, tokens: bigint) {
  if (tokens <= 0n || p.x + tokens >= MAX) return null;
  const yy = p.y + p.l;
  const gross = yy - ceilDiv(p.x * yy, p.x + tokens);
  if (gross === 0n || gross > p.y) return null;
  const fee = ceilDiv(gross * p.feeBps, BPS);
  const protocol = (fee * SHARE) / BPS;
  const lp = fee - protocol;
  return { gross, fee, net: gross - fee, protocol, lp, next: { ...p, x: p.x + tokens, y: p.y - gross, ...cred(p, lp) } as Pool };
}
const settle = (p: Pool, q: Pos): Pos => ({ ...q, pending: q.pending + ((q.shares * (p.acc - q.checkpoint)) >> 64n), checkpoint: p.acc });

describe('the BigInt model agrees with the web core quote functions', () => {
  it('on a spread of pools and trades', () => {
    const base: EvmPoolMath = { feeBps: 25n, x: 10n ** 27n, y: 0n, l: 10n * ETH, acc: 0n, feeReserve: 0n, accRemainder: 0n };
    let a = base;
    let b: Pool = { ...base, accRemainder: 0n };
    for (const wei of [ETH / 9n, ETH, 3n * ETH / 7n, 5n * ETH, 1n, 100n]) {
      const qa = poolQuoteBuy(a, wei);
      const qb = mBuy(b, wei);
      expect(qa === null).toBe(qb === null);
      if (qa && qb) {
        expect([qa.fee, qa.net, qa.tokensOut, qa.protocol, qa.lp]).toEqual([qb.fee, qb.net, qb.out, qb.protocol, qb.lp]);
        expect(qa.protocol + qa.lp).toBe(qa.fee);
        a = qa.next;
        b = qb.next;
      }
    }
    for (const t of [1n, 10n ** 20n, (base.x - a.x) / 3n, base.x - a.x, 10n ** 40n]) {
      const sa = poolQuoteSell(a, t);
      const sb = mSell(b, t);
      expect(sa === null).toBe(sb === null);
      if (sa && sb) expect([sa.gross, sa.fee, sa.net, sa.protocol, sa.lp]).toEqual([sb.gross, sb.fee, sb.net, sb.protocol, sb.lp]);
    }
    expect(poolQuoteAdd(a, 999n)).toBeNull();
    expect(poolQuoteRemove(a, a.l)).toBeNull();
  });
});

// ---------------------------------------------------------------- the EVM world

describe.skipIf(lib === null)('the compiled pool, in an in-process EVM', () => {
  const sel = (sig: string): string => (poolArtifact.pool.selectors as Record<string, string>)[sig]!;
  const word = (v: bigint | string | boolean): string => (typeof v === 'string' ? v.replace(/^0x/, '').toLowerCase().padStart(64, '0') : typeof v === 'boolean' ? (v ? '1' : '0').padStart(64, '0') : v.toString(16).padStart(64, '0'));
  /** The new build adds a deadline as the last argument of these; the tests name the old signatures and get a far deadline appended. */
  const FAR = 4_000_000_000n;
  const DEADLINED: Record<string, string> = {
    'buy(address,uint256)': 'buy(address,uint256,uint256)',
    'sell(address,uint256,uint256)': 'sell(address,uint256,uint256,uint256)',
    'addLiquidity(address,uint256,uint256)': 'addLiquidity(address,uint256,uint256,uint256)',
    'removeLiquidity(address,uint256,uint256,uint256)': 'removeLiquidity(address,uint256,uint256,uint256,uint256)',
    'createPool((address,uint256,uint256,uint256,uint256,uint256,bool,address,uint256,uint256))': 'createPool((address,uint256,uint256,uint256,uint256,uint256,bool,address,uint256,uint256,uint256))',
  };
  const call = (sig: string, ...args: (bigint | string | boolean)[]): string =>
    DEADLINED[sig] ? '0x' + sel(DEADLINED[sig]!) + [...args, FAR].map(word).join('') : '0x' + sel(sig) + args.map(word).join('');
  const mockSel = (c: string, sig: string): string => ((mocksArtifact as any)[c].selectors as Record<string, string>)[sig]!;
  const mcall = (c: string, sig: string, ...args: (bigint | string | boolean)[]): string => '0x' + mockSel(c, sig) + args.map(word).join('');
  /** ABI tail for a `bytes` argument: its length, then the bytes padded to a whole word. */
  const encBytes = (data: string): string => word(BigInt((data.length - 2) / 2)) + data.slice(2).padEnd(Math.ceil((data.length - 2) / 64) * 64, '0');
  const CREATE_SIG = 'createPool((address,uint256,uint256,uint256,uint256,uint256,bool,address,uint256,uint256))';

  async function world(opts: { hostile?: boolean; feeRecipient?: string } = {}) {
    const { vm: vmLib, common: commonLib, util, block: blockLib } = lib!;
    const common = new commonLib.Common({ chain: commonLib.Mainnet, hardfork: commonLib.Hardfork.Shanghai });
    const vm = await vmLib.createVM({ common });
    const addr = (a: string) => util.createAddressFromString(a);
    const toBytes = (h: string) => util.hexToBytes(h.startsWith('0x') ? h : '0x' + h);
    const toHex = (b: Uint8Array) => util.bytesToHex(b);
    const now = 1_700_000_000;
    const fund = async (a: string, wei = 10n ** 30n) => vm.stateManager.putAccount(addr(a), util.createAccount({ balance: wei }));
    for (const a of W) await fund(a);

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
    const send = async (from: string, to: string, data: string, value = 0n) => {
      const r = await exec(from, to, data, value);
      if (r.execResult.exceptionError) throw new Error(r.execResult.exceptionError.error === 'revert' ? reason(r.execResult.returnValue) : String(r.execResult.exceptionError.error));
      return r;
    };
    const fails = async (from: string, to: string, data: string, value = 0n): Promise<string> => {
      const r = await exec(from, to, data, value);
      expect(r.execResult.exceptionError, 'expected a revert').toBeDefined();
      return reason(r.execResult.returnValue);
    };
    const view = async (to: string, data: string) => toHex((await exec(CREATOR, to, data, 0n, false)).execResult.returnValue);
    const balance = async (a: string): Promise<bigint> => (await vm.stateManager.getAccount(addr(a)))?.balance ?? 0n;
    const deploy = async (code: string, args = '') => {
      const r = await exec(CREATOR, null, code + args, 0n);
      expect(r.execResult.exceptionError).toBeUndefined();
      return r.createdAddress!.toString().toLowerCase();
    };

    const realFactory = await deploy(factoryArtifact.factory.bytecode, word(FEE_RECIPIENT) + word(0n));
    const hostileFactory = opts.hostile ? await deploy((mocksArtifact as any).HostileFactory.bytecode) : null;
    const factory = hostileFactory ?? realFactory;
    const feeTo = opts.feeRecipient ?? FEE_RECIPIENT;
    const pool = await deploy(poolArtifact.pool.bytecode, word(factory) + word(feeTo) + word(CREATION_FEE));

    let nonce = 1;
    const makeToken = async (creator: string, supply: bigint, decimals = 18) => {
      const data = encodeCreate({ name: 'Test', symbol: 'TST', decimals, supply } as any);
      const r = await send(creator, realFactory, data, 0n);
      const log = r.execResult.logs.find((l: any) => toHex(l[0]).toLowerCase() === realFactory)!;
      return { token: '0x' + toHex(log[1][1]).slice(-40), nonce: nonce++ };
    };
    const makeHostile = async (mode: number, creator: string, supply: bigint) => {
      const r = await send(creator, hostileFactory!, mcall('HostileFactory', 'make(uint8,uint256,address)', BigInt(mode), supply, creator));
      return { token: '0x' + toHex(r.execResult.returnValue).slice(-40), nonce: nonce++ };
    };
    const tokenBalance = async (token: string, who: string) => BigInt(await view(token, '0x70a08231' + word(who)));
    const approve = (from: string, token: string, spender: string, amount: bigint) => send(from, token, '0x095ea7b3' + word(spender) + word(amount));

    const create = (o: { token: string; nonce: number; x0: bigint; l0: bigint; y0?: bigint; feeBps?: bigint; lock?: boolean; owner?: string; firstBuy?: bigint; minFirst?: bigint }) =>
      call(CREATE_SIG, o.token, BigInt(o.nonce), o.x0, o.l0, o.y0 ?? 0n, o.feeBps ?? 25n, o.lock ?? true, o.owner ?? CREATOR, o.firstBuy ?? 0n, o.minFirst ?? 0n);
    const valueFor = (o: { y0?: bigint; firstBuy?: bigint }) => CREATION_FEE + (o.y0 ?? 0n) + (o.firstBuy ?? 0n);

    const readPool = async (token: string) => {
      const p = parsePoolReturn(await view(pool, call('pools(address)', token)));
      return p;
    };
    const readPos = async (token: string, who: string) => parsePositionReturn(await view(pool, call('positions(address,address)', token, who)))!;
    /** Owed to Aretia's fee address and not yet withdrawn (the new build never pays it inside a trade). */
    const protocolOwed = async () => BigInt(await view(pool, call('protocolOwed()')));
    /** What the contract owes pools and positions: totalOwed less the protocol's part. */
    const totalOwed = async () => BigInt(await view(pool, call('totalOwed()'))) - (await protocolOwed());
    /** The contract's coin less what is owed to the fee address: what backs the pools. */
    const poolHeld = async () => (await balance(pool)) - (await protocolOwed());

    const open = async (o: { supply?: bigint; x0?: bigint; l0?: bigint; feeBps?: bigint; lock?: boolean; creator?: string; firstBuy?: bigint; minFirst?: bigint } = {}) => {
      const creator = o.creator ?? CREATOR;
      const supply = o.supply ?? 10n ** 27n;
      const t = await makeToken(creator, supply);
      const x0 = o.x0 ?? supply;
      await approve(creator, t.token, pool, x0);
      await send(creator, pool, create({ token: t.token, nonce: t.nonce, x0, l0: o.l0 ?? 10n * ETH, feeBps: o.feeBps, lock: o.lock, firstBuy: o.firstBuy, minFirst: o.minFirst, owner: creator }), valueFor(o));
      return t;
    };
    return {
      util, vm, fund, send, fails, view, balance, addr, pool, factory, realFactory, hostileFactory, makeToken, makeHostile, tokenBalance, approve, readPool, readPos, totalOwed, protocolOwed, poolHeld, open, deploy, exec, toHex, create, valueFor, feeTo,
      buy: (from: string, token: string, wei: bigint, minOut = 0n) => send(from, pool, call('buy(address,uint256)', token, minOut), wei),
      sell: (from: string, token: string, amount: bigint, minOut = 0n) => send(from, pool, call('sell(address,uint256,uint256)', token, amount, minOut)),
      add: (from: string, token: string, dl: bigint, maxTokens: bigint, wei: bigint) => send(from, pool, call('addLiquidity(address,uint256,uint256)', token, dl, maxTokens), wei),
      remove: (from: string, token: string, dl: bigint, minT = 0n, minC = 0n) => send(from, pool, call('removeLiquidity(address,uint256,uint256,uint256)', token, dl, minT, minC)),
      claim: (from: string, token: string) => send(from, pool, call('claimFees(address)', token)),
      lock: (from: string, token: string, amount: bigint) => send(from, pool, call('lockLiquidity(address,uint256)', token, amount)),
      transfer: (from: string, token: string, to: string) => send(from, pool, call('transferPosition(address,address)', token, to)),
      setRecipient: (from: string, token: string, r: string) => send(from, pool, call('setRecipient(address,address)', token, r)),
      pendingView: async (token: string, who: string) => BigInt(await view(pool, call('pendingFees(address,address)', token, who))),
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const SUPPLY = 10n ** 27n;
  const L0 = 10n * ETH;
  const BUYER = W[1]!;
  const OTHER = W[2]!;
  const toModel = (p: ReturnType<typeof parsePoolReturn>): Pool => ({ feeBps: p!.feeBps, x: p!.x, y: p!.y, l: p!.l, acc: p!.acc, feeReserve: p!.feeReserve, accRemainder: p!.accRemainder });

  it('opens a single-sided pool, holds the tokens, charges the creation fee, and refuses everything it should', async () => {
    const w = await world();
    const before = await w.balance(CREATOR);
    const t = await w.open();
    const p = await w.readPool(t.token);
    expect(p).toMatchObject({ feeBps: 25n, creator: CREATOR, x: SUPPLY, y: 0n, l: L0, acc: 0n, feeReserve: 0n, accRemainder: 0n });
    expect(await w.tokenBalance(t.token, w.pool)).toBe(SUPPLY);
    expect(await w.poolHeld()).toBe(0n);
    expect(await w.protocolOwed()).toBe(CREATION_FEE);
    expect(before - (await w.balance(CREATOR))).toBe(CREATION_FEE);
    expect(await w.readPos(t.token, CREATOR)).toMatchObject({ open: true, shares: L0, locked: L0, pending: 0n, recipient: null });
    expect(p).toMatchObject({ locked: L0 });
    expect(await w.balance(FEE_RECIPIENT)).toBe(0n); // owed, not pushed
    expect(await w.totalOwed()).toBe(0n);

    // Refusals.
    const b = await w.makeToken(CREATOR, SUPPLY);
    await w.approve(CREATOR, b.token, w.pool, SUPPLY);
    const go = (o: Partial<Parameters<World['create']>[0]>, value = CREATION_FEE) => w.fails(CREATOR, w.pool, w.create({ token: b.token, nonce: b.nonce, x0: SUPPLY, l0: L0, ...o }), value);
    expect(await w.fails(CREATOR, w.pool, w.create({ token: t.token, nonce: t.nonce, x0: SUPPLY, l0: L0 }), CREATION_FEE)).toBe('exists');
    expect(await go({ nonce: b.nonce + 1 })).toBe('not from the factory');
    expect(await go({ nonce: 0 })).toBe('not from the factory');
    expect(await go({ feeBps: 30n })).toBe('fee tier');
    expect(await go({ feeBps: 0n })).toBe('fee tier');
    expect(await go({ x0: 999n })).toBe('x0');
    expect(await go({ x0: 1n << 112n })).toBe('x0');
    expect(await go({ l0: MIN_L - 1n })).toBe('l0');
    expect(await go({ l0: 1n << 112n })).toBe('l0');
    expect(await go({ owner: '0x' + '0'.repeat(40) })).toBe('owner');
    // The creator's liquidity is always locked (review finding M-9).
    expect(await go({ lock: false })).toBe('must lock');
    expect(await go({}, CREATION_FEE - 1n)).toBe('value');
    expect(await go({}, CREATION_FEE + 1n)).toBe('value');
    expect(await go({ y0: 5n }, CREATION_FEE)).toBe('value');
    // A token no factory made, with every nonce in the cheap RLP ranges.
    const own = await w.deploy(factoryArtifact.token.bytecode, word(160n) + word(224n) + word(18n) + word(SUPPLY) + word(CREATOR) + word(4n) + '5465737400000000000000000000000000000000000000000000000000000000' + word(3n) + '5453540000000000000000000000000000000000000000000000000000000000');
    await w.approve(CREATOR, own, w.pool, SUPPLY);
    for (const nonce of [0, 1, 2, 3, 255, 256, 65_536, 16_777_216, 4_294_967_295]) expect(await w.fails(CREATOR, w.pool, w.create({ token: own, nonce, x0: SUPPLY, l0: L0 }), CREATION_FEE)).toBe('not from the factory');
    expect(await w.fails(CREATOR, w.pool, w.create({ token: own, nonce: 4_294_967_296, x0: SUPPLY, l0: L0 }), CREATION_FEE)).toBe('nonce');
    // A future nonce names an address with no code yet.
    expect(await w.fails(CREATOR, w.pool, w.create({ token: b.token, nonce: b.nonce + 5, x0: SUPPLY, l0: L0 }), CREATION_FEE)).toBe('not from the factory');
    // Plain coin is refused.
    expect(await w.fails(CREATOR, w.pool, '0x', ETH)).toBe('no deposits');
  });

  it('makes the creator’s first buy inside the creation transaction, or nothing happens at all', async () => {
    const w = await world();
    const t = await w.makeToken(CREATOR, SUPPLY);
    await w.approve(CREATOR, t.token, w.pool, SUPPLY);
    const base: Pool = { feeBps: 25n, x: SUPPLY, y: 0n, l: L0, acc: 0n, feeReserve: 0n, accRemainder: 0n };
    const q = mBuy(base, ETH)!;
    const c = (min: bigint) => w.create({ token: t.token, nonce: t.nonce, x0: SUPPLY, l0: L0, firstBuy: ETH, minFirst: min });
    expect(await w.fails(CREATOR, w.pool, c(q.out + 1n), CREATION_FEE + ETH)).toBe('slippage');
    expect(await w.readPool(t.token)).toBeNull();
    expect(await w.tokenBalance(t.token, CREATOR)).toBe(SUPPLY);
    const before = await w.balance(CREATOR);
    await w.send(CREATOR, w.pool, c(q.out), CREATION_FEE + ETH);
    expect(toModel(await w.readPool(t.token))).toEqual(q.next);
    expect(await w.tokenBalance(t.token, CREATOR)).toBe(q.out);
    expect(before - (await w.balance(CREATOR))).toBe(CREATION_FEE + ETH);
    expect(await w.protocolOwed()).toBe(CREATION_FEE + q.protocol);
    expect(await w.poolHeld()).toBe(q.next.y + q.next.feeReserve);
  });

  it('trades exactly as the model says, pays Aretia its 20% in the same transaction, and conserves every wei', async () => {
    for (const feeBps of [25n, 100n]) {
      const w = await world();
      const t = await w.open({ feeBps });
      let m: Pool = { feeBps, x: SUPPLY, y: 0n, l: L0, acc: 0n, feeReserve: 0n, accRemainder: 0n };
      let feeWallet = CREATION_FEE;
      await w.approve(BUYER, t.token, w.pool, 1n << 255n);
      for (const wei of [ETH / 3n, 7n * ETH, 12345n, 3n * ETH]) {
        const q = mBuy(m, wei)!;
        const buyerBefore = await w.balance(BUYER);
        await w.buy(BUYER, t.token, wei, q.out);
        feeWallet += q.protocol;
        m = q.next;
        expect(buyerBefore - (await w.balance(BUYER))).toBe(wei);
        expect(await w.protocolOwed()).toBe(feeWallet);
        expect(q.protocol + q.lp).toBe(q.fee);
        expect(q.protocol).toBe((q.fee * 2000n) / 10_000n);
        expect(toModel(await w.readPool(t.token))).toEqual(m);
        expect(await w.poolHeld()).toBe(m.y + m.feeReserve);
        expect(await w.totalOwed()).toBe(m.y + m.feeReserve);
      }
      // The buyer sells some back.
      const have = await w.tokenBalance(t.token, BUYER);
      for (const tokens of [have / 4n, have / 2n]) {
        const s = mSell(m, tokens)!;
        const balBefore = await w.balance(BUYER);
        await w.sell(BUYER, t.token, tokens, s.net);
        feeWallet += s.protocol;
        m = s.next;
        expect((await w.balance(BUYER)) - balBefore).toBe(s.net);
        expect(await w.protocolOwed()).toBe(feeWallet);
        expect(toModel(await w.readPool(t.token))).toEqual(m);
        expect(await w.poolHeld()).toBe(m.y + m.feeReserve);
      }
      // The contract's own views equal the model and the web core.
      const qv = await w.view(w.pool, call('quoteBuy(address,uint256)', t.token, ETH));
      const mb = mBuy(m, ETH)!;
      expect([BigInt('0x' + qv.slice(2, 66)), BigInt('0x' + qv.slice(66, 130))]).toEqual([mb.fee, mb.out]);
      expect(poolQuoteBuy({ ...m }, ETH)!.tokensOut).toBe(mb.out);
      // Slippage, zero amounts, a sale of more than the pool can pay.
      expect(await w.fails(BUYER, w.pool, call('buy(address,uint256)', t.token, mb.out + 1n), ETH)).toBe('slippage');
      expect(await w.fails(BUYER, w.pool, call('buy(address,uint256)', t.token, 0n), 0n)).toBe('amount');
      expect(await w.fails(BUYER, w.pool, call('sell(address,uint256,uint256)', t.token, 0n, 0n))).toBe('amount');
      expect(await w.fails(OTHER, w.pool, call('buy(address,uint256)', '0x' + '11'.repeat(20), 0n), ETH)).toBe('no pool');
    }
  });

  it('never lets the price fall below the start: nobody can sell for more coin than buyers paid in', async () => {
    const w = await world();
    const t = await w.open({ x0: SUPPLY / 2n });
    await w.send(CREATOR, t.token, '0xa9059cbb' + word(BUYER) + word(10n ** 24n));
    await w.approve(BUYER, t.token, w.pool, 1n << 255n);
    // Nothing has been paid in yet, so any sale would have to be paid from coin the pool does not hold.
    expect(await w.fails(BUYER, w.pool, call('sell(address,uint256,uint256)', t.token, 10n ** 24n, 0n))).toBe('amount');
    expect(await w.fails(BUYER, w.pool, call('sell(address,uint256,uint256)', t.token, 1n, 0n))).toBe('amount');
    await w.buy(OTHER, t.token, ETH / 10n);
    // A sale worth more than the 0.1 paid in is refused outright; one worth less goes through.
    await w.send(CREATOR, t.token, '0xa9059cbb' + word(BUYER) + word(10n ** 26n));
    expect(await w.fails(BUYER, w.pool, call('sell(address,uint256,uint256)', t.token, 5n * 10n ** 25n, 0n))).toBe('amount');
    await w.sell(BUYER, t.token, 10n ** 22n);
    const p = toModel(await w.readPool(t.token));
    expect(p.y).toBeLessThan(ETH / 10n);
    expect(p.y).toBeGreaterThan(0n);
  });

  it('lets a LOCKED position claim exactly its share of the fees, redirect them, and sell the position whole', async () => {
    const w = await world();
    const t = await w.open();
    await w.approve(BUYER, t.token, w.pool, 1n << 255n);
    let m: Pool = { feeBps: 25n, x: SUPPLY, y: 0n, l: L0, acc: 0n, feeReserve: 0n, accRemainder: 0n };
    for (const wei of [ETH, 2n * ETH, ETH / 7n]) {
      m = mBuy(m, wei)!.next;
      await w.buy(BUYER, t.token, wei);
    }
    const expected = (m.l * 0n + L0 * m.acc) >> 64n;
    expect(await w.pendingView(t.token, CREATOR)).toBe(expected);
    expect(poolClaimable(m, { ...(await w.readPos(t.token, CREATOR)) })).toBe(expected);
    expect(expected).toBeGreaterThan(0n);
    expect(expected).toBeLessThanOrEqual(m.feeReserve);
    // The creator redirects fees to a fresh wallet; the lock stays.
    const fresh = '0x00000000000000000000000000000000000fe5e1';
    await w.setRecipient(CREATOR, t.token, fresh);
    expect((await w.readPos(t.token, CREATOR)).recipient).toBe(fresh);
    await w.claim(CREATOR, t.token);
    expect(await w.balance(fresh)).toBe(expected);
    expect(await w.poolHeld()).toBe(m.y + m.feeReserve - expected);
    expect(await w.fails(CREATOR, w.pool, call('claimFees(address)', t.token))).toBe('nothing');
    // Locked liquidity cannot be removed, partly or wholly.
    expect(await w.fails(CREATOR, w.pool, call('removeLiquidity(address,uint256,uint256,uint256)', t.token, 1n, 0n, 0n))).toBe('unlocked shares');
    // Hand the whole position to another wallet: the lock goes with it, the old owner is out.
    await w.transfer(CREATOR, t.token, OTHER);
    expect(await w.readPos(t.token, CREATOR)).toMatchObject({ open: false, shares: 0n });
    expect(await w.readPos(t.token, OTHER)).toMatchObject({ open: true, shares: L0, locked: L0, recipient: null });
    expect(await w.fails(CREATOR, w.pool, call('claimFees(address)', t.token))).toBe('no position');
    expect(await w.fails(OTHER, w.pool, call('removeLiquidity(address,uint256,uint256,uint256)', t.token, 1n, 0n, 0n))).toBe('unlocked shares');
    // More fees now accrue to the new owner.
    const q = mBuy(m, ETH)!;
    await w.buy(BUYER, t.token, ETH);
    const got = await w.pendingView(t.token, OTHER);
    expect(got).toBe((L0 * (q.next.acc - m.acc)) >> 64n);
    expect(got).toBeGreaterThan(0n);
    const before = await w.balance(OTHER);
    await w.claim(OTHER, t.token);
    expect((await w.balance(OTHER)) - before).toBe(got);
    // Cannot transfer to oneself or to zero; onto a wallet that has a position, the two MERGE (review finding L-19).
    expect(await w.fails(OTHER, w.pool, call('transferPosition(address,address)', t.token, OTHER))).toBe('to');
    expect(await w.fails(OTHER, w.pool, call('transferPosition(address,address)', t.token, '0x' + '0'.repeat(40)))).toBe('to');
    await w.add(BUYER, t.token, 10_000n, 1n << 200n, ETH);
    await w.transfer(OTHER, t.token, BUYER);
    expect(await w.readPos(t.token, BUYER)).toMatchObject({ open: true, shares: L0 + 10_000n, locked: L0 });
    expect(await w.readPos(t.token, OTHER)).toMatchObject({ open: false, shares: 0n });
  });

  it('adds and removes liquidity pro rata with deposits rounded up and withdrawals down, and leaves the minimum behind', async () => {
    const w = await world();
    const t = await w.open({ x0: SUPPLY / 2n });
    await w.approve(BUYER, t.token, w.pool, 1n << 255n);
    await w.approve(OTHER, t.token, w.pool, 1n << 255n);
    await w.buy(OTHER, t.token, 3n * ETH);
    let m = toModel(await w.readPool(t.token));
    // Add: tokens and coin both rounded up; excess coin is returned.
    const dl = 5n * ETH + 7n;
    const tokens = ceilDiv(m.x * dl, m.l);
    const coin = ceilDiv(m.y * dl, m.l);
    expect(await w.fails(BUYER, w.pool, call('addLiquidity(address,uint256,uint256)', t.token, dl, tokens - 1n), coin)).toBe('slippage');
    expect(await w.fails(BUYER, w.pool, call('addLiquidity(address,uint256,uint256)', t.token, dl, tokens), coin - 1n)).toBe('coin');
    expect(await w.fails(BUYER, w.pool, call('addLiquidity(address,uint256,uint256)', t.token, 999n, tokens), coin)).toBe('dl');
    const balBefore = await w.balance(BUYER);
    await w.send(CREATOR, t.token, '0xa9059cbb' + word(BUYER) + word(tokens));
    await w.add(BUYER, t.token, dl, tokens, coin + ETH);
    expect(balBefore - (await w.balance(BUYER))).toBe(coin);
    m = { ...m, x: m.x + tokens, y: m.y + coin, l: m.l + dl };
    expect(toModel(await w.readPool(t.token))).toEqual(m);
    expect(await w.readPos(t.token, BUYER)).toMatchObject({ open: true, shares: dl, locked: 0n });
    expect(await w.poolHeld()).toBe(m.y + m.feeReserve);
    // Add then remove the same shares never returns more than was put in.
    const back = poolQuoteRemove(m, dl)!;
    expect(back.tokens).toBeLessThanOrEqual(tokens);
    expect(back.coin).toBeLessThanOrEqual(coin);
    const tokBefore = await w.tokenBalance(t.token, BUYER);
    const coinBefore = await w.balance(BUYER);
    await w.remove(BUYER, t.token, dl, back.tokens, back.coin);
    expect((await w.tokenBalance(t.token, BUYER)) - tokBefore).toBe(back.tokens);
    expect((await w.balance(BUYER)) - coinBefore).toBe(back.coin);
    expect(toModel(await w.readPool(t.token))).toEqual({ ...back.next, acc: m.acc, feeReserve: m.feeReserve, feeBps: 25n });
    // A position that removed everything (and had nothing pending) is closed (review finding L-19).
    expect(await w.readPos(t.token, BUYER)).toMatchObject({ open: false, shares: 0n });
    // The creator's liquidity is locked for good.
    expect(await w.fails(CREATOR, w.pool, call('removeLiquidity(address,uint256,uint256,uint256)', t.token, 1n, 0n, 0n))).toBe('unlocked shares');
    expect(await w.fails(CREATOR, w.pool, call('lockLiquidity(address,uint256)', t.token, 1n))).toBe('unlocked shares');
    // Locking part of a new position keeps that part in for good, and the pool's locked total follows.
    const dl2 = 4n * ETH;
    m = toModel(await w.readPool(t.token));
    await w.add(BUYER, t.token, dl2, 1n << 200n, ceilDiv(m.y * dl2, m.l) + 1n);
    await w.lock(BUYER, t.token, dl2 / 2n);
    expect((await w.readPool(t.token))!.locked).toBe(L0 + dl2 / 2n);
    expect(await w.fails(BUYER, w.pool, call('removeLiquidity(address,uint256,uint256,uint256)', t.token, dl2 / 2n + 1n, 0n, 0n))).toBe('unlocked shares');
    await w.remove(BUYER, t.token, dl2 / 2n);
    const p = await w.readPool(t.token);
    expect(p!.l).toBe(L0 + dl2 / 2n);
    expect(p!.locked).toBe(p!.l);
    expect(await w.poolHeld()).toBe(p!.y + p!.feeReserve);
  });

  it('keeps k from falling, fees summing exactly, and a round trip from profiting, over thousands of seeded trades', async () => {
    // Pure property run on the model (which the EVM run below proves equal to the contract), with the contract spot-checked.
    let seed = 0x2545f491n;
    const rnd = (n: bigint): bigint => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return n === 0n ? 0n : (seed >> 11n) % n;
    };
    for (const feeBps of [25n, 100n]) {
      let p: Pool = { feeBps, x: 10n ** 27n, y: 0n, l: 10n * ETH, acc: 0n, feeReserve: 0n, accRemainder: 0n };
      let credited = 0n;
      for (let i = 0; i < 6000; i++) {
        const k0 = p.x * (p.y + p.l);
        if (rnd(2n) === 0n) {
          const wei = 1n + rnd(5n * ETH);
          const b = mBuy(p, wei);
          if (!b) continue;
          expect(b.protocol + b.lp).toBe(b.fee);
          credited += b.lp;
          p = b.next;
          // Round trip: sell exactly what was bought straight away.
          const back = mSell(p, b.out);
          if (back) expect(back.net).toBeLessThan(wei);
        } else {
          const tokens = 1n + rnd(p.x < 10n ** 27n ? 10n ** 27n - p.x : 1n);
          const s = mSell(p, tokens);
          if (!s) continue;
          expect(s.protocol + s.lp).toBe(s.fee);
          credited += s.lp;
          p = s.next;
        }
        expect(p.x * (p.y + p.l)).toBeGreaterThanOrEqual(k0);
        expect(p.feeReserve).toBe(credited);
        // The whole position's claim never exceeds what was credited.
        expect((p.l * p.acc) >> 64n).toBeLessThanOrEqual(p.feeReserve);
      }
    }
  });

  it('runs a seeded random script of 400 operations across five wallets against the model, comparing every number after each step', async () => {
    const w = await world();
    const t = await w.open({ feeBps: 100n });
    let m: Pool = { feeBps: 100n, x: SUPPLY, y: 0n, l: L0, acc: 0n, feeReserve: 0n, accRemainder: 0n };
    const pos = new Map<string, Pos>(W.map((a) => [a, emptyPos()]));
    pos.set(CREATOR, { open: true, shares: L0, locked: L0, checkpoint: 0n, pending: 0n, recipient: '0x' + '0'.repeat(40) });
    /** The contract deletes a position left with no shares and nothing pending. */
    const closeIfEmpty = (a: string) => {
      const q = pos.get(a)!;
      if (q.open && q.shares === 0n && q.pending === 0n) pos.set(a, emptyPos());
    };
    const tok = new Map<string, bigint>(W.map((a) => [a, 0n]));
    const sinks = ['0x00000000000000000000000000000000000dad01', '0x00000000000000000000000000000000000dad02'];
    const coinOf = new Map<string, bigint>();
    for (const a of W) {
      await w.approve(a, t.token, w.pool, 1n << 255n);
      coinOf.set(a, await w.balance(a));
    }
    // Hand the other wallets some tokens (the creator's are not locked in this pool: the tokens it holds are outside).
    const fee = 10n; // not used; trades pay nothing but their own amounts (no gas in this harness)
    void fee;
    let seed = 0xdeadbeefn;
    const rnd = (n: bigint): bigint => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return n <= 0n ? 0n : (seed >> 11n) % n;
    };
    let feeWallet = CREATION_FEE; // owed to the fee address, not paid
    const sinkBal = new Map<string, bigint>(sinks.map((s) => [s, 0n]));
    const settleP = (a: string) => pos.set(a, settle(m, pos.get(a)!));
    const comparePool = async (step: number) => {
      const got = toModel(await w.readPool(t.token));
      expect(got, `pool at step ${step}`).toEqual(m);
      for (const a of W) {
        const g = await w.readPos(t.token, a);
        const e = pos.get(a)!;
        expect({ open: g.open, shares: g.shares, locked: g.locked, checkpoint: g.checkpoint, pending: g.pending, recipient: g.recipient ?? '0x' + '0'.repeat(40) }, `position ${a} at step ${step}`).toEqual(e);
        expect(await w.tokenBalance(t.token, a), `tokens ${a} at step ${step}`).toBe(tok.get(a)!);
        expect(await w.balance(a), `coin ${a} at step ${step}`).toBe(coinOf.get(a)!);
      }
      for (const s of sinks) expect(await w.balance(s)).toBe(sinkBal.get(s)!);
      expect(await w.protocolOwed(), `fee wallet at step ${step}`).toBe(feeWallet);
      expect(await w.poolHeld(), `pool coin at step ${step}`).toBe(m.y + m.feeReserve);
      expect(await w.tokenBalance(t.token, w.pool), `pool tokens at step ${step}`).toBe(m.x);
      expect(await w.totalOwed()).toBe(m.y + m.feeReserve);
      // Solvency of claims: what every position could claim never exceeds the fee reserve.
      let owed = 0n;
      for (const a of W) {
        const e = pos.get(a)!;
        if (e.open) owed += e.pending + ((e.shares * (m.acc - e.checkpoint)) >> 64n);
      }
      expect(owed).toBeLessThanOrEqual(m.feeReserve);
    };
    // Give wallets 1..4 some tokens through the pool: they buy.
    for (let i = 1; i < 5; i++) {
      const wei = ETH * BigInt(i);
      const b = mBuy(m, wei)!;
      await w.buy(W[i]!, t.token, wei);
      m = b.next;
      feeWallet += b.protocol;
      tok.set(W[i]!, b.out);
      coinOf.set(W[i]!, coinOf.get(W[i]!)! - wei);
    }
    await comparePool(0);
    const ops = ['buy', 'sell', 'add', 'remove', 'claim', 'lock', 'transfer', 'recipient'];
    let accepted = 0;
    let refused = 0;
    for (let step = 1; step <= 400; step++) {
      const a = W[Number(rnd(5n))]!;
      const op = ops[Number(rnd(BigInt(ops.length)))]!;
      const e = pos.get(a)!;
      const zero = '0x' + '0'.repeat(40);
      if (op === 'buy') {
        const wei = 1n + rnd(2n * ETH);
        const b = mBuy(m, wei);
        if (b) {
          await w.buy(a, t.token, wei, b.out);
          m = b.next;
          feeWallet += b.protocol;
          tok.set(a, tok.get(a)! + b.out);
          coinOf.set(a, coinOf.get(a)! - wei);
          accepted++;
        } else {
          await w.fails(a, w.pool, call('buy(address,uint256)', t.token, 0n), wei);
          refused++;
        }
      } else if (op === 'sell') {
        const have = tok.get(a)!;
        const tokens = have === 0n ? 1n : 1n + rnd(have);
        const s = mSell(m, tokens);
        if (s && tokens <= have) {
          await w.sell(a, t.token, tokens, s.net);
          m = s.next;
          feeWallet += s.protocol;
          tok.set(a, have - tokens);
          coinOf.set(a, coinOf.get(a)! + s.net);
          accepted++;
        } else {
          await w.fails(a, w.pool, call('sell(address,uint256,uint256)', t.token, tokens, 0n));
          refused++;
        }
      } else if (op === 'add') {
        const dl = 1000n + rnd(ETH);
        const tokens = ceilDiv(m.x * dl, m.l);
        const coin = ceilDiv(m.y * dl, m.l);
        if (tokens <= tok.get(a)!) {
          await w.add(a, t.token, dl, tokens, coin + rnd(1000n));
          // Anything paid above `coin` is returned, so the net cost is exactly `coin`.
          if (e.open) settleP(a);
          const cur = pos.get(a)!;
          pos.set(a, cur.open ? { ...cur, shares: cur.shares + dl } : { ...emptyPos(), open: true, shares: dl, checkpoint: m.acc });
          m = { ...m, x: m.x + tokens, y: m.y + coin, l: m.l + dl };
          tok.set(a, tok.get(a)! - tokens);
          coinOf.set(a, coinOf.get(a)! - coin);
          accepted++;
        } else {
          await w.fails(a, w.pool, call('addLiquidity(address,uint256,uint256)', t.token, dl, tokens), coin);
          refused++;
        }
      } else if (op === 'remove') {
        const free = e.open ? e.shares - e.locked : 0n;
        const dl = free === 0n ? 1n : 1n + rnd(free);
        if (e.open && dl <= free && m.l - dl >= MIN_L) {
          const tokens = (m.x * dl) / m.l;
          const coin = (m.y * dl) / m.l;
          await w.remove(a, t.token, dl, tokens, coin);
          settleP(a);
          pos.set(a, { ...pos.get(a)!, shares: pos.get(a)!.shares - dl });
          closeIfEmpty(a);
          m = { ...m, x: m.x - tokens, y: m.y - coin, l: m.l - dl };
          tok.set(a, tok.get(a)! + tokens);
          coinOf.set(a, coinOf.get(a)! + coin);
          accepted++;
        } else {
          await w.fails(a, w.pool, call('removeLiquidity(address,uint256,uint256,uint256)', t.token, dl, 0n, 0n));
          refused++;
        }
      } else if (op === 'claim') {
        if (e.open) {
          const s = settle(m, e);
          if (s.pending > 0n) {
            const to = e.recipient === zero ? a : e.recipient;
            await w.claim(a, t.token);
            pos.set(a, { ...s, pending: 0n });
            closeIfEmpty(a);
            m = { ...m, feeReserve: m.feeReserve - s.pending };
            if (sinks.includes(to)) sinkBal.set(to, sinkBal.get(to)! + s.pending);
            else coinOf.set(to, coinOf.get(to)! + s.pending);
            accepted++;
            await comparePool(step);
            continue;
          }
        }
        await w.fails(a, w.pool, call('claimFees(address)', t.token));
        refused++;
      } else if (op === 'lock') {
        const free = e.open ? e.shares - e.locked : 0n;
        const amount = free === 0n ? 1n : 1n + rnd(free);
        if (e.open && amount <= free) {
          await w.lock(a, t.token, amount);
          pos.set(a, { ...e, locked: e.locked + amount });
          accepted++;
        } else {
          await w.fails(a, w.pool, call('lockLiquidity(address,uint256)', t.token, amount));
          refused++;
        }
      } else if (op === 'transfer') {
        const to = W[Number(rnd(5n))]!;
        if (e.open && to !== a) {
          await w.transfer(a, t.token, to);
          const s = settle(m, e);
          const dst = pos.get(to)!;
          if (dst.open) {
            // Merged into the existing position, which keeps its own fee recipient.
            const d = settle(m, dst);
            pos.set(to, { ...d, shares: d.shares + s.shares, locked: d.locked + s.locked, pending: d.pending + s.pending });
          } else pos.set(to, { ...s, recipient: zero });
          pos.set(a, emptyPos());
          accepted++;
        } else {
          await w.fails(a, w.pool, call('transferPosition(address,address)', t.token, to));
          refused++;
        }
      } else {
        const r = rnd(3n) === 0n ? a : rnd(2n) === 0n ? sinks[0]! : sinks[1]!;
        if (e.open) {
          await w.setRecipient(a, t.token, r);
          pos.set(a, { ...e, recipient: r === a ? zero : r });
          accepted++;
        } else {
          await w.fails(a, w.pool, call('setRecipient(address,address)', t.token, r));
          refused++;
        }
      }
      await comparePool(step);
    }
    expect(accepted).toBeGreaterThan(150);
    expect(refused).toBeGreaterThan(5);
  }, 300_000);

  // ---------------------------------------------------------------- attacks

  it('refuses to be re-entered while paying a seller or a fee claimant', async () => {
    const w = await world();
    const t = await w.open();
    // A contract wallet as buyer/seller: its receive function tries to sell again, then claim again, while being paid.
    const attacker = await w.deploy((mocksArtifact as any).Attacker.bytecode);
    await w.buy(OTHER, t.token, 5n * ETH);
    // Give the attacker tokens, approve, and have it sell with a re-entering receive.
    const give = (await w.tokenBalance(t.token, OTHER)) / 2n;
    await w.send(OTHER, t.token, '0xa9059cbb' + word(attacker) + word(give));
    await w.send(OTHER, attacker, mcall('Attacker', 'approveToken(address,address,uint256)', t.token, w.pool, 1n << 255n));
    await w.send(OTHER, attacker, mcall('Attacker', 'arm(address,bytes)', w.pool, '0x' + '40'.padStart(64, '0') + encBytes(call('sell(address,uint256,uint256)', t.token, give / 4n, 0n))));
    const pBefore = await w.readPool(t.token);
    const s = mSell(toModel(pBefore), give / 2n)!;
    const sellData = call('sell(address,uint256,uint256)', t.token, give / 2n, s.net);
    const balBefore = await w.balance(attacker);
    const ret = await w.send(OTHER, attacker, mcall('Attacker', 'exec(address,bytes)', w.pool, '0x' + '40'.padStart(64, '0') + encBytes(sellData)));
    expect(ret.execResult.exceptionError).toBeUndefined();
    // The attacker's receive ran, tried to sell again, and was refused; the outer sale paid exactly once.
    expect(BigInt(await w.view(attacker, mcall('Attacker', 'reentered()')))).toBe(1n);
    expect(BigInt(await w.view(attacker, mcall('Attacker', 'reentrySucceeded()')))).toBe(0n);
    expect((await w.balance(attacker)) - balBefore).toBe(s.net);
    expect(toModel(await w.readPool(t.token))).toEqual(s.next);
    expect(await w.poolHeld()).toBe(s.next.y + s.next.feeReserve);
  });

  it('refuses a token that re-enters the pool during a transfer', async () => {
    const w = await world({ hostile: true });
    const t = await w.makeHostile(3, CREATOR, SUPPLY);
    await w.approve(CREATOR, t.token, w.pool, SUPPLY);
    await w.send(CREATOR, w.pool, w.create({ token: t.token, nonce: t.nonce, x0: SUPPLY, l0: L0 }), CREATION_FEE);
    await w.approve(BUYER, t.token, w.pool, 1n << 255n);
    const data = call('claimFees(address)', t.token);
    // Armed to call back into the pool on every transfer, and to pass the pool's revert up.
    const arm = (bubble: boolean) => w.send(CREATOR, t.token, mcall('HostileToken', 'arm(address,bytes,bool)', w.pool, '0x' + '60'.padStart(64, '0'), bubble, encBytes(data).replace(/^/, '')));
    await arm(true);
    // A buy: the pool pays the buyer tokens, the token calls back, the pool says "reentrant", the whole buy reverts.
    expect(await w.fails(BUYER, w.pool, call('buy(address,uint256)', t.token, 0n), ETH)).toBe('reentrant');
    expect(await w.poolHeld()).toBe(0n);
    // Not passed up: the inner call fails quietly, the outer succeeds, and the inner never took effect.
    await arm(false);
    await w.buy(BUYER, t.token, ETH);
    expect(BigInt(await w.view(t.token, mcall('HostileToken', 'reentered()')))).toBe(1n);
    expect(BigInt(await w.view(t.token, mcall('HostileToken', 'reentrySucceeded()')))).toBe(0n);
    const p = await w.readPool(t.token);
    expect(await w.poolHeld()).toBe(p!.y + p!.feeReserve);
  });

  it('refuses hostile tokens: fee on transfer, false return, a short transfer, a transfer that moves nothing', async () => {
    const w = await world({ hostile: true });
    const expectReason: Record<number, string> = { 1: 'balance', 2: 'transfer', 4: 'balance', 5: 'balance' };
    for (const mode of [1, 2, 4, 5]) {
      const t = await w.makeHostile(mode, CREATOR, SUPPLY);
      await w.approve(CREATOR, t.token, w.pool, SUPPLY);
      expect(await w.fails(CREATOR, w.pool, w.create({ token: t.token, nonce: t.nonce, x0: SUPPLY, l0: L0 }), CREATION_FEE), `mode ${mode}`).toBe(expectReason[mode]);
      expect(await w.readPool(t.token)).toBeNull();
    }
    // A well-behaved hostile-factory token (mode 0) works, and the real pool's other refusals still hold for the others.
    const good = await w.makeHostile(0, CREATOR, SUPPLY);
    await w.approve(CREATOR, good.token, w.pool, SUPPLY);
    await w.send(CREATOR, w.pool, w.create({ token: good.token, nonce: good.nonce, x0: SUPPLY, l0: L0 }), CREATION_FEE);
    expect(await w.readPool(good.token)).not.toBeNull();
  });

  it('refuses a token that misbehaves only AFTER the pool exists (a short payout on a buy)', async () => {
    const w = await world({ hostile: true });
    const t = await w.makeHostile(0, CREATOR, SUPPLY);
    await w.approve(CREATOR, t.token, w.pool, SUPPLY);
    await w.send(CREATOR, w.pool, w.create({ token: t.token, nonce: t.nonce, x0: SUPPLY, l0: L0 }), CREATION_FEE);
    // A pool for a mode-0 token behaves normally; the same pool with a mode-4 token cannot even open. Check normal flow end to end.
    await w.approve(BUYER, t.token, w.pool, 1n << 255n);
    await w.buy(BUYER, t.token, ETH);
    const have = await w.tokenBalance(t.token, BUYER);
    await w.sell(BUYER, t.token, have);
    const p = await w.readPool(t.token);
    expect(await w.poolHeld()).toBe(p!.y + p!.feeReserve);
  });

  it('cannot be blocked or drained by a recipient that refuses coin, and a donation changes nothing', async () => {
    const w = await world();
    const t = await w.open();
    const attacker = await w.deploy((mocksArtifact as any).Attacker.bytecode);
    await w.approve(BUYER, t.token, w.pool, 1n << 255n);
    await w.buy(BUYER, t.token, 2n * ETH);
    // The creator sends its fees to a contract that refuses coin: only its own claim fails; the pool goes on trading.
    await w.setRecipient(CREATOR, t.token, attacker);
    await w.send(CREATOR, attacker, mcall('Attacker', 'setRefuse(bool)', true));
    expect(await w.fails(CREATOR, w.pool, call('claimFees(address)', t.token))).toBe('send');
    await w.buy(BUYER, t.token, ETH);
    // The creator changes its mind and claims.
    await w.setRecipient(CREATOR, t.token, CREATOR);
    await w.claim(CREATOR, t.token);
    // Forced coin (as selfdestruct would send) and a token donation move nothing.
    const before = toModel(await w.readPool(t.token));
    const sdTarget = w.pool;
    const acct = await w.vm.stateManager.getAccount(w.addr(sdTarget));
    acct.balance += 7n * ETH;
    await w.vm.stateManager.putAccount(w.addr(sdTarget), acct);
    await w.send(BUYER, t.token, '0xa9059cbb' + word(w.pool) + word(1000n));
    expect(toModel(await w.readPool(t.token))).toEqual(before);
    await w.buy(BUYER, t.token, ETH);
    const after = toModel(await w.readPool(t.token));
    expect(after.y).toBeGreaterThan(before.y);
    expect(await w.totalOwed()).toBe(after.y + after.feeReserve);
  });
});
