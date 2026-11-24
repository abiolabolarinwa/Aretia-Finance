import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MARK_PIECES, markSvg } from './loader';
import { isLoadingText } from './loadingMarks';

const loaderSource = readFileSync(new URL('./loader.ts', import.meta.url), 'utf8');

describe('the Aretia loading mark', () => {
  it('draws the logo: the outlined square, the tile and the two jaws, hidden from screen readers (the message is the label)', () => {
    const svg = markSvg(40);
    expect(MARK_PIECES.map((p) => p.id)).toEqual(['back', 'top', 'bottom']);
    for (const p of MARK_PIECES) expect(svg).toContain(`aretia-mark__${p.id}`);
    expect(svg).toContain('aretia-mark__tile');
    expect(svg).toContain('viewBox="0 0 320 320"');
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('width="40"');
    expect(markSvg('1.15em')).toContain('width="1.15em"');
  });
  it('can fill and centre itself in the area it is placed in, for a list with nothing to show yet', () => {
    const css = readFileSync(new URL('../styles/global.css', import.meta.url), 'utf8');
    expect(css).toMatch(/.aretia-loading--fill {[^}]*align-content: center;[^}]*min-height:/);
    expect(loaderSource).toContain('aretia-loading--fill');
  });
  it('recognises the loading messages the pages show, and nothing else', () => {
    for (const t of ['Loading…', 'Loading activity…', 'Checking the transfer…', 'Searching…', 'Waiting for your wallet to approve…', 'Analyzing this token. This can take up to a minute…'.replace('. This', ' this'), 'Working...', 'Looking for the pool this token trades on…'])
      expect(isLoadingText(t), t).toBe(true);
    for (const t of ['Loaded', 'Loading failed.', 'Check your connection…?', 'Nothing matches these filters right now.', 'Search', 'Your balance is 5', ''])
      expect(isLoadingText(t), t).toBe(false);
  });
  it('is styled for motion and for people who ask for less of it', () => {
    const css = readFileSync(new URL('../styles/global.css', import.meta.url), 'utf8');
    expect(css).toContain('@keyframes aretia-chomp-top');
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.aretia-mark__back/);
  });
  it('is switched on for every page by the shared layout', () => {
    const base = readFileSync(new URL('../layouts/Base.astro', import.meta.url), 'utf8');
    expect(base).toContain('startLoadingMarks()');
  });
});
