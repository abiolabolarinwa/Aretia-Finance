// AretiaLaunchFactory against the real Uniswap V2 code: one transaction creates the token and opens its pool with the liquidity locked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getContractAddress, parseAbi } from 'viem';
import { DEAD, E, ctor, decodeEventLog, exchange, pairAbi, reservesOf, tokAbi, ufacAbi, wethAbi, world, art } from './harness.mjs';

const launchArt = art('AretiaLaunchFactory.artifact.json').launch;
const CREATOR = '0x' + 'c0'.repeat(20);
const ATT = '0x' + 'aa'.repeat(20);
const FEE_TO = '0x000000000000000000000000000000000000fee1';
const FEE = 42n * 10n ** 14n; // 0.0042
const MIN = 2n * 10n ** 16n; // 0.02
const SUPPLY = 1_000_000n * E;

async function setup() {
  const W = await world();
  for (const a of [CREATOR, ATT]) await W.fund(a, 1000n * E);
  const x = await exchange(W);
  const factory = await W.deploy(x.deployer, launchArt.bytecode, ctor(['address', 'uint256', 'address', 'address', 'uint256'], [FEE_TO, FEE, x.ufac, x.weth, MIN]));
  return { W, ...x, factory };
}
const launch = (S, { name = 'Aretia Test', symbol = 'ATEST', decimals = 18, supply = SUPPLY, bps = 7000n, coin = 1n * E, fee = FEE, from = CREATOR } = {}) =>
  S.W.call(from, S.factory, launchArt.abi, 'launch', [name, symbol, decimals, supply, bps], coin + fee);

test('one transaction: token, locked pool, remainder to the creator, fee to Aretia, nothing held', async () => {
  const S = await setup();
  const { W } = S;
  const feeBefore = await W.balance(FEE_TO);
  const creatorBefore = await W.balance(CREATOR);
  const r = await launch(S);
  assert.ok(r.ok, r.reason);
  const [token, pair] = r.out;
  const tokenL = token.toLowerCase();
  assert.equal(await W.view(tokenL, tokAbi, 'totalSupply'), SUPPLY);
  assert.equal(await W.view(tokenL, tokAbi, 'balanceOf', [CREATOR]), (SUPPLY * 3000n) / 10000n, 'the creator keeps the 30% that did not go to the pool');
  const { rT, rC } = await reservesOf(W, pair, tokenL);
  assert.equal(rT, (SUPPLY * 7000n) / 10000n);
  assert.equal(rC, 1n * E);
  assert.equal(await W.view(pair, pairAbi, 'balanceOf', [CREATOR]), 0n, 'the creator holds no liquidity tokens');
  assert.ok((await W.view(pair, pairAbi, 'balanceOf', [DEAD])) > 0n, 'the liquidity tokens are at the dead address');
  assert.equal(await W.view(pair, pairAbi, 'balanceOf', [S.factory]), 0n);
  assert.equal((await W.balance(FEE_TO)) - feeBefore, FEE);
  assert.equal(creatorBefore - (await W.balance(CREATOR)), 1n * E + FEE, 'the creator paid exactly the pool coin and the fee');
  assert.equal(await W.balance(S.factory), 0n);
  assert.equal(await W.view(tokenL, tokAbi, 'balanceOf', [S.factory]), 0n);
  assert.equal(await W.view(S.weth, wethAbi, 'balanceOf', [S.factory]), 0n);
  const ev = r.logs
    .map((l) => {
      try {
        return decodeEventLog({ abi: launchArt.abi, data: l.data, topics: l.topics });
      } catch {
        return null;
      }
    })
    .find((e) => e?.eventName === 'TokenLaunched');
  assert.ok(ev, 'TokenLaunched is emitted');
  assert.equal(ev.args.token.toLowerCase(), tokenL);
  assert.equal(ev.args.creator.toLowerCase(), CREATOR);
  assert.equal(ev.args.supply, SUPPLY);
  assert.equal(ev.args.poolCoin, 1n * E);
  console.log('gas', r.gas);
});

test('the creator cannot take the liquidity out', async () => {
  const S = await setup();
  const { W } = S;
  const [, pair] = (await launch(S)).out;
  assert.equal((await W.call(CREATOR, pair, pairAbi, 'burn', [CREATOR])).ok, false, 'burn with no liquidity tokens fails');
  assert.equal(await W.view(pair, pairAbi, 'balanceOf', [CREATOR]), 0n);
});

test('a 100% pool share leaves the creator nothing; a lower share than 70% is refused', async () => {
  const S = await setup();
  const { W } = S;
  const r = await launch(S, { bps: 10000n });
  assert.ok(r.ok, r.reason);
  assert.equal(await W.view(r.out[0].toLowerCase(), tokAbi, 'balanceOf', [CREATOR]), 0n);
  for (const bps of [6999n, 0n, 10001n, 20000n]) assert.equal((await launch(S, { bps })).ok, false, `bps ${bps}`);
  assert.equal((await launch(S, { bps: 7000n })).ok, true);
});

test('refuses too little value, bad names, symbols, decimals and zero supply', async () => {
  const S = await setup();
  assert.equal((await launch(S, { coin: MIN - 1n })).ok, false);
  assert.equal((await launch(S, { coin: 0n })).ok, false);
  assert.equal((await launch(S, { coin: MIN })).ok, true);
  assert.equal((await launch(S, { name: '' })).ok, false);
  assert.equal((await launch(S, { name: 'x'.repeat(33) })).ok, false);
  assert.equal((await launch(S, { symbol: '' })).ok, false);
  assert.equal((await launch(S, { symbol: 'x'.repeat(12) })).ok, false);
  assert.equal((await launch(S, { decimals: 19 })).ok, false);
  assert.equal((await launch(S, { supply: 0n })).ok, false);
  // a supply so small the pool would get no tokens
  assert.equal((await launch(S, { supply: 1n, bps: 7000n })).ok, false);
});

