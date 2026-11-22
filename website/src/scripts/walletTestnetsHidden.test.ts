import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LAUNCH_EVM_CHAINS } from './walletLaunchEvmCore';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('the Launch page offers mainnets only', () => {
  it('never lists a test network, even one that has a factory', () => {
    // The Launch page builds its network chips from this list, skipping every test network before it checks for a factory.
    const src = read('./walletLaunch.ts');
    const at = src.indexOf('function networks(): LaunchNetwork[]');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('function draw(): void', at));
    expect(body).toContain('if (c.testnet) continue;');
    expect(body.indexOf('if (c.testnet) continue;')).toBeLessThan(body.indexOf('out.push('));
  });

  it('keeps the test networks in the tables for the owner’s own scripts, all without a deployed factory', () => {
    const tests = LAUNCH_EVM_CHAINS.filter((c) => c.testnet);
    expect(tests.length).toBeGreaterThan(0);
    for (const c of tests) expect(c.factory).toBeNull();
  });

  it('shows no mention of a devnet or test network on the wallet page', () => {
    const page = read('../pages/wallet/index.astro');
    expect(page).not.toMatch(/devnet|test network/i);
  });
});
