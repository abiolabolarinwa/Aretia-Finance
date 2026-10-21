// AretiaCurveRescue against the DEPLOYED AretiaCurve bytecode and the real Uniswap V2 code (M-4, L-12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEAD, E, curveArt, curveWorld, makeToken, pairAbi, rescueArt, reservesOf, tokAbi, ufacAbi, wethAbi, world } from './harness.mjs';

const CREATOR = '0x' + 'c0'.repeat(20);
const ATT = '0x' + 'aa'.repeat(20);
const HOLDER = '0x' + 'b0'.repeat(20);
const OTHER = '0x' + 'd0'.repeat(20);
const SUPPLY = 1_000_000_000n * E;
const TARGET = 5n * E;
const STATUS = { soldOut: 2n, migrated: 3n, aborted: 4n };

/** A token whose whole supply is on a curve; the creator and the holder buy it out, the attacker holds some too. */
async function soldOut({ decimals = 18, supply = SUPPLY, total = supply, target = TARGET } = {}) {
  const W = await world();
  for (const a of [CREATOR, ATT, HOLDER, OTHER]) await W.fund(a, 10_000n * E);
  const S = await curveWorld(W);
  const { token, nonce } = await makeToken(W, S, CREATOR, supply, decimals);
  await W.must(CREATOR, token, tokAbi, 'approve', [S.curve, total]);
  await W.must(CREATOR, S.curve, curveArt.abi, 'createCurve', [token, nonce, total, target, 0n], target / 5n);
  await W.must(ATT, S.curve, curveArt.abi, 'buy', [token, 0n], target / 5n);
  await W.must(HOLDER, S.curve, curveArt.abi, 'buy', [token, 0n], target * 2n); // sells out; the rest comes back
  const c = await curve(W, S, token);
  assert.equal(c.status, STATUS.soldOut);
  return { W, S, token, c };
}
async function curve(W, S, token) {
  const o = await W.view(S.curve, curveArt.abi, 'curves', [token]);
  return { status: BigInt(o[0]), lp: o[8], coin: o[11], realTok: o[12] };
}
async function poison(W, S, token, { coin = 0n, tokens = 0n, sync = true, mint = false } = {}) {
  const pair = (await W.must(ATT, S.ufac, ufacAbi, 'createPair', [token, S.weth])).out;
  if (coin > 0n) {
    await W.must(ATT, S.weth, wethAbi, 'deposit', [], coin);
    await W.must(ATT, S.weth, wethAbi, 'transfer', [pair, coin]);
  }
  if (tokens > 0n) await W.must(ATT, token, tokAbi, 'transfer', [pair, tokens]);
  if (mint) await W.must(ATT, pair, pairAbi, 'mint', [ATT]);
  else if (sync) await W.must(ATT, pair, pairAbi, 'sync', []);
  return pair;
}
/** The helper must end every call holding nothing. */
async function assertEmpty(W, S, token) {
  assert.equal(await W.balance(S.rescue), 0n, 'helper holds coin');
  assert.equal(await W.view(S.weth, wethAbi, 'balanceOf', [S.rescue]), 0n, 'helper holds WETH');
  assert.equal(await W.view(token, tokAbi, 'balanceOf', [S.rescue]), 0n, 'helper holds tokens');
}
/** After a graduation: migrated, nothing owed, pool price within the curve's own 1% (and, in fact, within 0.1%). */
async function assertGraduated(W, S, token, c) {
  const after = await curve(W, S, token);
  assert.equal(after.status, STATUS.migrated);
  assert.equal(await W.view(S.curve, curveArt.abi, 'totalOwed'), 0n);
  const pair = await W.view(S.ufac, ufacAbi, 'getPair', [token, S.weth]);
  const { rT, rC } = await reservesOf(W, pair, token);
  const lhs = rC * c.lp;
  const rhs = c.coin * rT;
  assert.ok(lhs * 10_000n >= rhs * 9_990n && lhs * 10_000n <= rhs * 10_010n, `pool price off: ${rT} ${rC}`);
  assert.ok((await W.view(pair, pairAbi, 'balanceOf', [DEAD])) > 0n, 'no liquidity at the dead address');
}
/** Approves exactly what the helper's quote asks, then rescues with exactly the quoted coin plus `extra`. */
async function rescueAsQuoted(W, S, token, who = HOLDER, extra = 0n) {
  const q = await W.view(S.rescue, rescueArt.abi, 'quote', [token]);
  if (q.tokensIn > 0n) await W.must(who, token, tokAbi, 'approve', [S.rescue, q.tokensIn]);
  const coinBefore = await W.balance(who);
  const tokBefore = await W.view(token, tokAbi, 'balanceOf', [who]);
  const r = await W.call(who, S.rescue, rescueArt.abi, 'rescue', [token, q.tokensIn], q.coinIn + extra);
  return { q, r, coinDelta: (await W.balance(who)) - coinBefore, tokDelta: (await W.view(token, tokAbi, 'balanceOf', [who])) - tokBefore };
}

