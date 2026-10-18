import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ago, tokenHref } from './walletLaunchBox';
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

  it('shows the Verified badge only when a verified-tokens module provides isVerified', () => {
    expect(verifiedChecker({})).toBeNull();
    expect(verifiedChecker({ a: { somethingElse: 1 } })).toBeNull();
    const check = verifiedChecker({ a: { isVerified: (c: string, a: string) => c === 'bnb' && a === '0x1' } });
    expect(check?.('bnb', '0x1')).toBe(true);
    expect(check?.('bnb', '0x2')).toBe(false);
    // A module that throws never breaks the page.
    expect(verifiedChecker({ a: { isVerified: () => { throw new Error('x'); } } })?.('bnb', '0x1')).toBe(false);
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
