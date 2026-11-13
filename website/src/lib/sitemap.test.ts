import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSitemap, PUBLIC_PAGES, SITE } from './sitemap.js';

describe('sitemap', () => {
  it('lists the public pages and the posts with their dates, and nothing private', () => {
    const xml = buildSitemap([{ id: 'act-transfer-fee-on-chain', date: new Date('2026-03-04T00:00:00Z') }]);
    expect(xml).toContain(`<loc>${SITE}/wallet</loc>`);
    expect(xml).toContain(`<loc>${SITE}/blog/act-transfer-fee-on-chain</loc><lastmod>2026-03-04</lastmod>`);
    for (const hidden of ['owner-admin', '/404', '/search', '/api']) expect(xml).not.toContain(hidden);
    expect(xml.startsWith('<?xml')).toBe(true);
  });

  it('lists the guides and one page per network', () => {
    const xml = buildSitemap([], undefined, [{ id: 'what-is-liquidity-in-a-token-pool', date: new Date('2026-11-13') }]);
    expect(xml).toContain(`<loc>${SITE}/learn/what-is-liquidity-in-a-token-pool</loc><lastmod>2026-11-13</lastmod>`);
    for (const c of ['solana', 'ethereum', 'bnb', 'base', 'polygon', 'robinhood']) expect(xml).toContain(`<loc>${SITE}/chains/${c}</loc>`);
    expect(xml).toContain(`<loc>${SITE}/learn</loc>`);
  });

  it('escapes what XML does not allow in an address', () => {
    expect(buildSitemap([{ id: 'a&b<c', date: new Date('2026-01-01') }], [])).toContain('/blog/a&amp;b&lt;c');
  });

  it('only lists pages that exist in the site', () => {
    const pagesDir = resolve(__dirname, '../pages');
    for (const p of PUBLIC_PAGES) {
      const base = p.replace(/^\//, '');
      if (base.startsWith('chains/')) continue; // one template page for every network (chains/[chain].astro)
      const found = [`${base}.astro`, `${base}/index.astro`].some((f) => existsSync(resolve(pagesDir, f)));
      expect(found, p).toBe(true);
    }
  });
});