test('normal path: no pair yet; the helper just graduates and refunds every wei sent', async () => {
  const { W, S, token, c } = await soldOut();
  const q = await W.view(S.rescue, rescueArt.abi, 'quote', [token]);
  assert.equal(q.pair, '0x0000000000000000000000000000000000000000');
  const before = await W.balance(HOLDER);
  const r = await W.call(HOLDER, S.rescue, rescueArt.abi, 'rescue', [token, 0n], 3n * E);
  assert.ok(r.ok, r.reason);
  assert.equal(await W.balance(HOLDER), before, 'the 3 coins sent came back');
  await assertGraduated(W, S, token, c);
  await assertEmpty(W, S, token);
});

test('blocking case 1: 1 wei of WETH and sync (attacker holds no tokens) blocks graduate; the rescue graduates', async () => {
  const { W, S, token, c } = await soldOut();
  await poison(W, S, token, { coin: 1n });
  const plain = await W.call(OTHER, S.curve, curveArt.abi, 'graduate', [token]);
  assert.equal(plain.ok, false);
  assert.match(plain.reason, /INSUFFICIENT_LIQUIDITY/);
  const { q, r, coinDelta, tokDelta } = await rescueAsQuoted(W, S, token);
  assert.ok(r.ok, r.reason);
  assert.equal(q.coinIn, 0n);
  assert.ok(q.tokensIn > 0n && q.tokensIn < 10n ** 12n, `token top-up is dust: ${q.tokensIn}`);
  assert.equal(tokDelta, -q.tokensIn);
  assert.equal(coinDelta, 0n);
  await assertGraduated(W, S, token, c);
  await assertEmpty(W, S, token);
});

test('blocking case 2: 1 wei of each side and sync; the rescue graduates', async () => {
  const { W, S, token, c } = await soldOut();
  await poison(W, S, token, { coin: 1n, tokens: 1n });
  assert.equal((await W.call(OTHER, S.curve, curveArt.abi, 'graduate', [token])).ok, false);
  const { r } = await rescueAsQuoted(W, S, token);
  assert.ok(r.ok, r.reason);
  await assertGraduated(W, S, token, c);
  await assertEmpty(W, S, token);
});

test('blocking case 3: 1 ETH against 1 token-wei (also: minted LP, and 1 ETH alone); the rescuer swaps the excess out and is paid for it', async () => {
  for (const [tokens, mint] of [[1n, false], [1_000_000n, true], [0n, false]]) {
    const { W, S, token, c } = await soldOut();
    await poison(W, S, token, { coin: 1n * E, tokens, mint });
    assert.equal((await W.call(OTHER, S.curve, curveArt.abi, 'graduate', [token])).ok, false);
    const { q, r, coinDelta, tokDelta } = await rescueAsQuoted(W, S, token);
    assert.ok(r.ok, r.reason);
    assert.ok(q.coinOut > (99n * E) / 100n, `rescuer takes the attacker's coin: ${q.coinOut}`);
    assert.equal(coinDelta, q.coinOut);
    assert.equal(tokDelta, -q.tokensIn);
    assert.ok(q.tokensIn < 10n ** 16n, 'and pays only dust tokens');
    await assertGraduated(W, S, token, c);
    await assertEmpty(W, S, token);
  }
});

