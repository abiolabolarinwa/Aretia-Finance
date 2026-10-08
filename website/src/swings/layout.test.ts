import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f: string): string => readFileSync(join(process.cwd(), f), 'utf8');

describe('wallet page wiring', () => {
  it('only the wallet\'s own buttons navigate: a bare [data-nav] selector also matches the site top bar, which now holds the Swings tabs and search box', () => {
    const app = read('src/scripts/walletApp.ts');
    expect(app).not.toMatch(/querySelectorAll<HTMLElement>\('\[data-nav\]'\)/);
    expect(app).toMatch(/\[data-wapp\] \[data-nav\]/);
    // the thing the bug depended on: the top bar carries the attribute
    expect(read('src/components/navigation/Nav.astro')).toMatch(/data-nav/);
  });

  it('the token list inside the swap card has room to open', () => {
    expect(read('src/pages/wallet/index.astro')).toMatch(/\.wapp__swap:has\(\.wapp__picker:not\(\[hidden\]\)\)\s*\{\s*min-height/);
  });
});
