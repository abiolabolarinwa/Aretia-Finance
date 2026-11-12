import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./walletSwings.ts', import.meta.url), 'utf8').replace(/\r/g, '');

describe('a Markets list chosen by the person is shown whole', () => {
  it('gathers the feed, the deep walk and the index behind a loading state with a count, with a time limit', () => {
    expect(src).toContain('async function gatherAll(');
    expect(src).toContain('GATHER_BUDGET_MS');
    expect(src).toContain('Loading all tokens… ');
    expect(src).toContain('rows === null || gathering');
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
