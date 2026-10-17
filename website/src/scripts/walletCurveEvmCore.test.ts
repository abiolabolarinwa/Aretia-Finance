import { describe, expect, it } from 'vitest';
import { deriveCurve, quoteBuy, quoteSell } from './walletCurveCore';
import {
  DEFAULT_EVM_CURVE_FORM,
  EVM_CURVE_ADDRESSES,
  EVM_FEE_BPS,
  EVM_MAX_TARGET_WEI,
  EVM_MIN_TARGET_WEI,
  EVM_TARGET_PRESETS,
  coinToWei,
  createAddress,
  evmCanAbort,
  evmCanGraduate,
  evmCurveChain,
  evmCurvePreview,
  evmCurveProblems,
  evmCurveShareHash,
  evmDerive,
  evmFeeUp,
  evmMinOut,
  evmQuoteBuy,
  evmQuoteSell,
  evmStart,
  findFactoryNonce,
  parseCurveReturn,
  parseEvmCurveHash,
  validateEvmCurve,
  type EvmCurveState,
  type EvmCurveToken,
} from './walletCurveEvmCore';
import { LAUNCH_EVM_CHAINS } from './walletLaunchEvmCore';

const ETH = 10n ** 18n;
const CREATOR = '0x00000000000000000000000000000000000c0de1';
const TOKEN = '0x1111111111111111111111111111111111111111';
const FACTORY = LAUNCH_EVM_CHAINS.find((c) => c.key === 'ethereum')!.factory!;
const CURVE = '0x2222222222222222222222222222222222222222';
const ADDRESSES = { ethereum: CURVE };

describe('the maths agrees with the Solana curve (which agrees with the Rust crate) wherever both can run', () => {
  it('on derivation, buys and sells at amounts small enough for 64 bits', () => {
    for (const [total, target] of [[1_000_000_000_000_000n, 85_000_000_000n], [777_000_000_000n, 3_000_000_000n]] as const) {
      // The Solana core has a lower floor on the target; the EVM floor only matters for the validation, so use the raw derivation.
      const a = deriveCurve(total, target)!;
      const b = (() => {
        const vSol0 = (target * 6n) / 17n;
        const lp = (total * vSol0) / (2n * vSol0 + target);
        const c = total - lp;
        return { vSol0, curveTokens: c, lpTokens: lp, vTok0: (((vSol0 + target) * c + target - 1n) / target) };
      })();
      expect(a).toEqual({ vSol0: b.vSol0, vTok0: b.vTok0, curveTokens: b.curveTokens, lpTokens: b.lpTokens });
      let sa = { vSol: a.vSol0, vTok: a.vTok0, realSol: 0n, realTok: a.curveTokens };
      let sb = { ...sa };
      for (const offer of [target / 9n, target / 4n, target / 7n, target * 3n]) {
        const qa = quoteBuy(sa, offer, EVM_FEE_BPS);
        const qb = evmQuoteBuy(sb, offer);
        expect(qa === null).toBe(qb === null);
        if (qa && qb) {
          expect([qa.gross, qa.fee, qa.net, qa.tokensOut, qa.soldOut]).toEqual([qb.gross, qb.fee, qb.net, qb.tokensOut, qb.soldOut]);
          sa = qa.next;
          sb = qb.next;
        }
      }
      const tokens = (a.curveTokens - sb.realTok) / 3n;
      const ra = quoteSell(sa, a.curveTokens, tokens, EVM_FEE_BPS);
      const rb = evmQuoteSell(sb, a.curveTokens, tokens);
      expect(ra === null).toBe(rb === null);
      if (ra && rb) expect([ra.gross, ra.fee, ra.net]).toEqual([rb.gross, rb.fee, rb.net]);
    }
  });

  it('has no 64-bit limit: a 3 ETH curve over a billion 18-decimal tokens works', () => {
    const d = evmDerive(10n ** 27n, 3n * ETH)!;
    expect(d.curveTokens + d.lpTokens).toBe(10n ** 27n);
    const q = evmQuoteBuy(evmStart(d), 100n * ETH)!;
    expect(q.soldOut).toBe(true);
    expect(q.gross < 100n * ETH).toBe(true);
    expect(q.next.realSol > 3n * ETH - 10n && q.next.realSol < 3n * ETH + 10n).toBe(true);
  });

  it('refuses what the contract refuses', () => {
    expect(evmDerive(0n, 3n * ETH)).toBeNull();
    expect(evmDerive(1n << 97n, 3n * ETH)).toBeNull();
    expect(evmDerive(10n ** 27n, EVM_MIN_TARGET_WEI - 1n)).toBeNull();
    expect(evmDerive(10n ** 27n, EVM_MAX_TARGET_WEI + 1n)).toBeNull();
    const d = evmDerive(10n ** 27n, 3n * ETH)!;
    expect(evmQuoteBuy(evmStart(d), 0n)).toBeNull();
    expect(evmQuoteBuy(evmStart(d), 1n)).toBeNull();
    expect(evmQuoteSell(evmStart(d), d.curveTokens, 1n)).toBeNull();
    expect(evmFeeUp(10_000n)).toBe(58n);
    expect(evmFeeUp(10_001n)).toBe(59n);
    expect(evmMinOut(1_000_000n, 100)).toBe(990_000n);
  });
});

