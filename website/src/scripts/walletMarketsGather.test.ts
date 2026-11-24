import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./walletSwings.ts', import.meta.url), 'utf8').replace(/\r/g, '');

describe('a Markets list chosen by the person is shown whole', () => {
  it('gathers the feed, the deep walk and the index behind a loading state with a count, with a time limit', () => {
    expect(src).toContain('async function gatherAll(');
    expect(src).toContain('GATHER_BUDGET_MS');
    expect(src).toContain('Loading all tokens… ');
    // the loading state stands in unless the list this person saw last time is on screen meanwhile
    expect(src).toContain('rows === null || (gathering && previewAt === null)');
  });
  it('only a list the person chose waits; a refresh stays quiet and never redraws under the reader', () => {
    expect(src).toContain('if (!silent && isRanked(m.kind)) await gatherAll(mine);\n          else void addIndexRows(mine, true);');
    expect(src).toContain('if (!quiet && !page) draw();');
  });
  it("choosing a network starts from the loading state, not the last network's tokens", () => {
    const at = src.indexOf('setChain(id: ChainId');
    const block = src.slice(at, at + 900);
    expect(block).toContain('rows = null;');
    expect(block).toContain('indexRows = [];');
  });
});

describe('the list seen last time stands in while the full list is gathered', () => {
  it('is read only when nothing is on screen, for one network and one list, and is saved again when the full list is in', () => {
    expect(src).toContain("const previewable = (): boolean => isRanked(m.kind) && m.chain !== '';");
    expect(src).toContain('if (rows === null && previewable()) {');
    expect(src).toContain('saveList(browserStorage(), previewKey(), rows, Date.now())');
  });
  it('says plainly that it is the older list, and does not redraw the table as tokens arrive', () => {
    expect(src).toContain('while the latest loads.');
    expect(src).toContain('gathering && previewAt === null && !page &&');
  });
  it('never saves an old copy as if it were new', () => {
    expect(src).toContain('staleAt === null && rows !== null && rows.length > 0 && previewable()');
  });
});
