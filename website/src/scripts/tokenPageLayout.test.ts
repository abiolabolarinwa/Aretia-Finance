import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('the full token page on a wide screen', () => {
  const page = readFileSync(new URL('../pages/wallet/index.astro', import.meta.url), 'utf8');
  it('gives back the docked panel\'s column and padding when that panel is hidden', () => {
    expect(page).toContain("[data-wapp].wapp[data-view='swings']:has(> .wapp-mp[hidden]) { grid-template-columns: var(--wapp-side) 56px minmax(0, 1fr); }");
    expect(page).toContain("[data-wapp].wapp[data-view='swings']:has(> .wapp-mp[hidden]) .wapp__main { padding-right: 36px; }");
  });
  it('still reserves the column while the panel is shown', () => {
    expect(page).toContain("[data-wapp].wapp[data-view='swings'] { grid-template-columns: var(--wapp-side) 56px minmax(0, 1fr) 360px; }");
  });
});

describe('the token page header', () => {
  const code = readFileSync(new URL('./walletTokenPage.ts', import.meta.url), 'utf8');
  it('carries the numbers in the top row and has no hide-panel control', () => {
    expect(code).toContain('data-tp-stats');
    for (const label of ['Liquidity', 'FDV', 'Market cap', 'Txns 24H', 'Buys', 'Sells']) expect(code).toContain(`stat('${label}'`);
    expect(code).not.toContain('Hide panel');
    expect(code).not.toContain('is-collapsed');
  });
});

describe('the token list window', () => {
  const code = readFileSync(new URL('./walletSwings.ts', import.meta.url), 'utf8');
  it('is not styled as the old drop-down, which pinned it to the corner of the page', () => {
    expect(code).toContain("class: 'wapp-pk__card'");
    expect(code).not.toContain('wapp-pk__card wapp__pick-pop');
  });
});

