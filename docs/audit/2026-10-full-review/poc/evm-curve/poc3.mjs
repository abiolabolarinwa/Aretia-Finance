import * as H from './harness.mjs';
const E = 10n ** 18n;
const s = await H.setup(7);
const CR = '0x' + 'c7'.repeat(20), B1 = '0x' + 'b7'.repeat(20);
await H.fund(CR, 100n * E); await H.fund(B1, 100n * E);
// (a) creator keeps 90% of supply outside the curve and drains buyers
const token = (await H.call(CR, s.factory, H.facAbi, 'create', ['R', 'R', 18, 1_000_000_000n * E])).out;
const total = 100_000_000n * E;
await H.call(CR, token, H.tokAbi, 'approve', [s.curve, total]);
let r = await H.call(CR, s.curve, H.curveAbi, 'createCurve', [token, 1n, total, 5n * E, 0n]); console.log('create', r.ok, r.reason);
r = await H.call(B1, s.curve, H.curveAbi, 'buy', [token, 0n], 3n * E); console.log('buyer pays 3 ETH', r.ok);
let c = (await H.call(CR, s.curve, H.curveAbi, 'curves', [token])).out; const sold = c[7] - c[12]; console.log('sold', sold / E, 'realSol', c[11]);
const before = (await H.vm.stateManager.getAccount(H.addr(CR))).balance;
await H.call(CR, token, H.tokAbi, 'approve', [s.curve, sold]);
r = await H.call(CR, s.curve, H.curveAbi, 'sell', [token, sold, 0n]); console.log('creator sells outside-curve tokens', r.ok, r.reason);
const after = (await H.vm.stateManager.getAccount(H.addr(CR))).balance; c = (await H.call(CR, s.curve, H.curveAbi, 'curves', [token])).out;
console.log('creator received wei', after - before, 'curve realSol left', c[11], 'buyer tokens now worth (sell quote) ~0');
r = await H.call(B1, s.curve, H.curveAbi, 'quoteBuy', [token, 0n]); console.log('quoteBuy(token,0) ->', r.ok, r.reason);
// (b) low-decimals token: curve's last marginal price vs pool opening price
const ceil = (a, b) => a / b + (a % b ? 1n : 0n);
for (const [tot, tgt] of [[5n, 10n ** 16n], [20n, 10n ** 16n], [1000n, 10n ** 16n], [10n ** 6n, 10n ** 16n]]) {
  const v0 = tgt * 6n / 17n, lp = tot * v0 / (2n * v0 + tgt), cc = tot - lp; if (!lp) { console.log(tot, 'split fails'); continue; }
  const vT0 = ceil((v0 + tgt) * cc, tgt); const k = v0 * vT0; const vTe = vT0 - cc; const vSe = ceil(k, vTe); const raised = vSe - v0;
  const curveLast = Number(vSe) / Number(vTe), pool = Number(raised) / Number(lp);
  console.log(`total=${tot} lp=${lp} c=${cc} raised=${raised} (target ${tgt}) curveEndPrice=${curveLast.toExponential(4)} poolPrice=${pool.toExponential(4)} gap=${((pool / curveLast - 1) * 100).toFixed(2)}%`);
}
