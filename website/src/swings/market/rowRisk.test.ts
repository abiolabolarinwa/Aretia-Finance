import { describe, expect, it } from 'vitest';
import type { TokenRisk } from '../core/types.js';
import type { MarketRow } from './types.js';
import { marketFactsOf, marketReading, needsCheck, ratingView, RiskMemory, toRowRisk, withMarketReading } from './rowRisk.js';

const HOUR = 3_600_000;
const row = (over: Partial<MarketRow> = {}): MarketRow => ({
  chain: 'bnb', address: '0xabc', symbol: 'TKN', quoteSymbol: 'WBNB', name: 'Token', icon: null, decimals: 18, pool: '0xpool',
  priceUsd: 1, capUsd: 1e6, ageMs: 200 * 24 * HOUR, txns24h: 100, volume24hUsd: 50_000, traders24h: 40,
  change: { m5: 0, h1: 0, h6: 0, h24: 0 }, liquidityUsd: 200_000, risk: null, fresh: false, ...over,
});

describe('the market reading', () => {
  it('rates a row from its own pool numbers, with a score', () => {
    const r = marketReading(row());
    expect(r.score).toBe(0);
    expect(r.status).toBe('unverified');
  });

  it('calls a very new, thin pool elevated risk', () => {
    const r = marketReading(row({ ageMs: 0.5 * HOUR, liquidityUsd: 4_000 }));
    expect(r.status).toBe('elevated');
    expect(r.score).toBe(32);
  });

  it('calls a year-old, deep, busy pool established', () => {
    expect(marketReading(row({ ageMs: 400 * 24 * HOUR, liquidityUsd: 6_000_000, volume24hUsd: 700_000 })).status).toBe('established');
  });

  it('gives no score, rather than a flattering one, when the age is unknown', () => {
    expect(marketReading(row({ ageMs: null })).score).toBeNull();
    expect(withMarketReading(row({ ageMs: null })).risk).toBeNull();
  });
});

describe('what a row shows', () => {
  it('keeps a rating Aretia already has and never replaces it with the market reading', () => {
    const rated = row({ risk: { status: 'verified', label: 'Verified', score: 0, basis: 'registry' } });
    expect(withMarketReading(rated)).toBe(rated);
    expect(needsCheck(rated)).toBe(false);
  });

  it('marks a market reading as partial and still waiting for the on-chain check', () => {
    const r = withMarketReading(row());
    expect(r.risk?.basis).toBe('market');
    expect(needsCheck(r)).toBe(true);
    const v = ratingView(r, 'pending');
    expect(v).toMatchObject({ soft: true, checking: true });
    expect(v.title).toContain('not a safety check');
  });

  it('draws an on-chain result as solid and finished', () => {
    const v = ratingView(row({ risk: { status: 'elevated', label: 'Elevated risk', score: 45, basis: 'onchain' } }), 'done');
    expect(v).toMatchObject({ label: 'Elevated risk', band: 'orange', tone: 'warn', soft: false, checking: false });
  });

  it('colours a rating by its status, with no number in the label', () => {
    const at = (status: string, score = 10) => ratingView(row({ risk: { status: status as never, label: status, score, basis: 'onchain' } }), 'done');
    expect(at('established').band).toBe('green');
    expect(at('verified').band).toBe('green');
    expect(at('unverified', 8).band).toBe('yellow');
    expect(at('new', 0).band).toBe('orange');
    expect(at('elevated', 45).band).toBe('orange');
    expect(at('high', 70).band).toBe('red');
    expect(at('restricted', 90).band).toBe('red');
    expect(at('unverified', 8).label).not.toMatch(/\d/);
    expect(ratingView(row(), 'pending').band).toBe('grey');
    expect(ratingView(row(), 'failed').band).toBe('grey');
  });

  it('says so plainly when a token could not be read, and never "not rated"', () => {
    expect(ratingView(row(), 'failed').label).toBe('Couldn\'t check');
    expect(ratingView(row(), 'pending').label).toBe('Checking');
    expect(ratingView(row({ ageMs: null }), 'failed').label).not.toMatch(/not rated/i);
  });

  it('treats a registry "not enough data" as still needing a check', () => {
    expect(needsCheck(row({ risk: { status: 'unknown', label: 'Not enough data', score: null, basis: 'registry' } }))).toBe(true);
  });

  it('passes the pool numbers to the on-chain check', () => {
    expect(marketFactsOf(row())).toEqual({ liquidityUsd: 200_000, volume24hUsd: 50_000, ageMs: 200 * 24 * HOUR, hasPool: true });
  });
});

describe('the shared memory of checks', () => {
  const risk = { score: 5, status: 'unverified', signals: [], unavailable: [], assessedAt: 0 } as TokenRisk;

  it('returns a finished check for the same token, whatever the address casing on EVM', () => {
    const m = new RiskMemory(() => 0);
    m.set('bnb', '0xAbC', risk);
    expect(m.get('bnb', '0xabc')?.risk).toBe(risk);
    expect(m.get('solana', '0xabc')).toBeNull();
  });

  it('forgets a failure after two minutes and a result after thirty', () => {
    let t = 0;
    const m = new RiskMemory(() => t);
    m.set('bnb', '0x1', null);
    m.set('bnb', '0x2', risk);
    t = 3 * 60_000;
    expect(m.get('bnb', '0x1')).toBeNull();
    expect(m.get('bnb', '0x2')).not.toBeNull();
    t = 31 * 60_000;
    expect(m.get('bnb', '0x2')).toBeNull();
  });

  it('turns a risk into the row shape', () => {
    expect(toRowRisk(risk, 'onchain')).toEqual({ status: 'unverified', label: 'Unverified', score: 5, basis: 'onchain' });
  });
});
