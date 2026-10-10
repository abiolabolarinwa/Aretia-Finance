import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sidebarItemFor, tokenOpenMode } from './walletNav';

describe('sidebarItemFor', () => {
  it('keeps Markets marked while the Swap page is open', () => {
    expect(sidebarItemFor('swap')).toBe('swings');
  });

  it('leaves every other view as it is', () => {
    for (const view of ['dashboard', 'swings', 'favourites', 'send', 'carbon', 'activity', 'shield', 'intent', 'safesend', 'universal']) {
      expect(sidebarItemFor(view)).toBe(view);
    }
  });
});

describe('tokenOpenMode', () => {
  it('opens the swap as a window over the list on Markets', () => {
    expect(tokenOpenMode('#/swings')).toBe('markets-dialog');
  });

  it('does the same on Favourites, instead of sending a favourite token to the Swap page', () => {
    expect(tokenOpenMode('#/favourites')).toBe('markets-dialog');
  });

  it('uses the swap already on screen on the Swap page', () => {
    expect(tokenOpenMode('#/swap')).toBe('swap-page');
  });

  it('goes to the Swap page from any other page', () => {
    for (const hash of ['#/dashboard', '#/send', '#/activity', '#/shield', '#/intent', '', '#/unknown']) {
      expect(tokenOpenMode(hash)).toBe('go-to-swap');
    }
  });
});

describe('the wallet page', () => {
  const page = readFileSync(new URL('../pages/wallet/index.astro', import.meta.url), 'utf8');
  const sidebar = page.slice(page.indexOf('<nav class="wapp__nav"'), page.indexOf('</nav>', page.indexOf('<nav class="wapp__nav"')));

  it('has no Swap entry in the sidebar, and still has Markets', () => {
    expect(sidebar).toContain('data-nav="swings"');
    expect(sidebar).not.toContain('data-nav="swap"');
  });

  it('still lets other buttons open the Swap page (for example the dashboard\'s Swap button)', () => {
    expect(page).toContain('data-nav="swap"');
  });
});
