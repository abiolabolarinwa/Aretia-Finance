import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (f: string): string => readFileSync(new URL(f, import.meta.url), 'utf8');

describe('where the pool details and the docked panel show', () => {
  it('one pool-details group (age, amounts, pool and token addresses) is shared by the panel and the token page', () => {
    const panel = read('./walletMarketPanel.ts');
    expect(panel).toContain('export function poolDetailsGroup(');
    expect(panel).toContain("'Pool opened'");
    expect(panel).toContain("'Token address'");
    expect(panel.match(/poolDetailsGroup\(/g)?.length).toBe(2);
  });
  it('the token page that opens on a click carries the pool details', () => {
    expect(read('./walletTokenPage.ts')).toContain('poolDetailsGroup({ chain: o.chain, address: o.address, pool,');
  });
  it('the docked panel shows only while Bullish only is on, and never over a token page', () => {
    expect(read('./walletSwings.ts')).toContain('panel.element.hidden = page || !f.bullish;');
  });
});
