// AretiaPool (new build): the October 2026 review's PoC scenarios (docs/audit/2026-10-full-review/poc/evm-pool/poc.mjs) turned into
// regression tests that show each attack now fails, plus the other fixes (M-2, M-9, L-19, L-20, I-3, I-5, I-7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E, FEE, ctor, decodeEventLog, facArt, poolArt, poolMocks, tokAbi, world } from './harness.mjs';

const C = '0x00000000000000000000000000000000000c0de1'; // creator
const A = '0x0000000000000000000000000000000000a77ac1'; // attacker
const B = '0x0000000000000000000000000000000000b0b001'; // buyer / honest LP
const V = '0x0000000000000000000000000000000000b0b002'; // intended position receiver
const DEPLOYER = '0x' + 'd'.repeat(40);
const CREATION_FEE = 42n * 10n ** 14n;
const abi = poolArt.abi;
const FAR = 2_000_000_000n;

async function base({ feeRecipient = FEE, creationFee = CREATION_FEE } = {}) {
  const W = await world();
  for (const a of [C, A, B, V, DEPLOYER]) await W.fund(a, 10n ** 30n);
  if (feeRecipient === 'attacker') feeRecipient = await W.deploy(DEPLOYER, poolMocks.Attacker.bytecode);
  const factory = await W.deploy(DEPLOYER, facArt.bytecode, ctor(['address', 'uint256'], [FEE, 1n]));
  const token = (await W.must(C, factory, facArt.abi, 'create', ['Tok', 'TOK', 18, 10n ** 27n], 1n)).out.toLowerCase();
  const pool = await W.deploy(DEPLOYER, poolArt.bytecode, ctor(['address', 'address', 'uint256'], [factory, feeRecipient, creationFee]));
  const P = {
    W,
    token,
    pool,
    feeRecipient,
    creationFee,
    async pool_() {
      const o = await W.view(pool, abi, 'pools', [token]);
      return { fee: o[0], x: o[3], y: o[4], l: o[5], acc: o[6], fr: o[7], locked: o[8], rem: o[9] };
    },
    async pos(owner) {
      const o = await W.view(pool, abi, 'positions', [token, owner]);
      return { open: o[0], shares: o[1], locked: o[2], pending: o[4], recipient: o[5] };
    },
    async solvent() {
      assert.ok((await W.balance(pool)) >= (await W.view(pool, abi, 'totalOwed')), 'insolvent');
    },
  };
  return P;
}
const params = (P, o = {}) => ({ token: P.token, factoryNonce: 1n, x0: 10n ** 27n, l0: 5n * E, y0: 0n, feeBps: 100n, lock: true, owner: C, firstBuyWei: 0n, minFirstBuyOut: 0n, deadline: FAR, ...o });
async function create(P, o = {}) {
  const p = params(P, o);
  await P.W.must(C, P.token, tokAbi, 'approve', [P.pool, p.x0]);
  return P.W.call(C, P.pool, abi, 'createPool', [p], P.creationFee + p.y0 + p.firstBuyWei);
}
const buy = (P, who, wei, deadline = FAR) => P.W.call(who, P.pool, abi, 'buy', [P.token, 0n, deadline], wei);
const sell = (P, who, tokens, deadline = FAR) => P.W.call(who, P.pool, abi, 'sell', [P.token, tokens, 0n, deadline]);
const ceil = (a, b) => (a + b - 1n) / b;
async function addDust(P, who, dl) {
  const p = await P.pool_();
  const tokens = ceil(p.x * dl, p.l);
  await P.W.must(who, P.token, tokAbi, 'approve', [P.pool, tokens]);
  return P.W.call(who, P.pool, abi, 'addLiquidity', [P.token, dl, tokens, FAR], ceil(p.y * dl, p.l));
}
const events = (r) =>
  r.logs.flatMap((l) => {
    try {
      return [decodeEventLog({ abi, data: l.data, topics: l.topics })];
    } catch {
      return [];
    }
  });

