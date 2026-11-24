import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rememberView, sidebarItemFor, tokenOpenMode, viewToResume } from './walletNav';

describe('sidebarItemFor', () => {
  it('keeps Markets marked while the Swap page is open', () => {
    expect(sidebarItemFor('swap')).toBe('swings');
  });

  it('leaves every other view as it is', () => {
    for (const view of ['dashboard', 'swings', 'favourites', 'send', 'launch', 'carbon', 'activity', 'shield']) {
      expect(sidebarItemFor(view)).toBe(view);
    }
  });
});

describe('tokenOpenMode', () => {
  it('opens the swap as a window over the list on Markets', () => {
    expect(tokenOpenMode('#/swings')).toBe('markets-dialog');
    expect(tokenOpenMode('#/swings/solana/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe('markets-dialog');
  });

  it('does the same on Favourites, instead of sending a favourite token to the Swap page', () => {
    expect(tokenOpenMode('#/favourites')).toBe('markets-dialog');
  });

  it('uses the swap already on screen on the Swap page', () => {
    expect(tokenOpenMode('#/swap')).toBe('swap-page');
  });

  it('goes to the Swap page from any other page', () => {
    for (const hash of ['#/dashboard', '#/send', '#/activity', '#/shield', '', '#/unknown']) {
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

describe('opening the wallet where the person left off', () => {
  const store = (v: string | null) => ({ getItem: () => v, setItem: () => undefined });
  it('goes back to the last page only for the plain wallet address', () => {
    expect(viewToResume(store('swings'), '/wallet', '')).toBe('swings');
    expect(viewToResume(store('radar'), '/wallet/', '#')).toBe('radar');
    expect(viewToResume(store('swings'), '/wallet', '#/send')).toBeNull();
    expect(viewToResume(store('swings'), '/wallet/solana/So11111111111111111111111111111111111111112', '')).toBeNull();
  });
  it('never goes back to the dashboard, the game or anything unknown, and survives blocked storage', () => {
    for (const v of ['dashboard', 'ultimate-city-search', 'shield', '', 'nonsense']) expect(viewToResume(store(v), '/wallet', '')).toBeNull();
    expect(viewToResume(null, '/wallet', '')).toBeNull();
    expect(viewToResume({ getItem: () => { throw new Error('blocked'); }, setItem: () => undefined }, '/wallet', '')).toBeNull();
  });
  it('remembers a page worth returning to and clears the memory on one that is not', () => {
    const seen: string[] = [];
    const s = { getItem: () => null, setItem: (_k: string, v: string) => void seen.push(v) };
    rememberView(s, 'swings');
    rememberView(s, 'dashboard');
    expect(seen).toEqual(['swings', '']);
    expect(() => rememberView({ getItem: () => null, setItem: () => { throw new Error('blocked'); } }, 'send')).not.toThrow();
  });
});
