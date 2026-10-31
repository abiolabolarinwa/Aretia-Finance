import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ago, launchStats, tokenHref } from './walletLaunchBox';
import { verifiedChecker } from './launchBoxVerified';

describe('Launch Box page', () => {
  it('links each row to the public token page', () => {
    expect(tokenHref({ chain: 'bnb', address: '0xABCDEF0000000000000000000000000000000001' })).toBe('/token#/bnb/0xabcdef0000000000000000000000000000000001');
    expect(tokenHref({ chain: 'solana', address: 'AbCd1234' })).toBe('/token#/solana/AbCd1234');
  });

  it('says how old data is in plain words', () => {
    const now = 10_000_000_000;
    expect(ago(null, now)).toBe('never');
    expect(ago(now - 30_000, now)).toBe('just now');
    expect(ago(now - 10 * 60_000, now)).toBe('10 min ago');
    expect(ago(now - 5 * 3_600_000, now)).toBe('5 h ago');
    expect(ago(now - 3 * 86_400_000, now)).toBe('3 d ago');
  });

  it('shows the Verified badge from the site\'s verified list, by its rules (audit I-26)', () => {
    const now = () => Date.parse('2026-11-10T00:00:00Z');
    const entry = { token: '0xABCDEF0000000000000000000000000000000001', chain: 'bnb' as const, date: '2026-11-02', checked: ['supply-fixed', 'powers-given-up', 'identity-matches', 'pool-locked'] as const, evidence: 'https://aretiafinance.org/docs/verified/x.txt' };
    const check = verifiedChecker([entry], now);
    expect(check('bnb', '0xabcdef0000000000000000000000000000000001')).toBe(true);
    expect(check('bnb', '0xabcdef0000000000000000000000000000000002')).toBe(false);
    expect(check('ethereum', '0xabcdef0000000000000000000000000000000001')).toBe(false);
    // An entry that does not record all four checks never shows a badge.
    expect(verifiedChecker([{ ...entry, checked: ['supply-fixed'] }], now)('bnb', entry.token)).toBe(false);
    // The site's own list is used by default (empty until a token is verified).
    expect(verifiedChecker()('bnb', entry.token)).toBe(false);
  });
});

describe('the wallet page has Launch Box', () => {
  const page = readFileSync(new URL('../pages/wallet/index.astro', import.meta.url), 'utf8');
  const sidebar = page.slice(page.indexOf('<nav class="wapp__nav"'), page.indexOf('</nav>', page.indexOf('<nav class="wapp__nav"')));
  it('has a sidebar entry called Launch Box and a pane for it', () => {
    expect(sidebar).toContain('data-nav="launchbox"');
    expect(sidebar).toContain('Launch Box');
    expect(page).toContain('data-pane="launchbox"');
    expect(page).toContain('data-lb-root');
  });
  it('does not ask for a wallet to look at it', () => {
    expect(page).toMatch(/\[data-connected='false'\]\[data-view='launchbox'\] \.wapp__gate \{ display: none; \}/);
  });
});

describe('the server wiring', () => {
  const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')) as { rewrites: { source: string; destination: string }[]; crons?: { path: string; schedule: string }[] };
  it('reaches the two Launch Box paths through the shared function, so no new serverless function is needed', () => {
    const have = new Map(config.rewrites.map((r) => [r.source, r.destination]));
    expect(have.get('/api/launchbox')).toBe('/api/swings-data?route=launchbox');
    expect(have.get('/api/launchbox-run')).toBe('/api/swings-data?route=launchbox-run');
  });
  it('schedules the indexer once a day (the most the Hobby plan allows)', () => {
    expect(config.crons).toEqual([{ path: '/api/launchbox-run', schedule: '0 4 * * *' }]);
  });
});

describe('the headline numbers', () => {
  it('adds up what is known and shows a dash for what is not', () => {
    expect(launchStats([{ volume24hUsd: 100, liquidityUsd: 40 }, { volume24hUsd: null, liquidityUsd: 10 }, { volume24hUsd: 50, liquidityUsd: null }])).toEqual({ tokens: 3, volumeUsd: 150, liquidityUsd: 50 });
    expect(launchStats([{ volume24hUsd: null, liquidityUsd: null }])).toEqual({ tokens: 1, volumeUsd: null, liquidityUsd: null });
    expect(launchStats([])).toEqual({ tokens: 0, volumeUsd: null, liquidityUsd: null });
  });
  it('ignores a figure that is not a usable number', () => {
    expect(launchStats([{ volume24hUsd: Number.NaN, liquidityUsd: -5 }, { volume24hUsd: 7, liquidityUsd: 3 }])).toEqual({ tokens: 2, volumeUsd: 7, liquidityUsd: 3 });
  });
});