test('PoC 1 (L-19): a dust position pushed to an address no longer blocks transfers to it; the positions merge', async () => {
  const P = await base();
  assert.ok((await create(P)).ok);
  assert.ok((await buy(P, A, E / 100n)).ok);
  assert.ok((await addDust(P, A, 1000n)).ok);
  assert.ok((await P.W.call(A, P.pool, abi, 'lockLiquidity', [P.token, 1000n])).ok);
  assert.ok((await P.W.call(A, P.pool, abi, 'transferPosition', [P.token, V])).ok, 'dust pushed to V');
  const r = await P.W.call(C, P.pool, abi, 'transferPosition', [P.token, V]);
  assert.ok(r.ok, `creator -> V now succeeds: ${r.reason}`);
  const v = await P.pos(V);
  assert.equal(v.shares, 5n * E + 1000n);
  assert.equal(v.locked, 5n * E + 1000n);
  assert.equal((await P.pos(C)).open, false);
  await P.solvent();
});

test('PoC 1 (L-19): a fully withdrawn position is closed, and the creator can then transfer to that address', async () => {
  const P = await base();
  assert.ok((await create(P)).ok);
  await P.W.must(B, P.token, tokAbi, 'approve', [P.pool, 10n ** 30n]);
  assert.ok((await buy(P, B, E)).ok);
  const p2 = await P.pool_();
  const dl = 10n ** 15n;
  assert.ok((await P.W.call(B, P.pool, abi, 'addLiquidity', [P.token, dl, 10n ** 30n, FAR], (p2.y * dl) / p2.l + 1n)).ok);
  // A trade in between gives B pending fees; claim them so nothing is left.
  assert.ok((await buy(P, A, E / 10n)).ok);
  const r = await P.W.call(B, P.pool, abi, 'removeLiquidity', [P.token, dl, 0n, 0n, FAR]);
  assert.ok(r.ok);
  if ((await P.pos(B)).open) assert.ok((await P.W.call(B, P.pool, abi, 'claimFees', [P.token])).ok);
  assert.equal((await P.pos(B)).open, false, 'empty position deleted');
  assert.ok(events(r).some((e) => e.eventName === 'LiquidityChanged'));
  assert.ok((await P.W.call(C, P.pool, abi, 'transferPosition', [P.token, B])).ok);
});

test('PoC 2 (M-2): a fee address that refuses coin no longer freezes buys or sells; only the withdrawal waits', async () => {
  const P = await base({ feeRecipient: 'attacker', creationFee: 0n });
  assert.ok((await create(P, { firstBuyWei: E })).ok);
  await P.W.must(C, P.token, tokAbi, 'approve', [P.pool, 10n ** 30n]);
  assert.ok((await sell(P, C, 10n ** 24n)).ok);
  assert.ok((await P.W.call(C, P.feeRecipient, poolMocks.Attacker.abi, 'setRefuse', [true])).ok);
  assert.ok((await buy(P, C, E)).ok, 'buy works while the fee address refuses');
  assert.ok((await sell(P, C, 10n ** 24n)).ok, 'sell works while the fee address refuses');
  assert.ok((await P.W.call(C, P.pool, abi, 'claimFees', [P.token])).ok);
  const owed = await P.W.view(P.pool, abi, 'protocolOwed');
  assert.ok(owed > 0n);
  const w1 = await P.W.call(B, P.pool, abi, 'withdrawProtocolFees');
  assert.equal(w1.ok, false, 'only the withdrawal fails');
  assert.ok((await P.W.call(C, P.feeRecipient, poolMocks.Attacker.abi, 'setRefuse', [false])).ok);
  const before = await P.W.balance(P.feeRecipient);
  assert.ok((await P.W.call(B, P.pool, abi, 'withdrawProtocolFees')).ok, 'anyone can trigger it');
  assert.equal((await P.W.balance(P.feeRecipient)) - before, owed, 'all of it, to the fee address only');
  assert.equal(await P.W.view(P.pool, abi, 'protocolOwed'), 0n);
  await P.solvent();
});

