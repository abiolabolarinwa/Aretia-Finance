import { describe, expect, it } from 'vitest';
import { LAUNCH_EVM_CHAINS } from './walletLaunchEvmCore';
import { createAddress } from './walletCurveEvmCore';
import {
  DEFAULT_EVM_POOL_FORM,
  EVM_POOL_ADDRESSES,
  evmMaxIn,
  evmMinOut,
  evmPoolChain,
  evmPoolDisclosures,
  evmPoolPreview,
  evmPoolShareHash,
  lockTextOf,
  lockedShareText,
  lockedShareBps,
  parseEvmPoolHash,
  parsePoolReturn,
  parsePositionReturn,
  poolClaimable,
  poolPriceText,
  poolProblems,
  poolQuoteAdd,
  poolQuoteBuy,
  poolQuoteRemove,
  poolQuoteSell,
  splitFee,
  startL,
  validateEvmPool,
  type EvmPoolForm,
  type EvmPoolMath,
  type EvmPoolToken,
} from './walletAretiaPoolEvmCore';

const ETH = 10n ** 18n;
const CREATOR = '0x00000000000000000000000000000000000c0de1';
const POOL = '0x2222222222222222222222222222222222222222';
const addresses = { ethereum: POOL, bnb: POOL, polygon: POOL } as const;
const chain = evmPoolChain('ethereum', addresses)!;
const token = (over: Partial<EvmPoolToken> = {}): EvmPoolToken => ({ address: createAddress(chain.factory, 4n), name: 'Test', symbol: 'TST', decimals: 18, supply: 10n ** 27n, held: 10n ** 27n, factoryNonce: 4n, ...over });
const form = (over: Partial<EvmPoolForm> = {}): EvmPoolForm => ({ ...DEFAULT_EVM_POOL_FORM, token: token().address, tokenAmount: '1,000,000,000', startPrice: '0.00000001', ...over });
const w32 = (n: bigint) => n.toString(16).padStart(64, '0');

describe('the chain table', () => {
  it('has a pool address on BNB Chain, Polygon and Ethereum (the verified mainnet deployments); none elsewhere (the old Sepolia deployment speaks the old ABI)', () => {
    const { ethereum, bnb, polygon, sepolia, ...others } = EVM_POOL_ADDRESSES;
    expect([bnb, polygon, ethereum]).toEqual(['0x195fa7d999f567c8e198e961da8270911905753c', '0x195fa7d999f567c8e198e961da8270911905753c', '0x195fa7d999f567c8e198e961da8270911905753c']);
    expect(Object.values(others).every((a) => a === null)).toBe(true);
    expect(sepolia).toBeNull();
    for (const k of ['ethereum', 'bnb', 'polygon']) expect(evmPoolChain(k)?.pool).toBe('0x195fa7d999f567c8e198e961da8270911905753c');
    expect(evmPoolChain('sepolia')).toBeNull();
  });
  it('takes each chain’s creation fee from the token-creation fee and the fee address from the same table', () => {
    for (const [key, fee] of [['ethereum', 42n * 10n ** 14n], ['bnb', 14n * 10n ** 15n], ['polygon', 105n * ETH]] as const) {
      const c = evmPoolChain(key, addresses)!;
      expect(c.creationFee).toBe(fee);
      expect(c.creationFee).toBe(LAUNCH_EVM_CHAINS.find((l) => l.key === key)!.feeWei);
      expect(c.feeAddress).toBe('0xeb8725e16e504036c2166aa47804d88ecc4d0945');
    }
  });
  it('is off for a chain without a factory or with a malformed address', () => {
    expect(evmPoolChain('bscTestnet', { bscTestnet: POOL })).toBeNull(); // no factory written for that testnet yet
    expect(evmPoolChain('sepolia', { sepolia: POOL }, { sepolia: '0x3333333333333333333333333333333333333333' })).not.toBeNull();
    expect(evmPoolChain('ethereum', { ethereum: '0x12' })).toBeNull();
    expect(evmPoolChain('base', addresses)).toBeNull();
  });
});