describe('proving a token came from the factory', () => {
  it('computes the addresses CREATE makes, for the well-known example sequence', () => {
    const deployer = '0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0';
    expect(createAddress(deployer, 0n)).toBe('0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d');
    expect(createAddress(deployer, 1n)).toBe('0x343c43a37d37dff08ae8c4a11544c718abb4fcf8');
    expect(createAddress(deployer, 2n)).toBe('0xf778b86fa74e846c4f0a1fbd1335fe81c00a0c91');
    expect(createAddress(deployer, 3n)).toBe('0xfffd933a0bc612844eaf0c6fe3e5b8e9b6c1d19c');
  });
  it('finds the nonce of a token the factory made, newest first, and nothing for any other address', () => {
    const next = 40n;
    const token = createAddress(FACTORY, 17n);
    expect(findFactoryNonce(FACTORY, token, next)).toBe(17n);
    expect(findFactoryNonce(FACTORY, createAddress(FACTORY, 39n), next)).toBe(39n);
    expect(findFactoryNonce(FACTORY, createAddress(FACTORY, 1n), next)).toBe(1n);
    expect(findFactoryNonce(FACTORY, TOKEN, next)).toBeNull();
    // A token from a later nonce than the factory has reached is not found.
    expect(findFactoryNonce(FACTORY, createAddress(FACTORY, 41n), next)).toBeNull();
    // Another deployer's address with the same nonce is not the factory's.
    expect(findFactoryNonce(FACTORY, createAddress(CURVE, 17n), next)).toBeNull();
    // A limit stops a long search.
    expect(findFactoryNonce(FACTORY, createAddress(FACTORY, 1n), 1000n, 10n)).toBeNull();
  });
});

