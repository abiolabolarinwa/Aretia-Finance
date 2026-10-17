import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import vectors from './__fixtures__/aretiaPoolVectors.json';
import {
  DEFAULT_ARETIA_POOL_FORM,
  ARETIA_POOL_FEE_LAMPORTS,
  ARETIA_POOL_PROGRAM_ID_MAINNET,
  POOL_ACCOUNT_SIZE,
  POSITION_ACCOUNT_SIZE,
  addLiquidity,
  atTime,
  effectiveFeeBps,
  scheduleOk,
  LAUNCH_PROTECTION,
  aretiaPoolCost,
  aretiaPoolDisclosures,
  aretiaPoolFlagOn,
  aretiaPoolProgramFor,
  buy,
  claimable,
  feeUp,
  liquidityForPrice,
  minOut,
  openPool,
  parsePoolAccount,
  parsePositionAccount,
  pendingFee,
  priceText,
  protocolPart,
  removeLiquidity,
  sell,
  validateAretiaPool,
  type CreateParams,
  type PoolMath,
} from './walletAretiaPoolCore';
import { type PoolToken } from './walletPoolCore';

const CREATOR = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const token = (over: Partial<PoolToken> = {}): PoolToken => ({ mint: MINT, decimals: 6, supply: 1_000_000_000_000_000n, mintAuthority: null, freezeAuthority: null, extensions: [18, 19], held: 900_000_000_000_000n, ...over });
const form = (over = {}) => ({ ...DEFAULT_ARETIA_POOL_FORM, mint: MINT, tokenAmount: '600,000,000', price: '0.000000016667', ...over });
const st = (s: { x: string; y: string; l: string; acc: string; feeReserve: string }) => ({ x: BigInt(s.x), y: BigInt(s.y), l: BigInt(s.l), acc: BigInt(s.acc), feeReserve: BigInt(s.feeReserve) });

describe('the maths matches the Rust pool-math, step by step', () => {
  for (const [i, run] of vectors.runs.entries()) {
    it(`run ${i}: x0 ${run.x0}, y0 ${run.y0}, l0 ${run.l0}, fee ${run.fee} bps`, () => {
      let p: PoolMath = openPool(BigInt(run.x0), BigInt(run.y0), BigInt(run.l0), run.fee)!;
      expect(p).not.toBeNull();
      let refused = 0;
      for (const [n, step] of run.steps.entries()) {
        const amt = BigInt(step.amount);
        const want = step.result as Record<string, string> | null;
        const label = `step ${n} ${step.op} ${step.amount}`;
        let next: PoolMath | null = null;
        let got: Record<string, bigint> | null = null;
        if (step.op === 'buy') {
          const r = buy(p, amt);
          if (r) [next, got] = [r.next, { gross: r.result.gross, fee: r.result.fee, protocol: r.result.protocol, net: r.result.net, tokensOut: r.result.tokensOut }];
        } else if (step.op === 'sell') {
          const r = sell(p, amt);
          if (r) [next, got] = [r.next, { gross: r.result.gross, fee: r.result.fee, protocol: r.result.protocol, net: r.result.net }];
        } else if (step.op === 'add') {
          const r = addLiquidity(p, amt);
          if (r) [next, got] = [r.next, { tokensIn: r.tokensIn, solIn: r.solIn }];
        } else {
          const r = removeLiquidity(p, amt);
          if (r) [next, got] = [r.next, { tokensOut: r.tokensOut, solOut: r.solOut }];
        }
        if (want === null) {
          expect(got, label).toBeNull();
          refused += 1;
          continue;
        }
        expect(got, label).not.toBeNull();
        for (const [k, v] of Object.entries(want)) expect(got![k], `${label} ${k}`).toBe(BigInt(v));
        const wantState = st(step.state);
        expect({ x: next!.x, y: next!.y, l: next!.l, acc: next!.acc, feeReserve: next!.feeReserve }, label).toEqual(wantState);
        p = next!;
      }
      expect(run.steps.length - refused).toBeGreaterThan(10);
    });
  }

  it('fee claims, including a checkpoint behind a wrapped accumulator', () => {
    for (const c of vectors.claims) {
      expect(pendingFee(BigInt(c.shares), BigInt(c.acc), BigInt(c.checkpoint))).toBe(c.out === null ? null : BigInt(c.out));
    }
  });
});