test('M-2: no trade sends coin to the fee address; the protocol share and creation fee accrue exactly', async () => {
  const P = await base();
  const start = await P.W.balance(FEE);
  assert.ok((await create(P)).ok);
  assert.equal(await P.W.balance(FEE), start, 'the creation fee is not pushed');
  const r = await buy(P, B, E);
  assert.ok(r.ok);
  assert.equal(await P.W.balance(FEE), start, 'nothing pushed by a trade');
  const fee = ceil(E * 100n, 10_000n);
  assert.equal(await P.W.view(P.pool, abi, 'protocolOwed'), CREATION_FEE + (fee * 2000n) / 10_000n);
  assert.equal(await P.W.balance(P.pool), await P.W.view(P.pool, abi, 'totalOwed'));
});

test('PoC 3 (M-9): an unlocked pool cannot be created, so the creator cannot withdraw buyers’ coin', async () => {
  const P = await base();
  const r = await create(P, { lock: false });
  assert.equal(r.reason, 'must lock');
  assert.ok((await create(P)).ok);
  assert.ok((await buy(P, B, 10n * E)).ok);
  const p = await P.pool_();
  const rm = await P.W.call(C, P.pool, abi, 'removeLiquidity', [P.token, p.l - 10n ** 12n, 0n, 0n, FAR]);
  assert.equal(rm.ok, false);
  assert.equal(rm.reason, 'unlocked shares');
  assert.equal(p.locked, 5n * E, 'the pool reports its locked liquidity');
});

test('M-9: pools(token).locked tracks every lock, and an unlocked deposit can still leave', async () => {
  const P = await base();
  assert.ok((await create(P)).ok);
  assert.ok((await buy(P, B, E)).ok);
  await P.W.must(B, P.token, tokAbi, 'approve', [P.pool, 10n ** 30n]);
  const p = await P.pool_();
  const dl = 10n ** 16n;
  assert.ok((await P.W.call(B, P.pool, abi, 'addLiquidity', [P.token, dl, 10n ** 30n, FAR], ceil(p.y * dl, p.l))).ok);
  assert.ok((await P.W.call(B, P.pool, abi, 'lockLiquidity', [P.token, dl / 2n])).ok);
  const q = await P.pool_();
  assert.equal(q.locked, 5n * E + dl / 2n);
  assert.ok((await P.W.call(B, P.pool, abi, 'removeLiquidity', [P.token, dl / 2n, 0n, 0n, FAR])).ok);
  assert.equal((await P.pool_()).locked, 5n * E + dl / 2n);
});

test('PoC 5 (I-5): LP-fee rounding dust is carried, so every wei of LP fee stays claimable', async () => {
  const P = await base();
  // l0 = 1e22: each 10,000-wei buy credits 80 wei of LP fee, below one unit of acc per share, so the old build lost all of it.
  assert.ok((await create(P, { l0: 10n ** 22n })).ok);
  for (let i = 0; i < 40; i++) assert.ok((await buy(P, B, 10_000n)).ok);
  const p = await P.pool_();
  // One position holds every share: acc * l + remainder is exactly the LP fees credited, scaled by 2^64.
  assert.equal(p.acc * p.l + p.rem, p.fr << 64n);
  assert.ok(p.acc > 0n, 'the carried dust reached the positions');
  const claim = await P.W.view(P.pool, abi, 'pendingFees', [P.token, C]);
  // What is not yet claimable is bounded by one unit per share (l / 2^64 wei), however many trades there are; it was 100% before.
  assert.ok(p.fr - claim <= (p.l >> 64n) + 1n, `stranded ${p.fr - claim} of ${p.fr}`);
});