describe('the contract’s answer and what is derived from it', () => {
  const state = (over: Partial<Record<number, bigint>> = {}): string => {
    const d = evmDerive(10n ** 27n, 3n * ETH)!;
    const words = [1n, BigInt(CREATOR), 1_700_000_000n, 0n, 58n, 3n * ETH, d.vSol0, d.curveTokens, d.lpTokens, d.vSol0, d.vTok0, 0n, d.curveTokens];
    for (const [i, v] of Object.entries(over)) words[Number(i)] = v!;
    return '0x' + words.map((w) => w.toString(16).padStart(64, '0')).join('');
  };
  it('reads every field', () => {
    const c = parseCurveReturn(state())!;
    expect(c).toMatchObject({ status: 'trading', creator: CREATOR, feeBps: 58n, target: 3n * ETH, realSol: 0n });
    expect(evmCurveProblems(c)).toEqual([]);
  });
  it('refuses a wrong length, an unknown status, and a creator that is not an address', () => {
    expect(parseCurveReturn('0x')).toBeNull();
    expect(parseCurveReturn(state().slice(0, -2))).toBeNull();
    expect(parseCurveReturn(state({ 0: 9n }))).toBeNull();
    expect(parseCurveReturn(state({ 1: 1n << 200n }))).toBeNull();
    expect(parseCurveReturn(undefined)).toBeNull();
  });
  it('flags reserves that do not add up and a fee other than the one shown', () => {
    expect(evmCurveProblems(parseCurveReturn(state({ 9: 1n }))!).join(' ')).toMatch(/reserves/);
    expect(evmCurveProblems(parseCurveReturn(state({ 4: 500n }))!).join(' ')).toMatch(/charges 5%/);
    expect(evmCurveProblems(parseCurveReturn(state({ 12: 10n ** 30n }))!).join(' ')).toMatch(/more tokens/);
  });
  it('says when graduating and unwinding are allowed', () => {
    const sold = parseCurveReturn(state({ 0: 2n, 12: 0n, 3: 1_000n }))! as EvmCurveState;
    expect(evmCanGraduate(sold)).toBe(true);
    expect(evmCanGraduate(parseCurveReturn(state())!)).toBe(false);
    expect(evmCanAbort(sold, 1_000 + 7 * 86400 - 1)).toBe(false);
    expect(evmCanAbort(sold, 1_000 + 7 * 86400)).toBe(true);
    expect(evmCanAbort(parseCurveReturn(state())!, 4_000_000_000)).toBe(false);
  });
});

describe('what a creator may type', () => {
  const tokenInfo = (over: Partial<EvmCurveToken> = {}): EvmCurveToken => ({ address: TOKEN, name: 'Test', symbol: 'TST', decimals: 18, supply: 10n ** 27n, held: 10n ** 27n, factoryNonce: 5n, ...over });
  const ok = (over: Partial<typeof DEFAULT_EVM_CURVE_FORM> = {}, t: EvmCurveToken | null = tokenInfo()) =>
    validateEvmCurve({ ...DEFAULT_EVM_CURVE_FORM, token: TOKEN, tokenAmount: '1,000,000,000', target: '3', ...over }, CREATOR, t);
  // The chain table is empty today, so these tests supply a deployed one the way a real deployment would.
  const withCurve = async <T,>(f: () => T): Promise<T> => {
    const saved = EVM_CURVE_ADDRESSES as Record<string, string | null>;
    const before = { ...saved };
    saved.ethereum = CURVE;
    try {
      return f();
    } finally {
      Object.assign(saved, before);
    }
  };

  it('has the verified Ethereum and BNB Chain curves and none anywhere else', () => {
    expect(EVM_CURVE_ADDRESSES.ethereum).toBe('0x4e85bc5bd6f08fa87ceb749372e34226556837e8');
    expect(EVM_CURVE_ADDRESSES.bnb).toBe('0x4e85bc5bd6f08fa87ceb749372e34226556837e8');
    expect(EVM_CURVE_ADDRESSES.polygon).toBeNull();
    expect(evmCurveChain('ethereum')?.curve).toBe('0x4e85bc5bd6f08fa87ceb749372e34226556837e8');
    expect(evmCurveChain('bnb')?.curve).toBe('0x4e85bc5bd6f08fa87ceb749372e34226556837e8');
    expect(evmCurveChain('polygon')).toBeNull();
    expect(evmCurveChain('nowhere')).toBeNull();
    // A network with no deployed curve is still refused, with the plain message.
    const v = ok({ chain: 'polygon' });
    expect(v.ok).toBe(false);
    expect(v.ok ? '' : v.issues.map((i) => i.message).join(' ')).toMatch(/not available on this network yet/);
  });
  it('builds the chain only when its address, factory and exchange are all known', () => {
    const c = evmCurveChain('ethereum', ADDRESSES)!;
    expect(c).toMatchObject({ curve: CURVE, chainId: 1, factory: FACTORY, symbol: 'ETH' });
    expect(c.dex.router).toBe('0x7a250d5630b4cf539739df2c5dacb4c659f2488d');
    expect(evmCurveChain('ethereum', { ethereum: 'nope' })).toBeNull();
    expect(evmCurveChain('ethereum', { ethereum: null })).toBeNull();
    expect(evmCurveChain('sepolia', { sepolia: CURVE })).toBeNull();
  });
  it('accepts a good form and works out the split', async () => {
    await withCurve(() => {
      const v = ok();
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.config.totalRaw).toBe(10n ** 27n);
        expect(v.config.targetWei).toBe(3n * ETH);
        expect(v.config.factoryNonce).toBe(5n);
        expect(v.config.derived.curveTokens + v.config.derived.lpTokens).toBe(10n ** 27n);
      }
    });
  });
  it('refuses what the contract would refuse, with plain reasons', async () => {
    await withCurve(() => {
      const text = (v: ReturnType<typeof ok>) => (v.ok ? '' : v.issues.map((i) => i.message).join(' | '));
      expect(text(ok({}, tokenInfo({ factoryNonce: null })))).toMatch(/not made by Aretia’s token factory/);
      expect(text(ok({}, null))).toMatch(/could not be read/);
      expect(text(ok({ tokenAmount: '1,000,000,001' }))).toMatch(/holds/);
      expect(text(ok({ tokenAmount: '0' }))).toMatch(/above zero/);
      expect(text(ok({ tokenAmount: '1.0000000000000000001' }))).toMatch(/decimal places/);
      expect(text(ok({ target: '0.001' }))).toMatch(/At least 0.01/);
      expect(text(ok({ target: 'abc' }))).toMatch(/above zero/);
      expect(text(ok({ target: '2000000' }))).toMatch(/More than a curve/);
      expect(text(ok({ firstBuy: '-1' }))).toMatch(/above zero/);
      expect(text(ok({ token: 'nope' }))).toMatch(/valid token address/);
      expect(validateEvmCurve({ ...DEFAULT_EVM_CURVE_FORM, token: TOKEN, tokenAmount: '1', target: '3' }, '', tokenInfo()).ok).toBe(false);
    });
  });
  it('takes an optional first buy', async () => {
    await withCurve(() => {
      const v = ok({ firstBuy: '0.5' });
      expect(v.ok && v.config.firstBuyWei).toBe(ETH / 2n);
    });
  });
  it('turns coin text into wei exactly', () => {
    expect(coinToWei('3')).toBe(3n * ETH);
    expect(coinToWei('0.000000000000000001')).toBe(1n);
    expect(coinToWei('1e3')).toBeNull();
    expect(coinToWei('0')).toBeNull();
  });
});

