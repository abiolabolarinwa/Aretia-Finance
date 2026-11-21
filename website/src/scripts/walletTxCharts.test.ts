import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('the Transactions pane Charts view', () => {
  const table = readFileSync(new URL('./walletTxTable.ts', import.meta.url), 'utf8');
  it('is chosen beside All / Buys / Sells and draws the charts for the trades shown', () => {
    expect(table).toContain("['table', 'Table'], ['charts', 'Charts']");
    expect(table).toContain("if (view === 'charts') return renderCharts(scroll, shown,");
  });
  it('draws with SVG and text only, never markup', () => {
    const code = readFileSync(new URL('./walletTxCharts.ts', import.meta.url), 'utf8');
    expect(code).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    for (const title of ['Buys against sells', 'Trade sizes', 'Traded value over time', 'Who traded the most']) expect(code).toContain(title);
  });
});
