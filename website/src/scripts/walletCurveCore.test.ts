import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import vectors from './__fixtures__/curveVectors.json';
import { LAUNCH_FEE_ADDRESS } from './walletLaunchCore';
import {
  outsideSupply,
  CURVE_ABORT_AFTER_SECS,
  CURVE_ACCOUNT_DISCRIMINATOR,
  CURVE_ACCOUNT_SIZE,
  CURVE_FEE_ADDRESS,
  CURVE_TARGET_PRESETS,
  CURVE_FEE_BPS,
  CURVE_PROGRAM_ID_DEVNET,
  CURVE_PROGRAM_ID_MAINNET,
  DEFAULT_CURVE_FORM,
  canAbort,
  canMigrate,
  curveFlagOn,
  curvePreview,
  curveProgressPercent,
  curveShareHash,
  parseCurveHash,
  curveProblems,
  curveProgramFor,
  deriveCurve,
  feeUp,
  leftoverAllowed,
  migrationArgs,
  minOut,
  parseCurveAccount,
  quoteBuy,
  quoteSell,
  solToLamports,
  startOf,
  summarise,
  validateCurve,
  type CurveMath,
  type CurveState,
} from './walletCurveCore';
import type { PoolToken } from './walletPoolCore';

const CREATOR = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const SOL = 1_000_000_000n;
const big = (s: string) => BigInt(s);
const stateOf = (s: { vSol: string; vTok: string; realSol: string; realTok: string }): CurveMath => ({ vSol: big(s.vSol), vTok: big(s.vTok), realSol: big(s.realSol), realTok: big(s.realTok) });

const token = (over: Partial<PoolToken> = {}): PoolToken => ({
  mint: MINT,
  decimals: 6,
  supply: 1_000_000_000_000_000n,
  mintAuthority: null,
  freezeAuthority: null,
  extensions: [18, 19],
  held: 1_000_000_000_000_000n,
  ...over,
});

describe('the maths matches the Rust crate that runs on chain', () => {
  it('derives the same split for every vector', () => {
    for (const v of vectors.derive) {
      const d = deriveCurve(big(v.total), big(v.target));
      if (v.out === null) expect(d).toBeNull();
      else expect(d).toEqual({ vSol0: big(v.out.vSol0), vTok0: big(v.out.vTok0), curveTokens: big(v.out.curveTokens), lpTokens: big(v.out.lpTokens) });
    }
  });

  it('replays every trade sequence to the lamport', () => {
    let steps = 0;
    for (const run of vectors.runs) {
      const d = deriveCurve(big(run.total), big(run.target))!;
      let c = startOf(d);
      for (const s of run.steps) {
        steps++;
        if (s.op === 'buyAllFresh') {
          const q = quoteBuy(startOf(d), big(s.amount), run.fee)!;
          expect(q).not.toBeNull();
          expect({ gross: q.gross, fee: q.fee, net: q.net, tokensOut: q.tokensOut, soldOut: q.soldOut }).toEqual({ gross: big(s.result!.gross), fee: big(s.result!.fee), net: big(s.result!.net), tokensOut: big(s.result!.tokensOut!), soldOut: s.result!.soldOut });
          expect(q.next).toEqual(stateOf(s.state));
          continue;
        }
        if (s.op === 'buy') {
          const q = quoteBuy(c, big(s.amount), run.fee);
          if (s.result === null) {
            expect(q).toBeNull();
            expect(c).toEqual(stateOf(s.state));
          } else {
            expect(q).not.toBeNull();
            expect({ gross: q!.gross, fee: q!.fee, net: q!.net, tokensOut: q!.tokensOut, soldOut: q!.soldOut }).toEqual({ gross: big(s.result.gross), fee: big(s.result.fee), net: big(s.result.net), tokensOut: big(s.result.tokensOut!), soldOut: s.result.soldOut });
            c = q!.next;
          }
        } else {
          const q = quoteSell(c, d.curveTokens, big(s.amount), run.fee);
          if (s.result === null) expect(q).toBeNull();
          else {
            expect(q).not.toBeNull();
            expect({ gross: q!.gross, fee: q!.fee, net: q!.net }).toEqual({ gross: big(s.result.gross), fee: big(s.result.fee), net: big(s.result.net) });
            c = q!.next;
          }
        }
        expect(c).toEqual(stateOf(s.state));
      }
    }
    expect(steps).toBeGreaterThan(100);
  });

  it('works out the pool arguments the same way the test harness for the program does', () => {
    for (const p of vectors.pool) {
      const a = migrationArgs(big(p.sol), big(p.tokens))!;
      expect(a).toEqual({ liquidity: big(p.liquidity), sqrtPrice: big(p.sqrtPrice) });
    }
  });
});