describe('the launch fee schedule matches the Rust', () => {
  it('at every moment in the vectors', () => {
    expect(vectors.schedule.length).toBeGreaterThan(50);
    for (const c of vectors.schedule) expect(effectiveFeeBps(c.base, c.start, c.decay, BigInt(c.t0), BigInt(c.now)), JSON.stringify(c)).toBe(c.fee);
  });
  it('bounds a schedule as the program does', () => {
    expect(scheduleOk(25, 0, 0)).toBe(true);
    expect(scheduleOk(25, 2_500, 3_600)).toBe(true);
    for (const [s, d] of [[2_501, 600], [2_000, 3_601], [25, 600], [2_000, 0], [0, 600]] as const) expect(scheduleOk(25, s, d)).toBe(false);
    for (const p of Object.values(LAUNCH_PROTECTION)) expect(scheduleOk(25, p.startBps, p.decaySecs) && scheduleOk(100, p.startBps, p.decaySecs)).toBe(true);
  });
  it('a quote at launch uses the high fee and one later uses the base fee', () => {
    const p = { ...openPool(600_000_000_000_000n, 0n, 10_000_000_000n, 100)!, feeStartBps: 2_000, decaySecs: 600, startTs: 1_000n };
    expect(buy(atTime(p, 1_000n), 1_000_000_000n)!.result.fee).toBe(200_000_000n);
    expect(buy(atTime(p, 1_600n), 1_000_000_000n)!.result.fee).toBe(10_000_000n);
  });
});

describe('the rules', () => {
  it('open refuses what the program refuses', () => {
    expect(openPool(999n, 0n, 10_000_000n, 25)).toBeNull();
    expect(openPool(1000n, 0n, 9_999_999n, 25)).toBeNull();
    expect(openPool(1000n, 0n, 10_000_000n, 30)).toBeNull();
    expect(openPool(1n << 63n, 0n, 10_000_000n, 25)).toBeNull();
    expect(openPool(1000n, 0n, 10_000_000n, 100)).not.toBeNull();
  });
  it('fees are rounded up and split with Aretia keeping 20%', () => {
    expect(feeUp(1_000_000_000n, 25)).toBe(2_500_000n);
    expect(feeUp(1n, 25)).toBe(1n);
    expect(protocolPart(2_500_000n)).toBe(500_000n);
    expect(protocolPart(4n)).toBe(0n);
  });
  it('a pool made from tokens alone cannot be sold into', () => {
    const p = openPool(600_000_000_000_000n, 0n, 10_000_000_000n, 25)!;
    expect(sell(p, 1_000_000n)).toBeNull();
  });
  it('slippage floors round down', () => {
    expect(minOut(1_000n, 100)).toBe(990n);
    expect(minOut(1n, 100)).toBe(0n);
  });
  it('the price text is SOL per whole token', () => {
    // l0 = x0 * price: 600,000,000 tokens at 0.000000016667 SOL is about 10 SOL.
    const l0 = liquidityForPrice(600_000_000_000_000n, 6, '0.000000016667')!;
    expect(l0).toBe(10_000_200_000n);
    const p = openPool(600_000_000_000_000n, 0n, l0, 25)!;
    expect(priceText(p, 6)).toBe('0.000000016667');
  });
});

describe('liquidityForPrice', () => {
  it('one million tokens at 0.01 SOL is 10,000 SOL of liquidity', () => {
    expect(liquidityForPrice(1_000_000n * 10n ** 6n, 6, '0.01')).toBe(10_000n * 10n ** 9n);
    expect(liquidityForPrice(10n ** 6n, 6, '0.000000001')).toBe(1n);
    expect(liquidityForPrice(10n ** 6n, 6, '0.0000000001')).toBe(0n);
  });
  it('refuses text that is not a plain decimal', () => {
    for (const bad of ['', '1e5', '-1', '0x10', '1.1234567890123', ' 1', '1,5']) expect(liquidityForPrice(1000n, 6, bad)).toBeNull();
  });
});

describe('validateAretiaPool', () => {
  it('turns the form into the parameters the program is called with', () => {
    const v = validateAretiaPool(form(), CREATOR, token());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const p: CreateParams = v.params;
    expect(p).toEqual({ creator: CREATOR, mint: MINT, x0: 600_000_000_000_000n, y0: 0n, l0: 10_000_200_000n, feeBps: 25, lock: true, sniperBps: 1000, decaySecs: 300 });
  });
  it('keeps the Meteora form’s refusals', () => {
    for (const t of [token({ mintAuthority: CREATOR }), token({ freezeAuthority: CREATOR }), token({ extensions: [18, 19, 1] }), token({ extensions: [14] }), token({ extensions: [12] })]) {
      const v = validateAretiaPool(form(), CREATOR, t);
      expect(v.ok).toBe(false);
    }
    expect(validateAretiaPool(form({ tradingFeeBps: '30' }), CREATOR, token()).ok).toBe(false);
    expect(validateAretiaPool(form({ tokenAmount: '1,000,000,000,000' }), CREATOR, token()).ok).toBe(false);
  });
  it('adds the program’s limits on size and price', () => {
    const tiny = validateAretiaPool(form({ tokenAmount: '1', price: '0.000001' }), CREATOR, token());
    expect(tiny.ok).toBe(false);
    if (!tiny.ok) expect(tiny.issues.map((i) => i.field)).toContain('price');
    expect(validateAretiaPool(form({ tokenAmount: '0.0005', price: '1' }), CREATOR, token()).ok).toBe(false);
  });
  it('asks for the launch protection chosen, and drops it when the trading fee is as high', () => {
    for (const [choice, start, decay] of [['off', 0, 0], ['standard', 1000, 300], ['strong', 2500, 900]] as const) {
      const v = validateAretiaPool(form({ launchProtection: choice }), CREATOR, token());
      expect(v.ok && [v.params.sniperBps, v.params.decaySecs]).toEqual([start, decay]);
    }
  });
  it('can lock or not lock', () => {
    const v = validateAretiaPool(form({ lockLiquidity: false }), CREATOR, token());
    expect(v.ok && v.params.lock).toBe(false);
  });
});