test('a token-heavy pair (tokens dumped and synced): coin in, tokens out to the rescuer', async () => {
  const { W, S, token, c } = await soldOut();
  const held = await W.view(token, tokAbi, 'balanceOf', [ATT]);
  await poison(W, S, token, { tokens: held, coin: 1000n });
  assert.equal((await W.call(OTHER, S.curve, curveArt.abi, 'graduate', [token])).ok, false);
  const { q, r, tokDelta } = await rescueAsQuoted(W, S, token);
  assert.ok(r.ok, r.reason);
  assert.ok(q.tokensOut > (held * 99n) / 100n, 'the dumped tokens go to the rescuer');
  assert.equal(tokDelta, q.tokensOut);
  await assertGraduated(W, S, token, c);
  await assertEmpty(W, S, token);
});

test('unsynced donations: graduate fails on the pool price; the rescue skims them to the caller and graduates', async () => {
  const { W, S, token, c } = await soldOut();
  const pair = await poison(W, S, token, { coin: 1n * E, sync: false });
  const plain = await W.call(OTHER, S.curve, curveArt.abi, 'graduate', [token]);
  assert.equal(plain.ok, false);
  assert.match(plain.reason, /pool price/);
  const before = await W.view(S.weth, wethAbi, 'balanceOf', [HOLDER]);
  const { r } = await rescueAsQuoted(W, S, token);
  assert.ok(r.ok, r.reason);
  assert.equal((await W.view(S.weth, wethAbi, 'balanceOf', [HOLDER])) - before, 1n * E, 'the skimmed WETH went to the caller');
  assert.ok(pair);
  await assertGraduated(W, S, token, c);
  await assertEmpty(W, S, token);
});

test('random poisoned pairs (synced or minted, either side, many sizes): always graduates at the curve price, quote = effect, nothing left', async () => {
  let seed = 12345n;
  const rnd = (bits) => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
    return seed % (1n << BigInt(bits));
  };
  for (let i = 0; i < 14; i++) {
    const decimals = [18, 6, 0][i % 3];
    const supply = decimals === 0 ? 1_000_000n : 1_000_000_000n * 10n ** BigInt(decimals);
    const { W, S, token, c } = await soldOut({ decimals, supply });
    const attTok = await W.view(token, tokAbi, 'balanceOf', [ATT]);
    const coin = i % 4 === 0 ? 0n : 1n + rnd(i % 2 ? 8 : 60);
    const tokens = i % 5 === 1 ? 0n : (1n + rnd(64)) % (attTok + 1n);
    if (coin === 0n && tokens === 0n) continue;
    const mint = coin > 0n && tokens > 0n && i % 3 === 0 && coin * tokens > 10n ** 7n;
    await poison(W, S, token, { coin, tokens, mint });
    const { q, r, coinDelta, tokDelta } = await rescueAsQuoted(W, S, token, HOLDER, 12345n);
    assert.ok(r.ok, `case ${i} (coin ${coin}, tokens ${tokens}, mint ${mint}): ${r.reason}`);
    assert.equal(coinDelta, q.coinOut - q.coinIn, `case ${i}: coin change`);
    assert.equal(tokDelta, q.tokensOut - q.tokensIn, `case ${i}: token change`);
    await assertGraduated(W, S, token, c);
    await assertEmpty(W, S, token);
  }
});