describe('the rules the program enforces, restated', () => {
  const d = deriveCurve(1_000_000_000_000_000n, 85n * SOL)!;
  it('keeps the two invariants through a run of trades', () => {
    let c = startOf(d);
    const k0 = c.vSol * c.vTok;
    for (const offer of [1n * SOL, 5n * SOL, 12n * SOL, 3n * SOL]) {
      const q = quoteBuy(c, offer, CURVE_FEE_BPS)!;
      c = q.next;
      expect(c.vSol - c.realSol).toBe(d.vSol0);
      expect(c.vSol * c.vTok >= k0).toBe(true);
    }
    const s = quoteSell(c, d.curveTokens, (d.curveTokens - c.realTok) / 3n, CURVE_FEE_BPS)!;
    expect(s.next.vSol - s.next.realSol).toBe(d.vSol0);
    expect(s.net).toBe(s.gross - s.fee);
  });
  it('charges the fee rounded up on both legs and never less than the rate', () => {
    expect(feeUp(1n, 100)).toBe(1n);
    expect(feeUp(10_000n, 100)).toBe(100n);
    expect(feeUp(10_001n, 100)).toBe(101n);
    const q = quoteBuy(startOf(d), 2n * SOL, CURVE_FEE_BPS)!;
    expect(q.fee).toBe(11_600_000n);
    expect(q.gross).toBe(q.fee + q.net);
  });
  it('cuts an oversized offer to what is left and charges only that', () => {
    const q = quoteBuy(startOf(d), 1_000n * SOL, CURVE_FEE_BPS)!;
    expect(q.soldOut).toBe(true);
    expect(q.tokensOut).toBe(d.curveTokens);
    expect(q.gross < 1_000n * SOL).toBe(true);
    expect(quoteBuy(q.next, SOL, CURVE_FEE_BPS)).toBeNull();
  });
  it('refuses dust, zero, a fee of 100%, and selling back more than was sold', () => {
    expect(quoteBuy(startOf(d), 0n, 100)).toBeNull();
    expect(quoteBuy(startOf(d), 1n, 100)).toBeNull();
    expect(quoteBuy(startOf(d), SOL, 10_000)).toBeNull();
    expect(quoteSell(startOf(d), d.curveTokens, 0n, 100)).toBeNull();
    expect(quoteSell(startOf(d), d.curveTokens, 1n, 100)).toBeNull();
  });
  it('splits 1,000,000,000 tokens and an 85 SOL target the way the design says', () => {
    expect(d.vSol0).toBe(30n * SOL);
    expect(d.lpTokens + d.curveTokens).toBe(1_000_000_000_000_000n);
    const s = summarise({ decimals: 6, targetLamports: 85n * SOL, derived: d }, 1_000_000_000_000_000n);
    expect(s.startPrice).toBe('0.000000027958412098');
    expect(s.startValue).toMatch(/^27.95/);
    expect(Number(s.endPrice) / Number(s.startPrice)).toBeCloseTo(14.7, 0);
    expect(s.raisesAbout).toBe('85');
  });
  it('says the pool may leave only 0.1% unspent', () => {
    expect(leftoverAllowed(1_000_000n, 1_000n)).toBe(true);
    expect(leftoverAllowed(1_000_000n, 1_001n)).toBe(false);
    expect(minOut(1_000_000n, 100)).toBe(990_000n);
  });
});