test('L-20: every trade and liquidity call refuses after its deadline', async () => {
  const P = await base();
  const past = P.W.now() - 1n;
  assert.equal((await create(P, { deadline: past })).reason, 'expired');
  assert.ok((await create(P)).ok);
  await P.W.must(B, P.token, tokAbi, 'approve', [P.pool, 10n ** 30n]);
  assert.ok((await buy(P, B, E)).ok);
  assert.equal((await buy(P, B, E, past)).reason, 'expired');
  assert.equal((await sell(P, B, 10n ** 20n, past)).reason, 'expired');
  assert.equal((await P.W.call(B, P.pool, abi, 'addLiquidity', [P.token, 10n ** 15n, 10n ** 30n, past], E)).reason, 'expired');
  assert.equal((await P.W.call(C, P.pool, abi, 'removeLiquidity', [P.token, 1n, 0n, 0n, past])).reason, 'expired');
  assert.equal((await buy(P, B, E, P.W.now())).ok, true, 'the deadline second itself is allowed');
});

test('I-7: quoteBuy says zero exactly when buy would refuse on the size limit', async () => {
  const P = await base();
  const l0 = (1n << 112n) - 10n ** 20n;
  assert.ok((await create(P, { l0 })).ok);
  const big = 10n ** 21n;
  const [, out] = await P.W.view(P.pool, abi, 'quoteBuy', [P.token, big]);
  assert.equal(out, 0n);
  assert.equal((await buy(P, B, big)).reason, 'size');
  const [, small] = await P.W.view(P.pool, abi, 'quoteBuy', [P.token, 10n ** 12n]);
  assert.ok(small > 0n);
});

test('I-3: Locked is emitted at creation; Swapped says coinIn/coinOut/tokensIn/tokensOut; RecipientSet emits the stored value', async () => {
  const P = await base();
  const r = await create(P);
  const ev = events(r);
  const locked = ev.find((e) => e.eventName === 'Locked');
  assert.ok(locked, 'Locked at creation');
  assert.equal(locked.args.amount, 5n * E);
  const b = events(await buy(P, B, E)).find((e) => e.eventName === 'Swapped');
  assert.equal(b.args.coinIn, E);
  assert.equal(b.args.coinOut, 0n);
  assert.equal(b.args.tokensIn, 0n);
  assert.ok(b.args.tokensOut > 0n);
  await P.W.must(B, P.token, tokAbi, 'approve', [P.pool, 10n ** 30n]);
  const s = events(await sell(P, B, b.args.tokensOut / 2n)).find((e) => e.eventName === 'Swapped');
  assert.equal(s.args.tokensIn, b.args.tokensOut / 2n);
  assert.equal(s.args.tokensOut, 0n);
  assert.equal(s.args.coinIn, 0n);
  assert.ok(s.args.coinOut > 0n);
  const rs = events(await P.W.call(C, P.pool, abi, 'setRecipient', [P.token, C])).find((e) => e.eventName === 'RecipientSet');
  assert.equal(rs.args.recipient, '0x0000000000000000000000000000000000000000');
});

test('solvency across a mixed run: balance equals what is owed, protocol share included', async () => {
  const P = await base();
  assert.ok((await create(P, { firstBuyWei: E / 3n })).ok);
  await P.W.must(B, P.token, tokAbi, 'approve', [P.pool, 10n ** 30n]);
  await P.W.must(C, P.token, tokAbi, 'approve', [P.pool, 10n ** 30n]);
  for (let i = 0; i < 8; i++) {
    assert.ok((await buy(P, B, E / BigInt(i + 2))).ok);
    assert.ok((await sell(P, B, 10n ** 23n)).ok);
  }
  assert.ok((await P.W.call(C, P.pool, abi, 'claimFees', [P.token])).ok);
  assert.ok((await P.W.call(A, P.pool, abi, 'withdrawProtocolFees')).ok);
  assert.ok((await P.W.balance(P.pool)) >= (await P.W.view(P.pool, abi, 'totalOwed')));
});
