// Model fuzz (same arithmetic as AretiaCurve.sol) at extreme parameters: k never falls, vSol - realSol == vSol0, vTok - realTok const, sells never exceed realSol, round trip never profits.
const ceil = (a, b) => a / b + (a % b ? 1n : 0n); const F = 58n, B = 10000n;
let seed = 12345n; const rnd = (m) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return m === 0n ? 0n : seed % m; };
let viol = 0, steps = 0, rt = 0;
for (const [total, target] of [[5n, 10n ** 16n], [1000n, 10n ** 16n], [1n << 96n, 10n ** 24n], [1n << 96n, 10n ** 16n], [10n ** 27n, 5n * 10n ** 18n], [7n, 10n ** 24n]]) {
  const v0 = target * 6n / 17n, lp = total * v0 / (2n * v0 + target), c = total - lp; if (!lp) continue;
  const vT0 = ceil((v0 + target) * c, target); let m = { vS: v0, vT: vT0, rS: 0n, rT: c }; let owed = 0n, bal = 0n;
  for (let i = 0; i < 4000; i++, steps++) {
    const k = m.vS * m.vT;
    if (rnd(2n) === 0n && m.rT > 0n) {
      const off = 1n + rnd(target / (1n + rnd(50n)) + 2n); let fee = ceil(off * F, B); if (fee > off) fee = off; let net = off - fee; if (net === 0n) continue;
      let out = m.vT - ceil(k, m.vS + net), gross = off;
      if (out >= m.rT) { net = ceil(k, m.vT - m.rT) - m.vS; gross = ceil(net * B, B - F); fee = gross - net; out = m.rT; }
      if (out === 0n || gross > off) continue;
      // round trip check: sell `out` straight back
      const nVT = m.vT - out + out, nVS0 = m.vS + net; const back = nVS0 - ceil(nVS0 * (m.vT - out), nVT); if (back > net) { rt++; }
      m = { vS: m.vS + net, vT: m.vT - out, rS: m.rS + net, rT: m.rT - out }; owed += net; bal += net;
    } else {
      const sold = c - m.rT; if (sold === 0n) continue; const t = 1n + rnd(sold);
      const nVT = m.vT + t, nVS = ceil(k, nVT), gross = m.vS - nVS; if (gross > m.rS) { viol++; continue; }
      m = { vS: nVS, vT: nVT, rS: m.rS - gross, rT: m.rT + t }; owed -= gross; bal -= gross;
    }
    if (m.vS * m.vT < k || m.vS - m.rS !== v0 || m.vT - m.rT !== vT0 - c || bal < owed || m.rS < 0n) viol++;
  }
}
console.log({ steps, violations: viol, roundTripProfits: rt });