describe('what a creator may type', () => {
  const ok = (over: Partial<typeof DEFAULT_CURVE_FORM> = {}, t: PoolToken | null = token()) => validateCurve({ ...DEFAULT_CURVE_FORM, mint: MINT, tokenAmount: '1,000,000,000', target: '85', ...over }, CREATOR, t);
  it('accepts a good form and works out the split', () => {
    const v = ok();
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.config.totalRaw).toBe(1_000_000_000_000_000n);
      expect(v.config.targetLamports).toBe(85n * SOL);
      expect(v.config.firstBuyLamports).toBe(0n);
      expect(v.config.derived.lpTokens + v.config.derived.curveTokens).toBe(v.config.totalRaw);
    }
  });
  it('takes an optional first buy', () => {
    const v = ok({ firstBuy: '1.5' });
    expect(v.ok && v.config.firstBuyLamports).toBe(1_500_000_000n);
  });
  it('refuses what the program would refuse, with plain reasons', () => {
    const text = (v: ReturnType<typeof ok>) => (v.ok ? '' : v.issues.map((i) => i.message).join(' | '));
    expect(text(ok({}, token({ mintAuthority: CREATOR })))).toMatch(/create more/);
    expect(text(ok({}, token({ freezeAuthority: CREATOR })))).toMatch(/freeze/);
    expect(text(ok({}, token({ extensions: [18, 19, 1] })))).toMatch(/transfer fee/);
    expect(text(ok({}, null))).toMatch(/could not be read/);
    expect(text(ok({ tokenAmount: '1,000,000,001' }))).toMatch(/holds/);
    expect(text(ok({ tokenAmount: '0' }))).toMatch(/above zero/);
    expect(text(ok({ tokenAmount: '1.0000001' }))).toMatch(/decimal places/);
    expect(text(ok({ target: '0.05' }))).toMatch(/At least 0.1 SOL/);
    expect(text(ok({ target: 'abc' }))).toMatch(/SOL above zero/);
    expect(text(ok({ target: '2000000000' }))).toMatch(/More than a curve/);
    expect(text(ok({ firstBuy: '-1' }))).toMatch(/above zero/);
    expect(text(ok({ mint: 'nope' }))).toMatch(/valid token address/);
    expect(validateCurve({ ...DEFAULT_CURVE_FORM, mint: MINT, tokenAmount: '1', target: '85' }, '', token()).ok).toBe(false);
  });
  it('turns SOL text into lamports exactly', () => {
    expect(solToLamports('85')).toBe(85n * SOL);
    expect(solToLamports('0.000000001')).toBe(1n);
    expect(solToLamports('1e3')).toBeNull();
    expect(solToLamports('0')).toBeNull();
    expect(solToLamports('0.0000000001')).toBeNull();
  });
});

describe('the flag and the program address', () => {
  it('is on only for the exact text 1', () => {
    expect(curveFlagOn('1')).toBe(true);
    for (const f of [undefined, '', '0', 'true', 'yes', ' 1']) expect(curveFlagOn(f)).toBe(false);
  });
  it('has no mainnet program until one is audited and deployed', () => {
    expect(CURVE_PROGRAM_ID_MAINNET).toBeNull();
    expect(curveProgramFor('mainnet')).toBeNull();
    expect(curveProgramFor('devnet')).toBe(CURVE_PROGRAM_ID_DEVNET);
  });
  it('sends the fee to the management-fee wallet', () => {
    expect(CURVE_FEE_ADDRESS).toBe(LAUNCH_FEE_ADDRESS);
    expect(CURVE_FEE_ADDRESS).toBe('2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2');
  });
});

