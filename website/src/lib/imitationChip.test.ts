import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { imitationChip, IMITATION_TEXT } from './imitationChip';

/** Just enough of a DOM element for the chip. */
const fakeDocument = { createElement: () => ({ className: '', textContent: '', title: '', attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; } }) };

describe('the "Not the real one" chip (re-audit L-15)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is made for a look-alike name at an unknown address, and not for the real token', () => {
    vi.stubGlobal('document', fakeDocument);
    const chip = imitationChip('solana', 'Fake1111111111111111111111111111111111111111', 'ᴜꜱᴅᴄ', 'x') as unknown as { className: string; textContent: string; title: string; attrs: Record<string, string> };
    expect(chip.className).toBe('wapp-lb__imitates');
    expect(chip.textContent).toBe(IMITATION_TEXT);
    expect(chip.title).toMatch(/calls itself USDC/);
    expect(chip.attrs['aria-label']).toBe(chip.title);
    expect(imitationChip('solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC', 'USD Coin')).toBeNull();
    expect(imitationChip('solana', 'Fake1111111111111111111111111111111111111111', 'BONK', 'Bonk')).toBeNull();
  });

  it('is shown in Launch Box, Markets rows, the top-bar search and the swap token picker', () => {
    const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
    for (const file of ['../scripts/walletLaunchBox.ts', '../scripts/walletMarketTable.ts', '../scripts/walletSearch.ts', '../scripts/walletSwings.ts']) {
      const src = read(file);
      expect(src, file).toMatch(/import \{ imitationChip \} from '\.\.\/lib\/imitationChip'/);
      expect(src.match(/imitationChip\(/g)?.length ?? 0, file).toBeGreaterThanOrEqual(1);
    }
    expect(read('../scripts/walletMarketTable.ts')).toMatch(/imitationChip\(r\.chain, r\.address, r\.symbol, r\.name\)/);
    expect(read('../scripts/walletSearch.ts')).toMatch(/imitationChip\(h\.chain, h\.address, h\.symbol, h\.name\)/);
    expect(read('../scripts/walletSwings.ts')).toMatch(/imitationChip\(s\.chain, t\.mint, t\.symbol, t\.name\)/);
  });
});
