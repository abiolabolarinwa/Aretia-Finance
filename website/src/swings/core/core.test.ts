import { describe, expect, it } from 'vitest';
import { ARETIA_FEE_BPS, DEFAULT_FEE_CONFIG, liveFeeConfig, LIVE_FEE_CONFIG, MAX_FEE_BPS, planAretiaFee, validateFeeConfig } from './fee.js';
import { normalizeTokenRef, parseTokenKey, sameToken, tokenKey } from './token.js';
import { summarizeQuote } from './summary.js';
import { isFeeAsset } from './feeAssets.js';
import { CHAINS, EVM_NATIVE_ADDRESS, type AretiaFeeConfig, type ChainId, type Quote } from './types.js';

const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
/** The coin a swap on a network is paid with. */
const coin = (id: ChainId): string => (id === 'solana' ? WSOL : EVM_NATIVE_ADDRESS);

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
    for (const id of Object.keys(CHAINS) as ChainId[]) expect(planAretiaFee(1_000_000n, id, DEFAULT_FEE_CONFIG, coin(id))).toEqual({ state: 'off', fee: 0n, net: 1_000_000n, treasury: null, reasons: [], offBecause: 'policy' });
  });

  it('is 58 basis points (0.58%), and the live configuration is on for every network', () => {
    expect(ARETIA_FEE_BPS).toBe(58);
    expect(DEFAULT_FEE_CONFIG.policy).toEqual({ enabled: false, rateBps: 58 });
    const live = liveFeeConfig(EVM_FEE);
    expect(() => validateFeeConfig(live)).not.toThrow();
    for (const id of Object.keys(CHAINS) as ChainId[]) expect(planAretiaFee(1_000_000n, id, live, coin(id))).toMatchObject({ state: 'ready', fee: 5_800n, net: 994_200n });
  });

  it('splits the amount entered exactly into the fee and the rest, rounding the fee down', () => {
    const live = liveFeeConfig(EVM_FEE);
    for (const amount of [1n, 99n, 345n, 999n, 1_000_000n, 123_456_789_012n]) {
      const p = planAretiaFee(amount, 'base', live, EVM_NATIVE_ADDRESS);
      expect(p.fee + p.net).toBe(amount);
      expect(p.fee).toBe((amount * 58n) / 10_000n);
    }
    expect(planAretiaFee(172n, 'solana', LIVE_FEE_CONFIG, WSOL).fee).toBe(0n);
    expect(planAretiaFee(173n, 'solana', LIVE_FEE_CONFIG, WSOL).fee).toBe(1n);
  });

  it('sends Solana fees to the owner\'s fee wallet and EVM fees to the one EVM address supplied', () => {
    expect(planAretiaFee(1_000_000n, 'solana', LIVE_FEE_CONFIG, WSOL)).toMatchObject({ state: 'ready', treasury: DEFAULT_FEE_CONFIG.chains.solana.treasuryAddress });
    expect(planAretiaFee(1_000_000n, 'ethereum', liveFeeConfig(EVM_FEE.toUpperCase().replace('0X', '0x')), EVM_NATIVE_ADDRESS)).toMatchObject({ treasury: EVM_FEE });
  });

  it('blocks EVM swaps, rather than skipping the fee, until the EVM fee address is supplied or when it is malformed', () => {
    for (const address of [undefined, '', 'nonsense', '0x123']) {
      const plan = planAretiaFee(1_000_000n, 'base', liveFeeConfig(address), EVM_NATIVE_ADDRESS);
      expect(plan.state).toBe('blocked');
      expect(plan.fee).toBe(0n);
      expect(plan.reasons[0]).toMatch(/fee address/);
    }
    // Solana never needs the EVM address.
    expect(planAretiaFee(1_000_000n, 'solana', liveFeeConfig(), WSOL).state).toBe('ready');
  });

  it('refuses a zero amount, and a rate above the ceiling or in fractions of a basis point', () => {
    expect(planAretiaFee(0n, 'solana', LIVE_FEE_CONFIG, WSOL).state).toBe('blocked');
    const bad = (rateBps: number): AretiaFeeConfig => ({ ...DEFAULT_FEE_CONFIG, policy: { ...DEFAULT_FEE_CONFIG.policy, rateBps } });
    expect(() => validateFeeConfig(bad(MAX_FEE_BPS + 1))).toThrow();
    expect(() => validateFeeConfig(bad(5.8))).toThrow();
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
  it('reports the fee the quote itself took out, even on a screen with no fee policy of its own', () => {
    const charged = { ...quote, costs: { ...quote.costs, aretiaFee: { amount: 29n, asset: null } } };
    const s = summarizeQuote(charged);
    expect(s.aretiaFee).toMatchObject({ state: 'ready', amount: 29n });
    expect(s.notes).not.toContain('No Aretia fee is charged on this swap.');
  });
  it('cannot proceed when the fee is on but its address is missing', () => {
    const cfg: AretiaFeeConfig = { policy: { ...DEFAULT_FEE_CONFIG.policy, enabled: true }, chains: { ...DEFAULT_FEE_CONFIG.chains, solana: { chainId: 'solana', enabled: true } } };
    const s = summarizeQuote(quote, cfg);
    expect(s.canProceed).toBe(false);
    expect(s.swap.expectedOut).toBe(5_000n); // the quoted output is never silently reduced
  });
});