describe('the pool arguments', () => {
  it('fund both sides over the full range, with the pool price equal to the curve’s last price', () => {
    const d = deriveCurve(1_000_000_000_000_000n, 85n * SOL)!;
    const end = quoteBuy(startOf(d), 1_000n * SOL, 0)!.next;
    const a = migrationArgs(end.realSol, d.lpTokens)!;
    // sqrtPrice^2 / 2^128 is the SOL-per-token ratio of the pool: it must match the curve's own marginal price.
    const pool = Number((a.sqrtPrice * a.sqrtPrice * 10n ** 18n) >> 128n) / 1e18;
    const curve = Number((end.vSol * 10n ** 18n) / end.vTok) / 1e18;
    expect(Math.abs(pool - curve) / curve).toBeLessThan(1e-6);
    expect(a.liquidity > 0n).toBe(true);
  });
  it('refuses empty or absurd inputs', () => {
    expect(migrationArgs(0n, 1n)).toBeNull();
    expect(migrationArgs(1n, 0n)).toBeNull();
    expect(migrationArgs(1n, 1n << 120n)).toBeNull();
  });
});

describe('reading a curve account', () => {
  const key = (s: string) => new web3.PublicKey(s).toBytes();
  function account(over: { status?: number; vSol?: bigint; realSol?: bigint; realTok?: bigint; feeBps?: number } = {}): Uint8Array {
    const data = new Uint8Array(CURVE_ACCOUNT_SIZE);
    data.set(CURVE_ACCOUNT_DISCRIMINATOR, 0);
    const v = new DataView(data.buffer);
    let at = 8;
    data[at++] = 254; // bump
    data[at++] = 253; // sol bump
    data[at++] = over.status ?? 0;
    data.set(key(CREATOR), at); at += 32;
    data.set(key(MINT), at); at += 32;
    v.setUint16(at, over.feeBps ?? 58, true); at += 2;
    const u64 = (x: bigint) => { v.setBigUint64(at, x, true); at += 8; };
    u64(85n * SOL); // target
    u64(30n * SOL); // v_sol0
    u64(793_103_448_275_863n); // curve_tokens
    u64(206_896_551_724_137n); // lp_tokens
    u64(over.vSol ?? 30n * SOL); // v_sol
    u64(1_073_022_312_373_227n); // v_tok
    u64(over.realSol ?? 0n);
    u64(over.realTok ?? 793_103_448_275_863n);
    v.setBigInt64(at, 1_700_000_000n, true); at += 8;
    v.setBigInt64(at, 0n, true); at += 8;
    return data;
  }
  const read = (d: Uint8Array) => parseCurveAccount(web3, CURVE_PROGRAM_ID_DEVNET, CURVE_PROGRAM_ID_DEVNET, d);

  it('reads every field', () => {
    const c = read(account())!;
    expect(c).toMatchObject({ status: 'trading', creator: CREATOR, mint: MINT, feeBps: 58, target: 85n * SOL, vSol0: 30n * SOL, curveTokens: 793_103_448_275_863n, createdAt: 1_700_000_000n, pool: null, bump: 254, solBump: 253 });
    expect(curveProblems(c)).toEqual([]);
  });
  it('refuses another owner, another size, another discriminator, an unknown status', () => {
    expect(parseCurveAccount(web3, '11111111111111111111111111111111', CURVE_PROGRAM_ID_DEVNET, account())).toBeNull();
    expect(read(account().subarray(1))).toBeNull();
    const bad = account();
    bad[0] ^= 1;
    expect(read(bad)).toBeNull();
    expect(read(account({ status: 9 }))).toBeNull();
  });
  it('flags a curve whose reserves do not add up or whose fee is not the one shown', () => {
    expect(curveProblems(read(account({ vSol: 31n * SOL }))!).join(' ')).toMatch(/reserves/);
    expect(curveProblems(read(account({ realTok: 793_103_448_275_864n }))!).join(' ')).toMatch(/more tokens/);
    expect(curveProblems(read(account({ feeBps: 500 }))!).join(' ')).toMatch(/charges 5%/);
  });
  it('says when migrating and unwinding are allowed', () => {
    const sold = read(account({ status: 1, realTok: 0n }))!;
    const withSoldOut = (at: bigint): CurveState => ({ ...sold, soldOutAt: at });
    expect(canMigrate(sold)).toBe(true);
    expect(canMigrate(read(account())!)).toBe(false);
    expect(canAbort(withSoldOut(1_000n), 1_000 + CURVE_ABORT_AFTER_SECS - 1)).toBe(false);
    expect(canAbort(withSoldOut(1_000n), 1_000 + CURVE_ABORT_AFTER_SECS)).toBe(true);
    expect(canAbort(read(account())!, 4_000_000_000)).toBe(false);
  });
});

