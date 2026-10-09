import { describe, expect, it } from 'vitest';
import { ARETIA_FEE_BPS, DEFAULT_FEE_CONFIG, liveFeeConfig, LIVE_FEE_CONFIG, MAX_FEE_BPS, planAretiaFee, validateFeeConfig } from './fee.js';
import { normalizeTokenRef, parseTokenKey, sameToken, tokenKey } from './token.js';
import { summarizeQuote } from './summary.js';
import { CHAINS, type AretiaFeeConfig, type ChainId, type Quote } from './types.js';

const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

describe('token identity', () => {
  it('lower-cases EVM addresses so one contract has one key', () => {
    expect(normalizeTokenRef('ethereum', USDC_ETH)?.address).toBe(USDC_ETH.toLowerCase());
    expect(tokenKey(normalizeTokenRef('ethereum', USDC_ETH)!)).toBe(`ethereum:${USDC_ETH.toLowerCase()}`);
  });
  it('keeps Solana mints case-sensitive', () => {
    expect(normalizeTokenRef('solana', USDC_SOL)?.address).toBe(USDC_SOL);
  });
  it('rejects malformed addresses, wrong-chain addresses and unknown chains', () => {
    expect(normalizeTokenRef('ethereum', '0x123')).toBeNull();
    expect(normalizeTokenRef('ethereum', USDC_SOL)).toBeNull();
    expect(normalizeTokenRef('solana', USDC_ETH)).toBeNull();
    expect(normalizeTokenRef('dogechain', USDC_ETH)).toBeNull();
    expect(normalizeTokenRef('solana', 42)).toBeNull();
  });
  it('treats the same address on different chains as different tokens', () => {
    const a = normalizeTokenRef('ethereum', USDC_ETH)!;
    const b = normalizeTokenRef('base', USDC_ETH)!;
    expect(sameToken(a, b)).toBe(false);
    expect(sameToken(a, normalizeTokenRef('ethereum', USDC_ETH.toLowerCase())!)).toBe(true);
  });
  it('round-trips keys', () => {
    const t = normalizeTokenRef('bnb', USDC_ETH)!;
    expect(parseTokenKey(tokenKey(t))).toEqual(t);
    expect(parseTokenKey('nonsense')).toBeNull();
  });
});

describe('chains', () => {
  it('only Solana is executable until the EVM path exists', () => {
    expect(Object.values(CHAINS).filter((c) => c.executionEnabled).map((c) => c.id)).toEqual(['solana']);
  });
});

