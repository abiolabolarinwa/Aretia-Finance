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
