import { describe, expect, it } from 'vitest';
import { DEFAULT_FEE_CONFIG, MAX_BUYBACK_BPS, planBuyback, validateFeeConfig, LIVE_FEE_CONFIG, BUYBACK_LIVE } from './fee.js';
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

describe('Aretia buyback policy', () => {
  const on = (chain: 'solana' | 'base', extra: Partial<AretiaFeeConfig['chains']['base']> = {}): AretiaFeeConfig => ({
    policy: { ...DEFAULT_FEE_CONFIG.policy, enabled: true },
    chains: { ...DEFAULT_FEE_CONFIG.chains, [chain]: { ...DEFAULT_FEE_CONFIG.chains[chain], enabled: true, ...extra } },
  });

  it('ships off: zero fee on every chain', () => {
    for (const id of Object.keys(CHAINS) as ChainId[]) expect(planBuyback(1_000_000n, id)).toEqual({ state: 'off', amount: 0n, reasons: [] });
  });
  it('is 55 bps; the live configuration follows one switch and, when on, covers Solana only', () => {
    expect(DEFAULT_FEE_CONFIG.policy).toMatchObject({ rateBps: 55, asset: 'ACT', mode: 'BUYBACK' });
    expect(() => validateFeeConfig(LIVE_FEE_CONFIG)).not.toThrow();
    expect(planBuyback(1_000_000n, 'solana', LIVE_FEE_CONFIG).state).toBe(BUYBACK_LIVE ? 'ready' : 'off');
    const on: AretiaFeeConfig = { policy: { ...LIVE_FEE_CONFIG.policy, enabled: true }, chains: { ...LIVE_FEE_CONFIG.chains, solana: { ...LIVE_FEE_CONFIG.chains.solana, enabled: true } } };
    expect(planBuyback(1_000_000n, 'solana', on)).toEqual({ state: 'ready', amount: 5_500n, reasons: [] });
    for (const id of ['ethereum', 'bnb', 'polygon', 'base', 'arbitrum', 'optimism', 'avalanche'] as const) expect(planBuyback(1_000_000n, id, on)).toEqual({ state: 'off', amount: 0n, reasons: [] });
  });
  it('blocks, rather than falling back, when addresses are missing', () => {
    const plan = planBuyback(1_000_000n, 'base', on('base'));
    expect(plan.state).toBe('blocked');
    expect(plan.amount).toBe(0n);
    expect(plan.reasons).toHaveLength(2);
  });
  it('computes 0.55% rounded down when fully configured', () => {
    const cfg = on('base', { treasuryAddress: 'configured-treasury', buybackExecutorAddress: 'configured-executor' });
    expect(planBuyback(1_000_000n, 'base', cfg)).toEqual({ state: 'ready', amount: 5_500n, reasons: [] });
    expect(planBuyback(999n, 'base', cfg).amount).toBe(5n);
  });
  it('rejects rates above the ceiling or fractional bps', () => {
    const bad = (rateBps: number): AretiaFeeConfig => ({ ...DEFAULT_FEE_CONFIG, policy: { ...DEFAULT_FEE_CONFIG.policy, rateBps } });
    expect(() => validateFeeConfig(bad(MAX_BUYBACK_BPS + 1))).toThrow();
    expect(() => validateFeeConfig(bad(8.7))).toThrow();
    expect(() => validateFeeConfig(bad(-1))).toThrow();
    expect(() => validateFeeConfig(bad(MAX_BUYBACK_BPS))).not.toThrow();
  });
  it('configures no EVM address by default', () => {
    for (const id of ['ethereum', 'bnb', 'polygon', 'base'] as const) {
      expect(DEFAULT_FEE_CONFIG.chains[id].treasuryAddress).toBeUndefined();
      expect(DEFAULT_FEE_CONFIG.chains[id].buybackExecutorAddress).toBeUndefined();
    }
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
    costs: { network: null, provider: null, aretiaBuyback: { amount: 0n, asset: null } },
    fetchedAt: 0,
    expiresAt: 1,
    raw: null,
  };
  it('keeps the four parts separate and says when there is no Aretia fee', () => {
    const s = summarizeQuote(quote);
    expect(s.swap.expectedOut).toBe(5_000n);
    expect(s.aretiaBuyback.state).toBe('off');
    expect(s.notes).toContain('No Aretia fee is charged on this swap.');
    expect(s.notes).toContain('The network fee was not reported for this quote.');
    expect(s.canProceed).toBe(true);
  });
  it('cannot proceed when an enabled buyback is misconfigured', () => {
    const cfg: AretiaFeeConfig = { policy: { ...DEFAULT_FEE_CONFIG.policy, enabled: true }, chains: { ...DEFAULT_FEE_CONFIG.chains, solana: { ...DEFAULT_FEE_CONFIG.chains.solana, enabled: true } } };
    const s = summarizeQuote(quote, cfg);
    expect(s.canProceed).toBe(false);
    expect(s.swap.expectedOut).toBe(5_000n); // the quoted output is never silently reduced
  });
});