describe('the fee split', () => {
  it('always sums to the fee exactly and gives Aretia 20% rounded down', () => {
    for (const fee of [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 99n, 100n, 10n ** 18n + 1n, 2n ** 111n - 1n]) {
      const s = splitFee(fee);
      expect(s.protocol + s.lp).toBe(fee);
      expect(s.protocol).toBe((fee * 2n) / 10n);
    }
  });
});

describe('the maths', () => {
  const m: EvmPoolMath = { feeBps: 25n, x: 10n ** 27n, y: 0n, l: 10n * ETH, acc: 0n, feeReserve: 0n };
  it('a buy: fee up first, tokens down, the fee split and the new reserves', () => {
    const q = poolQuoteBuy(m, ETH)!;
    expect(q.fee).toBe((ETH * 25n + 9999n) / 10_000n);
    expect(q.net).toBe(ETH - q.fee);
    expect(q.protocol + q.lp).toBe(q.fee);
    expect(q.next.y).toBe(q.net);
    expect(q.next.x).toBe(m.x - q.tokensOut);
    expect(q.next.feeReserve).toBe(q.lp);
    expect(q.next.x * (q.next.y + q.next.l)).toBeGreaterThanOrEqual(m.x * (m.y + m.l));
    expect(poolQuoteBuy(m, 0n)).toBeNull();
    expect(poolQuoteBuy(m, 1n << 112n)).toBeNull();
  });
  it('a sale only pays coin the pool really holds and never more than the buyer paid, round trip included', () => {
    expect(poolQuoteSell(m, 10n ** 20n)).toBeNull(); // nothing paid in yet
    const b = poolQuoteBuy(m, 3n * ETH)!;
    const s = poolQuoteSell(b.next, b.tokensOut)!;
    expect(s.net).toBeLessThan(3n * ETH);
    expect(s.next.y).toBeGreaterThanOrEqual(0n);
    expect(s.gross).toBeLessThanOrEqual(b.next.y);
    expect(poolQuoteSell(b.next, b.tokensOut * 1000n)).toBeNull();
  });
  it('liquidity: deposits round up, withdrawals round down, the last liquidity stays', () => {
    const b = poolQuoteBuy(m, 3n * ETH)!.next;
    const a = poolQuoteAdd(b, 12_345_678_901n)!;
    expect(a.tokens * b.l).toBeGreaterThanOrEqual(b.x * 12_345_678_901n);
    expect(a.coin * b.l).toBeGreaterThanOrEqual(b.y * 12_345_678_901n);
    const r = poolQuoteRemove(a.next, 12_345_678_901n)!;
    expect(r.tokens).toBeLessThanOrEqual(a.tokens);
    expect(r.coin).toBeLessThanOrEqual(a.coin);
    expect(poolQuoteAdd(b, 999n)).toBeNull();
    expect(poolQuoteRemove(b, b.l - 10n ** 12n + 1n)).toBeNull();
    expect(poolQuoteRemove(b, b.l - 10n ** 12n)).not.toBeNull();
  });
  it('claimable fees are settled plus accrued, rounded down', () => {
    const b = poolQuoteBuy(m, 5n * ETH)!;
    const pos = { open: true, shares: m.l, locked: m.l, checkpoint: 0n, pending: 7n, recipient: null };
    expect(poolClaimable(b.next, pos)).toBe(7n + ((m.l * b.next.acc) >> 64n));
    expect(poolClaimable(b.next, pos)).toBeLessThanOrEqual(7n + b.lp);
    expect(poolClaimable(b.next, { ...pos, open: false })).toBe(0n);
  });
  it('slippage helpers move the limit the right way', () => {
    expect(evmMinOut(1000n, 100)).toBe(990n);
    expect(evmMaxIn(1000n, 100)).toBe(1010n);
    expect(evmMaxIn(1n, 100)).toBe(2n);
  });
  it('reports the price in coin per whole token', () => {
    expect(poolPriceText({ x: 10n ** 27n, y: 0n, l: 10n * ETH }, 18)).toBe('0.00000001');
  });
});