describe('Aretia fee policy', () => {
  const EVM_FEE = '0x1111111111111111111111111111111111111111';

  it('ships off: no fee on any chain, and everything entered is swapped', () => {
    for (const id of Object.keys(CHAINS) as ChainId[]) expect(planAretiaFee(1_000_000n, id)).toEqual({ state: 'off', fee: 0n, net: 1_000_000n, treasury: null, reasons: [] });
  });

  it('is 29 basis points (0.29%), and the live configuration is on for every network', () => {
    expect(ARETIA_FEE_BPS).toBe(29);
    expect(DEFAULT_FEE_CONFIG.policy).toEqual({ enabled: false, rateBps: 29 });
    const live = liveFeeConfig(EVM_FEE);
    expect(() => validateFeeConfig(live)).not.toThrow();
    for (const id of Object.keys(CHAINS) as ChainId[]) expect(planAretiaFee(1_000_000n, id, live)).toMatchObject({ state: 'ready', fee: 2_900n, net: 997_100n });
  });

  it('splits the amount entered exactly into the fee and the rest, rounding the fee down', () => {
    const live = liveFeeConfig(EVM_FEE);
    for (const amount of [1n, 99n, 345n, 999n, 1_000_000n, 123_456_789_012n]) {
      const p = planAretiaFee(amount, 'base', live);
      expect(p.fee + p.net).toBe(amount);
      expect(p.fee).toBe((amount * 29n) / 10_000n);
    }
    expect(planAretiaFee(344n, 'solana', LIVE_FEE_CONFIG).fee).toBe(0n);
    expect(planAretiaFee(345n, 'solana', LIVE_FEE_CONFIG).fee).toBe(1n);
  });

  it('sends Solana fees to the owner\'s fee wallet and EVM fees to the one EVM address supplied', () => {
    expect(planAretiaFee(1_000_000n, 'solana', LIVE_FEE_CONFIG)).toMatchObject({ state: 'ready', treasury: DEFAULT_FEE_CONFIG.chains.solana.treasuryAddress });
    expect(planAretiaFee(1_000_000n, 'ethereum', liveFeeConfig(EVM_FEE.toUpperCase().replace('0X', '0x')))).toMatchObject({ treasury: EVM_FEE });
  });

  it('blocks EVM swaps, rather than skipping the fee, until the EVM fee address is supplied or when it is malformed', () => {
    for (const address of [undefined, '', 'nonsense', '0x123']) {
      const plan = planAretiaFee(1_000_000n, 'base', liveFeeConfig(address));
      expect(plan.state).toBe('blocked');
      expect(plan.fee).toBe(0n);
      expect(plan.reasons[0]).toMatch(/fee address/);
    }
    // Solana never needs the EVM address.
    expect(planAretiaFee(1_000_000n, 'solana', liveFeeConfig()).state).toBe('ready');
  });

  it('refuses a zero amount, and a rate above the ceiling or in fractions of a basis point', () => {
    expect(planAretiaFee(0n, 'solana', LIVE_FEE_CONFIG).state).toBe('blocked');
    const bad = (rateBps: number): AretiaFeeConfig => ({ ...DEFAULT_FEE_CONFIG, policy: { ...DEFAULT_FEE_CONFIG.policy, rateBps } });
    expect(() => validateFeeConfig(bad(MAX_FEE_BPS + 1))).toThrow();
    expect(() => validateFeeConfig(bad(2.9))).toThrow();
    expect(() => validateFeeConfig(bad(-1))).toThrow();
    expect(() => validateFeeConfig(bad(MAX_FEE_BPS))).not.toThrow();
  });

  it('configures no EVM address by default', () => {
    for (const id of ['ethereum', 'bnb', 'polygon', 'base', 'arbitrum', 'optimism', 'avalanche'] as const) expect(DEFAULT_FEE_CONFIG.chains[id].treasuryAddress).toBeUndefined();
  });
});

describe('execution summary', () => {
  const sol = { chain: 'solana' as const, address: USDC_SOL };
  const quote: Quote = {
    id: 'q1',
    providerId: 'test',
    request: { chain: 'solana', from: sol, to: { chain: 'solana', address: WSOL }, amountIn: 1_000_000n, slippageBps: 50, account: { chain: 'solana', address: USDC_SOL } },
    inAmount: 1_000_000n,
    expectedOut: 5_000n,
    minOut: 4_975n,
    priceImpactBps: 12,
    route: { legs: [{ venue: 'Raydium', from: sol, to: { chain: 'solana', address: WSOL }, shareBps: 10_000 }] },
    costs: { network: null, provider: null, aretiaFee: { amount: 0n, asset: null } },
    fetchedAt: 0,
    expiresAt: 1,
    raw: null,
  };
  it('keeps the four parts separate and says when there is no Aretia fee', () => {
    const s = summarizeQuote(quote);
    expect(s.swap.expectedOut).toBe(5_000n);
    expect(s.aretiaFee.state).toBe('off');
    expect(s.notes).toContain('No Aretia fee is charged on this swap.');
    expect(s.notes).toContain('The network fee was not reported for this quote.');
    expect(s.canProceed).toBe(true);
  });
  it('cannot proceed when the fee is on but its address is missing', () => {
    const cfg: AretiaFeeConfig = { policy: { ...DEFAULT_FEE_CONFIG.policy, enabled: true }, chains: { ...DEFAULT_FEE_CONFIG.chains, solana: { chainId: 'solana', enabled: true } } };
    const s = summarizeQuote(quote, cfg);
    expect(s.canProceed).toBe(false);
    expect(s.swap.expectedOut).toBe(5_000n); // the quoted output is never silently reduced
  });
});
