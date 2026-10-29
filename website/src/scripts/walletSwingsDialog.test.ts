import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./walletSwings.ts', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('function safetyBlock'), src.indexOf('function summaryRows'));

describe('the swap review safety block', () => {
  it('shows no findings card: only the acknowledgement that gates the Swap button, and only when the token needs one', () => {
    expect(block).not.toContain('Know before you sign');
    expect(block).not.toContain('v.headline');
    expect(block).toContain('v.needsAcknowledgement');
    expect(block).toContain('acknowledgement(');
  });
});