describe('validation', () => {
  it('accepts a good form and works out the starting liquidity exactly', () => {
    const v = validateEvmPool(form(), CREATOR, token(), false, addresses);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.config.x0).toBe(10n ** 27n);
      expect(v.config.l0).toBe(10n * ETH);
      expect(v.config.feeBps).toBe(25);
      expect(v.config.lock).toBe(true);
      expect(v.config.y0).toBe(0n);
      expect(v.config.creator).toBe(CREATOR);
    }
  });
  it('lets the creator choose 1% and rejects anything else', () => {
    const one = validateEvmPool(form({ feeTier: '1' }), CREATOR, token(), false, addresses);
    expect(one.ok && one.config.feeBps).toBe(100);
    for (const bad of ['0.5', '', '2', '25']) expect(validateEvmPool(form({ feeTier: bad }), CREATOR, token(), false, addresses).ok).toBe(false);
  });
  it('refuses a token the factory did not make, with a plain reason', () => {
    const v = validateEvmPool(form(), CREATOR, token({ factoryNonce: null }), false, addresses);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues.map((i) => i.message).join(' ')).toMatch(/fixed supply and no owner, mint, pause, blacklist or fee on transfer/);
  });
  it('refuses a second pool, too many tokens, tiny or huge amounts, bad prices and bad first buys', () => {
    const msgs = (f: EvmPoolForm, t: EvmPoolToken | null = token(), existing = false) => {
      const v = validateEvmPool(f, CREATOR, t, existing, addresses);
      return v.ok ? [] : v.issues.map((i) => i.field);
    };
    expect(msgs(form(), token(), true)).toContain('token');
    expect(msgs(form(), null)).toContain('token');
    expect(msgs(form({ tokenAmount: '2,000,000,000' }))).toContain('tokenAmount');
    expect(msgs(form({ tokenAmount: '0' }))).toContain('tokenAmount');
    expect(msgs(form({ tokenAmount: '0.0000000000000001' }), token({ held: 10n ** 27n }))).toContain('tokenAmount');
    expect(msgs(form({ startPrice: '0' }))).toContain('startPrice');
    expect(msgs(form({ startPrice: 'abc' }))).toContain('startPrice');
    expect(msgs(form({ startPrice: '0.000000000000000001' }))).toContain('startPrice');
    expect(msgs(form({ firstBuy: '-1' }))).toContain('firstBuy');
    expect(msgs(form({ chain: 'bscTestnet' }))).toContain('form');
    expect(validateEvmPool(form(), 'nope', token(), false, addresses).ok).toBe(false);
  });
  it('startL is exact integer arithmetic, rounding down', () => {
    expect(startL(10n ** 27n, 10n ** 10n, 18)).toBe(10n * ETH);
    expect(startL(1001n, 10n ** 18n, 18)).toBe(1001n);
    expect(startL(3n, 1n, 18)).toBe(0n);
  });
  it('previews the start and the upfront cost without any floating point', () => {
    const p = evmPoolPreview({ tokenAmount: '1,000,000,000', startPrice: '0.00000001', firstBuy: '0.5' }, { decimals: 18, supply: 10n ** 27n }, chain.creationFee)!;
    expect(p.startPrice).toBe('0.00000001');
    expect(p.startValue).toBe('10');
    expect(p.upfront).toBe(chain.creationFee + ETH / 2n);
    expect(evmPoolPreview({ tokenAmount: '', startPrice: '1', firstBuy: '' }, { decimals: 18, supply: 1n }, 0n)).toBeNull();
  });
});

