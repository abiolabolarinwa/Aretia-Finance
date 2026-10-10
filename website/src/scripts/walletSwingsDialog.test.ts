import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./walletSwings.ts', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('function safetyBlock'), src.indexOf('function summaryRows'));

describe('safety findings in the swap pop-out', () => {
  it('returns before the findings are built when the pop-out is open, keeping only the acknowledgement', () => {
    const dialogBranch = block.indexOf('swapDialog && !swapDialog.hidden');
    expect(dialogBranch).toBeGreaterThan(-1);
    expect(dialogBranch).toBeLessThan(block.indexOf('Know before you sign'));
    expect(block.slice(dialogBranch, block.indexOf('Know before you sign'))).toContain('acknowledgement(');
    expect(block.slice(dialogBranch, block.indexOf('Know before you sign'))).not.toContain('v.headline');
  });
});