test('the fee is paid even on a minimum launch', async () => {
  const S = await setup();
  const before = await S.W.balance(FEE_TO);
  assert.ok((await launch(S, { coin: MIN })).ok);
  assert.equal((await S.W.balance(FEE_TO)) - before, FEE);
});

test('a pair made first cannot be synced before the token exists, so it cannot stop the launch (it would stop the router)', async () => {
  const S = await setup();
  const { W } = S;
  // The token address is predictable (CREATE from the factory, nonce 1), so an attacker can make its pair before the token exists.
  const predicted = getContractAddress({ from: S.factory, nonce: 1n }).toLowerCase();
  const pair = (await W.must(ATT, S.ufac, ufacAbi, 'createPair', [predicted, S.weth])).out;
  await W.must(ATT, S.weth, wethAbi, 'deposit', [], 1n);
  await W.must(ATT, S.weth, wethAbi, 'transfer', [pair, 1n]);
  // sync() and mint() read the token's balance, and there is no token yet: they revert, so the pair stays empty and unsynced.
  assert.equal((await W.call(ATT, pair, pairAbi, 'sync', [])).ok, false);
  assert.equal((await W.call(ATT, pair, pairAbi, 'mint', [ATT])).ok, false);
  const r = await launch(S);
  assert.ok(r.ok, r.reason);
  assert.equal(r.out[0].toLowerCase(), predicted);
  assert.equal(r.out[1].toLowerCase(), pair.toLowerCase());
  const { rT, rC } = await reservesOf(W, pair, predicted);
  assert.equal(rT, (SUPPLY * 7000n) / 10000n);
  assert.equal(rC, 1n * E, 'the 1 wei the attacker sent was skimmed away; the pool opens at exactly the intended amounts');
  assert.ok((await W.view(pair, pairAbi, 'balanceOf', [DEAD])) > 0n);
});

test('WETH sent to a pair made first and NOT synced is skimmed to the creator, and the pool opens at the intended price', async () => {
  const S = await setup();
  const { W } = S;
  const predicted = getContractAddress({ from: S.factory, nonce: 1n }).toLowerCase();
  const pair = (await W.must(ATT, S.ufac, ufacAbi, 'createPair', [predicted, S.weth])).out;
  await W.must(ATT, S.weth, wethAbi, 'deposit', [], 5n * E);
  await W.must(ATT, S.weth, wethAbi, 'transfer', [pair, 5n * E]);
  const wethBefore = await W.view(S.weth, wethAbi, 'balanceOf', [CREATOR]);
  const r = await launch(S);
  assert.ok(r.ok, r.reason);
  const { rC } = await reservesOf(W, pair, predicted);
  assert.equal(rC, 1n * E, 'the donation did not move the price');
  assert.equal((await W.view(S.weth, wethAbi, 'balanceOf', [CREATOR])) - wethBefore, 5n * E, 'the donation went to the creator');
});

test('a token with fewer decimals works, and the pool holds exactly the intended amounts', async () => {
  const S = await setup();
  const r = await launch(S, { decimals: 6, supply: 1_000_000_000n * 10n ** 6n, bps: 8000n, coin: 3n * E });
  assert.ok(r.ok, r.reason);
  const { rT, rC } = await reservesOf(S.W, r.out[1], r.out[0].toLowerCase());
  assert.equal(rT, 800_000_000n * 10n ** 6n);
  assert.equal(rC, 3n * E);
});

test('the factory has no owner, withdraw or setter, and its settings are read back as deployed', async () => {
  const S = await setup();
  const names = launchArt.abi
    .filter((x) => x.type === 'function')
    .map((x) => x.name)
    .sort();
  assert.deepEqual(names, ['MIN_POOL_BPS', 'dexFactory', 'fee', 'feeRecipient', 'launch', 'minLiquidity', 'wrapped']);
  const abi = parseAbi([
    'function fee() view returns (uint256)',
    'function feeRecipient() view returns (address)',
    'function dexFactory() view returns (address)',
    'function wrapped() view returns (address)',
    'function minLiquidity() view returns (uint256)',
  ]);
  assert.equal(await S.W.view(S.factory, abi, 'fee'), FEE);
  assert.equal((await S.W.view(S.factory, abi, 'feeRecipient')).toLowerCase(), FEE_TO);
  assert.equal((await S.W.view(S.factory, abi, 'dexFactory')).toLowerCase(), S.ufac.toLowerCase());
  assert.equal((await S.W.view(S.factory, abi, 'wrapped')).toLowerCase(), S.weth.toLowerCase());
  assert.equal(await S.W.view(S.factory, abi, 'minLiquidity'), MIN);
  // plain coin sent to the factory is refused (it has no receive function)
  assert.equal((await S.W.run(CREATOR, S.factory, '0x', 1n)).ok, false);
});

test('two launches by different creators get different tokens and pairs', async () => {
  const S = await setup();
  const a = await launch(S);
  const b = await launch(S, { name: 'Second', symbol: 'TWO', from: ATT });
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.out[0], b.out[0]);
  assert.notEqual(a.out[1], b.out[1]);
});