describe('which swaps carry the Aretia fee', () => {
  const live = liveFeeConfig('0x1111111111111111111111111111111111111111');
  const USDT_SOL = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
  const SOME_TOKEN_SOL = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const USDC_BNB = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d';
  const USDT_BNB = '0x55d398326f99059ff775485246999027b3197955';
  const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
  const ARK = '0xcae117ca6bc8a341d2e7207f30e180f0e5618b9d';

  it('charges 0.58% when the swap is paid with a coin, a wrapped coin or a stablecoin', () => {
    for (const [chain, asset] of [['solana', WSOL], ['solana', USDC_SOL], ['solana', USDT_SOL], ['bnb', EVM_NATIVE_ADDRESS], ['bnb', WBNB], ['bnb', USDC_BNB], ['bnb', USDT_BNB], ['ethereum', USDC_ETH]] as const) {
      expect(planAretiaFee(1_000_000n, chain, live, asset), `${chain} ${asset}`).toMatchObject({ state: 'ready', fee: 5_800n, net: 994_200n });
    }
  });

  it('charges nothing when a token is being sold, and then swaps everything entered', () => {
    for (const [chain, asset] of [['solana', SOME_TOKEN_SOL], ['bnb', ARK], ['ethereum', '0x' + 'ab'.repeat(20)]] as const) {
      expect(planAretiaFee(1_000_000n, chain, live, asset), `${chain} ${asset}`).toEqual({ state: 'off', fee: 0n, net: 1_000_000n, treasury: null, reasons: [], offBecause: 'token' });
    }
  });

  it('does not need the EVM fee address for a sale, since no fee is taken', () => {
    expect(planAretiaFee(1_000_000n, 'bnb', liveFeeConfig(), ARK).state).toBe('off');
    expect(planAretiaFee(1_000_000n, 'bnb', liveFeeConfig(), EVM_NATIVE_ADDRESS).state).toBe('blocked');
  });

  it('reads an EVM address in any letter case, and knows the coin of every network', () => {
    expect(isFeeAsset('ethereum', USDC_ETH)).toBe(true);
    expect(isFeeAsset('ethereum', USDC_ETH.toLowerCase())).toBe(true);
    for (const id of Object.keys(CHAINS) as ChainId[]) expect(isFeeAsset(id, id === 'solana' ? WSOL : EVM_NATIVE_ADDRESS), id).toBe(true);
  });

  it('says in the summary that selling a token is free, and why', () => {
    const sell: Quote = {
      id: 'q2',
      providerId: 'test',
      request: { chain: 'bnb', from: { chain: 'bnb', address: ARK }, to: { chain: 'bnb', address: EVM_NATIVE_ADDRESS }, amountIn: 1_000_000n, slippageBps: 50, account: { chain: 'bnb', address: '0x' + '1'.repeat(40) } },
      inAmount: 1_000_000n,
      expectedOut: 5_000n,
      minOut: 4_975n,
      priceImpactBps: 12,
      route: { legs: [] },
      costs: { network: null, provider: null, aretiaFee: { amount: 0n, asset: null } },
      fetchedAt: 0,
      expiresAt: 1,
      raw: null,
    };
    const s = summarizeQuote(sell, live);
    expect(s.aretiaFee).toMatchObject({ state: 'off', offBecause: 'token' });
    expect(s.notes.join(' ')).toMatch(/selling a token is free/);
    expect(s.canProceed).toBe(true);
  });
});
