import { describe, expect, it } from 'vitest';
import { FEATURED } from '../data/featured';
import { VERIFIED } from '../data/verified';
import { FEATURED_LIMITS, featuredNow, isRunning, notOver, problemWith as featuredProblem, tokenHref, type FeaturedItem } from './featured';
import { hasErrors, validateRequest, type RequestFields } from './requests';
import { CHECKS, addressOk, dateText, problemWith, verifiedFor, type VerifiedEntry } from './verified';

const SOL = 'So11111111111111111111111111111111111111112';
const EVM = '0xAbCdEf0123456789aBcDeF0123456789abcdef01';
const at = (iso: string): number => Date.parse(`${iso}T12:00:00Z`);

const entry = (over: Partial<VerifiedEntry> = {}): VerifiedEntry => ({ token: SOL, chain: 'solana', date: '2026-10-01', checked: CHECKS.map((c) => c.key), evidence: 'https://aretiafinance.org/docs/verified/x.txt', ...over });

describe('the shipped lists', () => {
  it('start empty: nothing is verified or featured until Aretia actually does it', () => {
    expect(VERIFIED).toEqual([]);
    expect(FEATURED).toEqual([]);
    expect(featuredNow(FEATURED, Date.now())).toEqual([]);
  });
});

describe('verified entries', () => {
  it('accepts a complete entry', () => {
    expect(problemWith(entry(), at('2026-10-18'))).toBeNull();
  });
  it('rejects an entry that records fewer than all four checks', () => {
    expect(problemWith(entry({ checked: ['supply-fixed', 'powers-given-up'] }))).toMatch(/four checks/);
  });
  it('rejects bad addresses, dates, links and labels', () => {
    expect(problemWith(entry({ token: 'abc' }))).toMatch(/address/);
    expect(problemWith(entry({ chain: 'ethereum', token: SOL }))).toMatch(/address/);
    expect(problemWith(entry({ date: '2026-13-40' }))).toMatch(/date/);
    expect(problemWith(entry({ date: '2030-01-01' }), at('2026-10-18'))).toMatch(/future/);
    expect(problemWith(entry({ evidence: 'http://example.com' }))).toMatch(/https/);
    expect(problemWith(entry({ evidence: 'https://localhost/x' }))).toMatch(/https/);
    expect(problemWith(entry({ label: 'x'.repeat(41) }))).toMatch(/label/);
    expect(problemWith(entry({ chain: 'base' as never }))).toMatch(/chain/);
  });
  it('finds a token by chain and address; EVM addresses ignore case, Solana ones do not', () => {
    const list = [entry({ chain: 'ethereum', token: EVM }), entry()];
    expect(verifiedFor(list, 'ethereum', EVM.toLowerCase(), at('2026-10-18'))?.chain).toBe('ethereum');
    expect(verifiedFor(list, 'bnb', EVM, at('2026-10-18'))).toBeNull();
    expect(verifiedFor(list, 'solana', SOL, at('2026-10-18'))).not.toBeNull();
    expect(verifiedFor(list, 'solana', SOL.toLowerCase(), at('2026-10-18'))).toBeNull();
  });
  it('never matches an invalid entry, and the latest valid one wins', () => {
    expect(verifiedFor([entry({ checked: [] })], 'solana', SOL, at('2026-10-18'))).toBeNull();
    const w = verifiedFor([entry({ date: '2026-09-01' }), entry({ date: '2026-10-05' }), entry({ date: '2026-10-09', checked: [] })], 'solana', SOL, at('2026-10-18'));
    expect(w?.date).toBe('2026-10-05');
  });
  it('writes dates the same way everywhere', () => {
    expect(dateText('2026-10-18')).toBe('18 Oct 2026');
    expect(addressOk('solana', SOL)).toBe(true);
  });
});

const item = (over: Partial<FeaturedItem> = {}): FeaturedItem => ({ id: 'a', token: SOL, chain: 'solana', title: 'Title', blurb: 'One line.', from: '2026-11-01', to: '2026-11-14', ...over });

describe('featured items', () => {
  it('shows an item only inside its dates, with the last day included', () => {
    const list = [item()];
    expect(featuredNow(list, at('2026-10-31'))).toEqual([]);
    expect(featuredNow(list, at('2026-11-01'))).toHaveLength(1);
    expect(featuredNow(list, Date.parse('2026-11-14T23:59:59Z'))).toHaveLength(1);
    expect(featuredNow(list, Date.parse('2026-11-15T00:00:00Z'))).toEqual([]);
  });
  it('shows nothing for an empty list', () => {
    expect(featuredNow([], Date.now())).toEqual([]);
  });
  it('skips an invalid item rather than showing it half-formed', () => {
    const bad = [item({ title: '' }), item({ token: 'nope' }), item({ to: '2026-10-01' }), item({ blurb: 'x'.repeat(FEATURED_LIMITS.blurb + 1) }), item({ image: 'http://x.com/a.png' }), item({ chain: 'base' as never })];
    for (const b of bad) expect(featuredProblem(b)).not.toBeNull();
    expect(featuredNow(bad, at('2026-11-05'))).toEqual([]);
    expect(featuredProblem(item({ image: '/assets/featured/a.png' }))).toBeNull();
  });
  it('keeps one item per token (the later start), earliest first, and at most six', () => {
    const two = featuredNow([item({ id: 'old', from: '2026-11-01' }), item({ id: 'new', from: '2026-11-03' })], at('2026-11-05'));
    expect(two.map((i) => i.id)).toEqual(['new']);
    const many = Array.from({ length: 9 }, (_, n) => item({ id: `i${n}`, token: `So1111111111111111111111111111111111111111${n}` }));
    expect(featuredNow(many, at('2026-11-05'))).toHaveLength(FEATURED_LIMITS.max);
  });
  it('knows whether a run is over, and links to the public token page', () => {
    expect(notOver(item(), at('2026-11-14'))).toBe(true);
    expect(notOver(item(), at('2026-11-15'))).toBe(false);
    expect(isRunning(item(), at('2026-11-05'))).toBe(true);
    expect(tokenHref(item())).toBe(`/token#/solana/${SOL}`);
  });
});

describe('request validation', () => {
  const ok: RequestFields = { token: SOL, chain: 'solana', project: 'https://example.org/p', contact: 'me@example.org' };
  it('accepts a good verification request', () => {
    expect(hasErrors(validateRequest('verify', ok))).toBe(false);
  });
  it('names each wrong field', () => {
    const e = validateRequest('verify', { token: '0x12', chain: 'ethereum', project: 'http://x.org', contact: 'not-an-email' });
    expect(Object.keys(e).sort()).toEqual(['contact', 'project', 'token']);
    expect(validateRequest('verify', { ...ok, chain: '' }).chain).toBeTruthy();
    expect(validateRequest('verify', { ...ok, token: '' }).token).toBeTruthy();
  });
  it('checks the extra fields of a featured request', () => {
    expect(hasErrors(validateRequest('featured', { ...ok, title: 'T', blurb: 'B', from: '2026-11-01', to: '2026-11-02' }))).toBe(false);
    const e = validateRequest('featured', { ...ok, title: '', blurb: 'x'.repeat(141), from: '2026-11-05', to: '2026-11-01' });
    expect(Object.keys(e).sort()).toEqual(['blurb', 'title', 'to']);
    // The dates are optional.
    expect(hasErrors(validateRequest('featured', { ...ok, title: 'T', blurb: 'B' }))).toBe(false);
  });
});