describe('the live preview and sharing', () => {
  const tok = { decimals: 18, supply: 10n ** 27n };
  it('previews the split and the price rise', () => {
    const p = evmCurvePreview({ tokenAmount: '1,000,000,000', target: '5' }, tok)!;
    expect(p.curveTokens + p.lpTokens).toBe(10n ** 27n);
    expect(p.priceMultiple).toBe('14.7');
    expect(Number(p.endPrice) / Number(p.startPrice)).toBeCloseTo(14.7, 0);
  });
  it('shows nothing until it can, and every preset works', () => {
    expect(evmCurvePreview({ tokenAmount: '', target: '5' }, tok)).toBeNull();
    expect(evmCurvePreview({ tokenAmount: '1,000', target: '0.001' }, tok)).toBeNull();
    expect(evmCurvePreview({ tokenAmount: '1,000', target: '5' }, null)).toBeNull();
    for (const t of EVM_TARGET_PRESETS) expect(evmCurvePreview({ tokenAmount: '1,000,000,000', target: t }, tok)).not.toBeNull();
  });
  it('round-trips a share link and refuses anything else', () => {
    expect(parseEvmCurveHash(evmCurveShareHash('ethereum', TOKEN))).toEqual({ chain: 'ethereum', token: TOKEN });
    for (const bad of ['', '#/launch/curve/evm/ethereum/', `#/launch/curve/evm/nowhere/${TOKEN}`, '#/launch/curve/evm/ethereum/0x12', `#/launch/curve/evm/ethereum/${TOKEN}/x`, `#/launch/curve/ethereum/${TOKEN}`]) expect(parseEvmCurveHash(bad)).toBeNull();
  });
});