test('bounds: too few tokens or too little coin reverts and changes nothing', async () => {
  const { W, S, token } = await soldOut();
  await poison(W, S, token, { coin: 1n });
  const q = await W.view(S.rescue, rescueArt.abi, 'quote', [token]);
  await W.must(HOLDER, token, tokAbi, 'approve', [S.rescue, q.tokensIn]);
  const r1 = await W.call(HOLDER, S.rescue, rescueArt.abi, 'rescue', [token, q.tokensIn - 1n], 0n);
  assert.equal(r1.reason, 'tokens');
  const { W: W2, S: S2, token: t2 } = await soldOut();
  await poison(W2, S2, t2, { tokens: 10n ** 24n });
  const q2 = await W2.view(S2.rescue, rescueArt.abi, 'quote', [t2]);
  assert.ok(q2.coinIn > 0n);
  const r2 = await W2.call(HOLDER, S2.rescue, rescueArt.abi, 'rescue', [t2, q2.tokensIn], q2.coinIn - 1n);
  assert.equal(r2.reason, 'coin');
  assert.equal((await curve(W2, S2, t2)).status, STATUS.soldOut);
});

test('it cannot take tokens from anyone but the caller', async () => {
  const { W, S, token } = await soldOut();
  await poison(W, S, token, { coin: 1n });
  // The holder approves the helper generously; someone else (holding no tokens) tries to rescue on the holder's allowance.
  await W.must(HOLDER, token, tokAbi, 'approve', [S.rescue, 10n ** 30n]);
  const before = await W.view(token, tokAbi, 'balanceOf', [HOLDER]);
  const r = await W.call(OTHER, S.rescue, rescueArt.abi, 'rescue', [token, 10n ** 30n], 0n);
  assert.equal(r.ok, false);
  assert.equal(await W.view(token, tokAbi, 'balanceOf', [HOLDER]), before);
  assert.equal((await curve(W, S, token)).status, STATUS.soldOut);
});

test('it graduates nothing the curve itself would not: open, aborted or migrated curves are refused', async () => {
  const W = await world();
  for (const a of [CREATOR, HOLDER]) await W.fund(a, 1000n * E);
  const S = await curveWorld(W);
  const { token, nonce } = await makeToken(W, S, CREATOR, SUPPLY);
  await W.must(CREATOR, token, tokAbi, 'approve', [S.curve, SUPPLY]);
  await W.must(CREATOR, S.curve, curveArt.abi, 'createCurve', [token, nonce, SUPPLY, TARGET, 0n], E);
  assert.equal((await W.call(HOLDER, S.rescue, rescueArt.abi, 'rescue', [token, 0n], 0n)).reason, 'not sold out');
  assert.equal((await W.call(HOLDER, S.rescue, rescueArt.abi, 'quote', [token])).reason, 'not sold out');

  const a = await soldOut();
  await poison(a.W, a.S, a.token, { coin: 1n });
  a.W.warp(7 * 24 * 3600 + 1);
  await a.W.must(OTHER, a.S.curve, curveArt.abi, 'abortMigration', [a.token]);
  assert.equal((await a.W.call(HOLDER, a.S.rescue, rescueArt.abi, 'rescue', [a.token, 10n ** 30n], E)).reason, 'not sold out');

  const m = await soldOut();
  assert.ok((await m.W.call(HOLDER, m.S.rescue, rescueArt.abi, 'rescue', [m.token, 0n], 0n)).ok);
  assert.equal((await m.W.call(HOLDER, m.S.rescue, rescueArt.abi, 'rescue', [m.token, 0n], 0n)).reason, 'not sold out');
});

test('no owner, no setter, no withdraw: the ABI is only quote, rescue and immutable reads', async () => {
  const names = rescueArt.abi.filter((x) => x.type === 'function').map((x) => x.name).sort();
  assert.deepEqual(names, ['MIN_DERIVED', 'curve', 'pairFactory', 'quote', 'rescue', 'weth']);
});

test('gas: a rescue of the 1-wei case costs well under the 3M of a fresh graduation', async () => {
  const { W, S, token } = await soldOut();
  await poison(W, S, token, { coin: 1n });
  const { r } = await rescueAsQuoted(W, S, token);
  assert.ok(r.ok);
  assert.ok(r.gas < 600_000n, `gas ${r.gas}`);
  console.log('rescue gas (1 wei of WETH case):', r.gas);
});