describe('reading the chain', () => {
  const poolWords = (over: Partial<Record<number, bigint>> = {}) => '0x' + [25n, BigInt(CREATOR), 1_700_000_000n, 10n ** 27n, 0n, 10n * ETH, 0n, 0n, 10n * ETH, 7n].map((v, i) => w32(over[i] ?? v)).join('');
  it('parses a pool return and refuses malformed ones or a missing pool', () => {
    expect(parsePoolReturn(poolWords())).toMatchObject({ feeBps: 25n, creator: CREATOR, x: 10n ** 27n, l: 10n * ETH, locked: 10n * ETH, accRemainder: 7n });
    // More locked than there is liquidity cannot be a real pool; the old eight-word answer is refused.
    expect(parsePoolReturn(poolWords({ 8: 11n * ETH }))).toBeNull();
    expect(parsePoolReturn(poolWords().slice(0, 2 + 8 * 64))).toBeNull();
    expect(parsePoolReturn(poolWords({ 0: 0n }))).toBeNull();
    expect(parsePoolReturn(poolWords({ 1: 1n << 200n }))).toBeNull();
    expect(parsePoolReturn('0x1234')).toBeNull();
    expect(parsePoolReturn(undefined)).toBeNull();
  });
  it('parses a position return', () => {
    const p = '0x' + [1n, 5n, 5n, 0n, 9n, BigInt(CREATOR)].map(w32).join('');
    expect(parsePositionReturn(p)).toEqual({ open: true, shares: 5n, locked: 5n, checkpoint: 0n, pending: 9n, recipient: CREATOR });
    expect(parsePositionReturn('0x' + [0n, 0n, 0n, 0n, 0n, 0n].map(w32).join(''))).toMatchObject({ open: false, recipient: null });
    expect(parsePositionReturn('0x' + [2n, 0n, 0n, 0n, 0n, 0n].map(w32).join(''))).toBeNull();
  });
  it('flags a pool that breaks the rules', () => {
    const ok: EvmPoolMath = { feeBps: 25n, x: 1n, y: 0n, l: 10n ** 12n, acc: 0n, feeReserve: 0n };
    expect(poolProblems(ok)).toEqual([]);
    expect(poolProblems({ ...ok, feeBps: 30n }).join()).toMatch(/0.3%/);
    expect(poolProblems({ ...ok, l: 5n }).join()).toMatch(/minimum/);
  });
  it('words the lock plainly', () => {
    const p = { open: true, shares: 10n, locked: 10n, checkpoint: 0n, pending: 0n, recipient: null };
    expect(lockTextOf(p)).toBe('Locked for good');
    expect(lockTextOf({ ...p, locked: 0n })).toBe('Not locked: you can remove it');
    expect(lockTextOf({ ...p, locked: 4n })).toBe('Partly locked');
    expect(lockTextOf({ ...p, open: false })).toBe('Empty');
  });
  it('share links round trip', () => {
    const h = evmPoolShareHash('bnb', '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD');
    expect(parseEvmPoolHash(h)).toEqual({ chain: 'bnb', token: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' });
    expect(parseEvmPoolHash('#/launch/pool/evm/mars/0x1')).toBeNull();
  });
});

describe('what the page tells people', () => {
  it('never calls anything safe, and says the contract is unaudited every time', () => {
    for (const k of ['create', 'buy', 'sell', 'add', 'remove', 'claim', 'lock'] as const) {
      const text = evmPoolDisclosures(k, 'ETH').map((d) => d.text).join(' ');
      expect(text).toMatch(/audited/);
      expect(text).not.toMatch(/\bsafe\b|guarantee|risk-free/i);
    }
    expect(evmPoolDisclosures('create', 'ETH').map((d) => d.text).join(' ')).toMatch(/20% of it is owed to Aretia/);
  });
});

describe('how much of a pool is locked (M-9) and the fee carry (I-5)', () => {
  it('says 100% plainly, and warns with the withdrawable share otherwise', () => {
    expect(lockedShareText({ locked: 10n, l: 10n })).toEqual({ text: '100% of liquidity locked for good', warn: false });
    const part = lockedShareText({ locked: 3n, l: 4n });
    expect(part.warn).toBe(true);
    expect(part.text).toMatch(/^75% of liquidity locked for good\. The other 25% can be withdrawn/);
    expect(lockedShareBps({ locked: 1n, l: 3n })).toBe(3333);
    expect(lockedShareText({ locked: 0n, l: 0n }).warn).toBe(true);
  });
  it('carries the LP-fee remainder exactly as the contract does', () => {
    const m = { feeBps: 100n, x: 10n ** 27n, y: 0n, l: 10n ** 22n, acc: 0n, feeReserve: 0n, accRemainder: 0n };
    let cur: typeof m = m;
    for (let i = 0; i < 40; i++) cur = { ...m, ...poolQuoteBuy(cur, 10_000n)!.next } as typeof m;
    expect(cur.acc * cur.l + cur.accRemainder).toBe(cur.feeReserve << 64n);
    expect(cur.acc).toBeGreaterThan(0n);
  });
});
