import { describe, expect, it } from 'vitest';
import { adminTransition, DEFAULT_RULES, evaluate, type PoolFacts } from './lifecycle.js';

const now = 1_000_000_000_000;
const base: PoolFacts = { tokensReadable: true, quoteRecognised: true, reserveBase: 10n, reserveQuote: 10n, liquidityUsd: null, createdAt: now - 60_000, firstSeenAt: now - 60_000, lastTradeAt: null, paused: false };

describe('lifecycle', () => {
  it('a pool with liquidity and a known quote is active', () => expect(evaluate('discovered', base, DEFAULT_RULES, now).state).toBe('active'));
  it('a token contract alone is not a market: no liquidity means awaiting liquidity', () => {
    expect(evaluate('validating', { ...base, reserveBase: 0n }, DEFAULT_RULES, now).state).toBe('awaiting_liquidity');
  });
  it('dollar liquidity below the minimum keeps a pool out', () => {
    expect(evaluate('validating', { ...base, liquidityUsd: 100 }, DEFAULT_RULES, now).state).toBe('awaiting_liquidity');
    expect(evaluate('validating', { ...base, liquidityUsd: 100_000 }, DEFAULT_RULES, now).state).toBe('active');
  });
  it('unreadable tokens or no recognised quote make a pool unsupported', () => {
    expect(evaluate('discovered', { ...base, tokensReadable: false }, DEFAULT_RULES, now).state).toBe('unsupported');
    expect(evaluate('discovered', { ...base, quoteRecognised: false }, DEFAULT_RULES, now).state).toBe('unsupported');
    expect(evaluate('discovered', { ...base, quoteRecognised: false }, { ...DEFAULT_RULES, requireKnownQuote: false }, now).state).toBe('active');
  });
  it('is validating while facts are unread, and times out', () => {
    expect(evaluate('discovered', { ...base, tokensReadable: null }, DEFAULT_RULES, now).state).toBe('validating');
    expect(evaluate('validating', { ...base, tokensReadable: null, firstSeenAt: now - 7 * 3_600_000 }, DEFAULT_RULES, now).state).toBe('unsupported');
    expect(evaluate('validating', { ...base, reserveBase: null }, DEFAULT_RULES, now).state).toBe('validating');
  });
  it('goes inactive when trading stops or liquidity is drained, and returns on a trade', () => {
    const old = now - 8 * 86_400_000;
    expect(evaluate('active', { ...base, createdAt: old, lastTradeAt: old }, DEFAULT_RULES, now).state).toBe('inactive');
    expect(evaluate('active', { ...base, createdAt: old, lastTradeAt: now - 1000 }, DEFAULT_RULES, now).state).toBe('active');
    expect(evaluate('active', { ...base, reserveQuote: 0n, lastTradeAt: now - 1000 }, DEFAULT_RULES, now).state).toBe('inactive');
  });
  it('suspension is sticky until an explicit resume', () => {
    expect(evaluate('suspended', base, DEFAULT_RULES, now).state).toBe('suspended');
    expect(evaluate('active', { ...base, paused: true }, DEFAULT_RULES, now).state).toBe('suspended');
    expect(adminTransition('active', 'suspend')).toBe('suspended');
    expect(adminTransition('suspended', 'resume')).toBe('validating');
    expect(adminTransition('active', 'resume')).toBeNull();
  });
});
