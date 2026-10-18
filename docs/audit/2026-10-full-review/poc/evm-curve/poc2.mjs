// F-1b: known finding 4 (1 wei each side + sync) and the WETH-only variant, both repaired atomically by a permissionless helper.
import * as H from './harness.mjs';
import { readFileSync } from 'node:fs';
const R = JSON.parse(readFileSync('Rescue.json', 'utf8'));
const E = 10n ** 18n;
let ii = 1; for (const variant of ['weth-only', 'both-sides', 'big-skew']) { ii++;
  const s = await H.setup(ii);
  const CREATOR = '0x' + 'c' + ii + 'c0'.repeat(19), ATT = '0x' + 'a' + ii + 'aa'.repeat(19), HOLDER = '0x' + 'b' + ii + 'bb'.repeat(19);
  await H.fund(CREATOR, 1000n * E); await H.fund(ATT, 100n * E); await H.fund(HOLDER, 100n * E);
  const token = (await H.call(CREATOR, s.factory, H.facAbi, 'create', ['T', 'T', 18, 1_000_000_000n * E])).out;
  const total = 1_000_000_000n * E, target = 5n * E;
  await H.call(CREATOR, token, H.tokAbi, 'approve', [s.curve, total]);
  await H.call(CREATOR, s.curve, H.curveAbi, 'createCurve', [token, 1n, total, target, 0n], 1n * E);
  await H.call(ATT, s.curve, H.curveAbi, 'buy', [token, 0n], 1n * E); // attacker holds some tokens
  await H.call(HOLDER, s.curve, H.curveAbi, 'buy', [token, 0n], 10n * E); // sells out, refund
  const pair = (await H.call(ATT, s.ufac, H.ufacAbi, 'createPair', [token, s.weth])).out;
  const wethIn = variant === 'big-skew' ? 1n * E : 1n;
  await H.call(ATT, s.weth, H.wethAbi, 'deposit', [], wethIn); await H.call(ATT, s.weth, H.wethAbi, 'transfer', [pair, wethIn]);
  if (variant !== 'weth-only') await H.call(ATT, token, H.tokAbi, 'transfer', [pair, 1n]);
  await H.call(ATT, pair, H.pairAbi, 'sync', []);
  let r = await H.call(HOLDER, s.curve, H.curveAbi, 'graduate', [token]);
  console.log(variant, 'plain graduate:', r.ok, r.reason);
  const resc = await H.deploy(HOLDER, R.evm.bytecode.object);
  await H.call(HOLDER, token, H.tokAbi, 'approve', [resc, 10n ** 30n]);
  r = await H.call(HOLDER, resc, R.abi, 'rescue', [s.curve, token, pair, s.weth, 10n ** 30n], 3n * E);
  const c = (await H.call(HOLDER, s.curve, H.curveAbi, 'curves', [token])).out;
  console.log(variant, 'atomic rescue+graduate:', r.ok, r.reason, 'status', c[0], 'gas', r.gas);
}
