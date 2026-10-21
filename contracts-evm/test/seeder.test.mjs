// AretiaPairSeeder against the real Uniswap V2 code (M-4, the Launch page's "open a Uniswap V2-style pool").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEAD, E, FEE, ctor, exchange, facArt, pairAbi, reservesOf, routerAbi, seederArt, tokAbi, ufacAbi, wethAbi, world } from './harness.mjs';

const CREATOR = '0x' + 'c0'.repeat(20);
const ATT = '0x' + 'aa'.repeat(20);
const OTHER = '0x' + 'd0'.repeat(20);
const TOKENS = 1_000_000n * E;
const COIN = 2n * E;

async function setup() {
  const W = await world();
  for (const a of [CREATOR, ATT, OTHER]) await W.fund(a, 1000n * E);
  const x = await exchange(W);
  const factory = await W.deploy(x.deployer, facArt.bytecode, ctor(['address', 'uint256'], [FEE, 0n]));
  const seeder = await W.deploy(x.deployer, seederArt.bytecode, ctor(['address'], [x.router]));
  const token = (await W.must(CREATOR, factory, facArt.abi, 'create', ['T', 'T', 18, 10n * TOKENS])).out.toLowerCase();
  await W.must(CREATOR, token, tokAbi, 'transfer', [ATT, 1000n * E]);
  return { W, ...x, seeder, token };
}
async function poison(S, { coin = 0n, tokens = 0n, sync = true, mint = false } = {}) {
  const { W } = S;
  const pair = (await W.must(ATT, S.ufac, ufacAbi, 'createPair', [S.token, S.weth])).out;
  if (coin > 0n) {
    await W.must(ATT, S.weth, wethAbi, 'deposit', [], coin);
    await W.must(ATT, S.weth, wethAbi, 'transfer', [pair, coin]);
  }
  if (tokens > 0n) await W.must(ATT, S.token, tokAbi, 'transfer', [pair, tokens]);
  if (mint) await W.must(ATT, pair, pairAbi, 'mint', [ATT]);
  else if (sync) await W.must(ATT, pair, pairAbi, 'sync', []);
  return pair;
}
async function routerAdd(S) {
  const { W } = S;
  await W.must(CREATOR, S.token, tokAbi, 'approve', [S.router, TOKENS]);
  return W.call(CREATOR, S.router, routerAbi, 'addLiquidityETH', [S.token, TOKENS, TOKENS, COIN, DEAD, W.now() + 600n], COIN);
}
async function seed(S, to = DEAD) {
  const { W } = S;
  const [ok, , qt, qc] = await W.view(S.seeder, seederArt.abi, 'quote', [S.token, TOKENS, COIN]);
  const q = { ok, tokensPaid: qt, coinPaid: qc };
  await W.must(CREATOR, S.token, tokAbi, 'approve', [S.seeder, TOKENS]);
  const coinBefore = await W.balance(CREATOR);
  const tokBefore = await W.view(S.token, tokAbi, 'balanceOf', [CREATOR]);
  const r = await W.call(CREATOR, S.seeder, seederArt.abi, 'seed', [S.token, TOKENS, to], COIN);
  return { q, r, coinPaid: coinBefore - (await W.balance(CREATOR)), tokensPaid: tokBefore - (await W.view(S.token, tokAbi, 'balanceOf', [CREATOR])) };
}
async function assertSeeded(S, to = DEAD) {
  const { W } = S;
  const pair = await W.view(S.ufac, ufacAbi, 'getPair', [S.token, S.weth]);
  const { rT, rC } = await reservesOf(W, pair, S.token);
  assert.equal(rT, TOKENS, 'token reserve is exactly the intended amount');
  assert.equal(rC, COIN, 'coin reserve is exactly the intended amount');
  assert.ok((await W.view(pair, pairAbi, 'balanceOf', [to])) > 0n);
  assert.equal(await W.balance(S.seeder), 0n);
  assert.equal(await W.view(S.weth, wethAbi, 'balanceOf', [S.seeder]), 0n);
  assert.equal(await W.view(S.token, tokAbi, 'balanceOf', [S.seeder]), 0n);
}

test('no pair yet: creates it and opens it at exactly the intended price', async () => {
  const S = await setup();
  const { q, r, coinPaid, tokensPaid } = await seed(S);
  assert.ok(r.ok, r.reason);
  assert.equal(q.ok, true);
  assert.equal(coinPaid, COIN);
  assert.equal(tokensPaid, TOKENS);
  await assertSeeded(S);
});

for (const [name, opts] of [
  ['1 wei of WETH synced (no tokens held by the attacker)', { coin: 1n }],
  ['1 wei of each side synced', { coin: 1n, tokens: 1n }],
  ['1 token-wei only, synced', { tokens: 1n }],
]) {
  test(`blocked for the router (${name}); the seeder opens it at exactly the intended price`, async () => {
    const S = await setup();
    await poison(S, opts);
    const plain = await routerAdd(S);
    assert.equal(plain.ok, false);
    const { q, r, coinPaid, tokensPaid } = await seed(S);
    assert.ok(r.ok, r.reason);
    assert.equal(coinPaid, COIN - (opts.coin ?? 0n), 'the dust counts towards the coin');
    assert.equal(tokensPaid, TOKENS - (opts.tokens ?? 0n));
    assert.equal(q.coinPaid, coinPaid);
    assert.equal(q.tokensPaid, tokensPaid);
    await assertSeeded(S);
  });
}

test('unsynced donations are skimmed to the caller, then the pool opens exactly', async () => {
  const S = await setup();
  await poison(S, { coin: 5n * E, sync: false });
  const before = await S.W.view(S.weth, wethAbi, 'balanceOf', [CREATOR]);
  const { r } = await seed(S, CREATOR);
  assert.ok(r.ok, r.reason);
  assert.equal((await S.W.view(S.weth, wethAbi, 'balanceOf', [CREATOR])) - before, 5n * E);
  await assertSeeded(S, CREATOR);
});

test('a pair that already has liquidity tokens is refused (someone owns it)', async () => {
  const S = await setup();
  await poison(S, { coin: E, tokens: 1000n * E, mint: true });
  const { q, r } = await seed(S);
  assert.equal(q.ok, false);
  assert.equal(r.reason, 'pool has liquidity');
});

test('reserves at or above an intended amount are refused, nothing moves', async () => {
  const S = await setup();
  await poison(S, { coin: COIN });
  const tokBefore = await S.W.view(S.token, tokAbi, 'balanceOf', [CREATOR]);
  const { q, r } = await seed(S);
  assert.equal(q.ok, false);
  assert.equal(r.reason, 'reserves above amounts');
  assert.equal(await S.W.view(S.token, tokAbi, 'balanceOf', [CREATOR]), tokBefore);
});

test('it pulls tokens only from the caller', async () => {
  const S = await setup();
  await poison(S, { coin: 1n });
  await S.W.must(CREATOR, S.token, tokAbi, 'approve', [S.seeder, 10n ** 30n]);
  const before = await S.W.view(S.token, tokAbi, 'balanceOf', [CREATOR]);
  const r = await S.W.call(OTHER, S.seeder, seederArt.abi, 'seed', [S.token, TOKENS, OTHER], COIN);
  assert.equal(r.ok, false);
  assert.equal(await S.W.view(S.token, tokAbi, 'balanceOf', [CREATOR]), before);
});

test('no owner, no setter, no withdraw', async () => {
  const names = seederArt.abi.filter((x) => x.type === 'function').map((x) => x.name).sort();
  assert.deepEqual(names, ['pairFactory', 'quote', 'router', 'seed', 'weth']);
});