describe('the flag, the program and the words', () => {
  it('is off unless the flag is exactly "1", and has no mainnet program', () => {
    for (const f of [undefined, '', '0', 'true', 'yes', '1 ']) expect(aretiaPoolFlagOn(f)).toBe(false);
    expect(aretiaPoolFlagOn('1')).toBe(true);
    expect(ARETIA_POOL_PROGRAM_ID_MAINNET).toBeNull();
    expect(aretiaPoolProgramFor('mainnet')).toBeNull();
    expect(aretiaPoolProgramFor('devnet')).toBe(vectors.program);
  });
  it('the cost shows Aretia’s fee first and adds up', () => {
    const c = aretiaPoolCost(7_000_000n);
    expect(c).toEqual({ aretiaFee: ARETIA_POOL_FEE_LAMPORTS, network: 7_000_000n, total: 57_000_000n });
  });
  it('never calls a pool safe, says it is unaudited, and says what the lock and the split mean', () => {
    const params: CreateParams = { creator: CREATOR, mint: MINT, x0: 1n, y0: 0n, l0: 1n, feeBps: 100, lock: true, sniperBps: 2500, decaySecs: 900 };
    const text = aretiaPoolDisclosures(params).map((d) => d.text).join(' ');
    expect(text).toMatch(/not been independently audited/);
    expect(text).toMatch(/locked for good/);
    expect(text).toMatch(/Aretia keeps 20%/);
    expect(text).toMatch(/Jupiter/);
    expect(text).not.toMatch(/\bsafe\b/i);
    expect(aretiaPoolDisclosures({ ...params, lock: false }).map((d) => d.text).join(' ')).toMatch(/not locked/);
  });
});

describe('reading the program’s accounts', () => {
  const b58 = (bytes: Uint8Array) => new web3.PublicKey(bytes).toBase58();
  const poolBytes = () => {
    const d = new Uint8Array(POOL_ACCOUNT_SIZE);
    d.set([241, 154, 109, 4, 17, 177, 109, 188], 0);
    d[8] = 254;
    d[9] = 253;
    d.set(new web3.PublicKey(MINT).toBytes(), 10);
    d.set(new web3.PublicKey(CREATOR).toBytes(), 42);
    const v = new DataView(d.buffer);
    v.setUint16(74, 100, true);
    v.setBigUint64(76, 5_000n, true);
    v.setBigUint64(84, 6_000n, true);
    v.setBigUint64(92, 7_000n, true);
    v.setBigUint64(100, 9n, true);
    v.setBigUint64(108, 1n, true);
    v.setBigUint64(116, 42n, true);
    v.setBigInt64(124, 1_700_000_000n, true);
    v.setUint16(132, 2_000, true);
    v.setUint32(134, 600, true);
    return d;
  };
  it('reads the pool', () => {
    const p = parsePoolAccount(poolBytes(), b58)!;
    expect(p).toMatchObject({ bump: 254, solBump: 253, mint: MINT, creator: CREATOR, feeBps: 100, x: 5000n, y: 6000n, l: 7000n, feeReserve: 42n, createdAt: 1_700_000_000n, feeStartBps: 2000, decaySecs: 600 });
    expect(p.acc).toBe(9n + (1n << 64n));
  });
  it('refuses data that is the wrong size or the wrong account type', () => {
    expect(parsePoolAccount(new Uint8Array(POOL_ACCOUNT_SIZE), b58)).toBeNull();
    expect(parsePoolAccount(poolBytes().subarray(0, POOL_ACCOUNT_SIZE - 1), b58)).toBeNull();
    expect(parsePositionAccount(poolBytes(), b58)).toBeNull();
    expect(parsePositionAccount(new Uint8Array(POSITION_ACCOUNT_SIZE), b58)).toBeNull();
  });
  it('knows what a position can claim, including fees not yet written to it', () => {
    const p = parsePoolAccount(poolBytes(), b58)!;
    const pos = { pool: '', owner: CREATOR, shares: 1_000n, locked: 1_000n, checkpoint: 0n, pending: 5n, recipient: CREATOR };
    // acc = 9 + 2^64; shares * acc >> 64 = 1000 + (9000 >> 64 = 0)
    expect(claimable(p, pos)).toBe(1_005n);
  });
});