describe('what a creator sees while typing, and sharing', () => {
  const tok = { decimals: 6, supply: 1_000_000_000_000_000n };
  it('previews the split and the price rise, and needs nothing but the token and two numbers', () => {
    const p = curvePreview({ tokenAmount: '1,000,000,000', target: '85' }, tok)!;
    expect(p.curveTokens + p.lpTokens).toBe(1_000_000_000_000_000n);
    expect(p.startPrice).toBe('0.000000027958412098');
    expect(p.priceMultiple).toBe('14.7');
    expect(p.raisesAbout).toBe('85');
  });
  it('shows nothing until it can', () => {
    expect(curvePreview({ tokenAmount: '', target: '85' }, tok)).toBeNull();
    expect(curvePreview({ tokenAmount: '1,000', target: '' }, tok)).toBeNull();
    expect(curvePreview({ tokenAmount: '1,000', target: '0.01' }, tok)).toBeNull();
    expect(curvePreview({ tokenAmount: '1,000', target: '85' }, null)).toBeNull();
    expect(curvePreview({ tokenAmount: '0', target: '85' }, tok)).toBeNull();
  });
  it('offers targets that are all valid', () => {
    for (const t of CURVE_TARGET_PRESETS) expect(curvePreview({ tokenAmount: '1,000,000,000', target: t }, tok)).not.toBeNull();
  });
  it('rounds progress down and shows 100 only when sold out', () => {
    expect(curveProgressPercent({ curveTokens: 1000n, realTok: 1000n })).toBe(0);
    expect(curveProgressPercent({ curveTokens: 1000n, realTok: 501n })).toBe(49);
    expect(curveProgressPercent({ curveTokens: 1000n, realTok: 1n })).toBe(99);
    expect(curveProgressPercent({ curveTokens: 1000n, realTok: 0n })).toBe(100);
    expect(curveProgressPercent({ curveTokens: 0n, realTok: 0n })).toBe(0);
  });
  it('round-trips a share link and refuses anything else', () => {
    expect(parseCurveHash(curveShareHash(MINT))).toBe(MINT);
    for (const bad of ['', '#/launch', '#/launch/curve/', '#/launch/curve/nope', `#/launch/curve/${MINT}/x`, `#/swap/curve/${MINT}`, `#/launch/curve/${MINT}0`, '#/launch/curve/<script>']) expect(parseCurveHash(bad)).toBeNull();
  });
});

describe('M-3: supply outside the curve', () => {
  it('reports the share of supply that never went into the curve, and the opener\'s live share', () => {
    const c = { curveTokens: 600n, lpTokens: 300n };
    expect(outsideSupply(c, 1_000n, 100n)).toEqual({ outside: 100n, outsidePercent: '10', opener: 100n, openerPercent: '10' });
    expect(outsideSupply(c, 900n, 0n)).toEqual({ outside: 0n, outsidePercent: '0', opener: 0n, openerPercent: '0' });
    expect(outsideSupply(c, 900_000_001n, null).outsidePercent).toBe('100'); // rounded up, never shown smaller
    expect(outsideSupply({ curveTokens: 999_999n, lpTokens: 0n }, 1_000_000n, 1n)).toMatchObject({ outside: 1n, outsidePercent: '0.01', openerPercent: '0.01' }); // a sliver is never 0
    expect(outsideSupply(c, 1_234n, null).outsidePercent).toBe('27.07');
  });
});
