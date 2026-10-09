import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { configuredRateBps, disclose, selectFee } from './disclosure.js';
import { combineLegs, type ExecutionLeg } from '../plan/executionQuote.js';
import { DEFAULT_FEE_CONFIG, liveFeeConfig, LIVE_FEE_CONFIG } from '../core/fee.js';

const NOW = 1_000_000;
const SOL = 'So11111111111111111111111111111111111111112';
const leg = (kind: ExecutionLeg['kind'], from: string, to: string, inAmt: bigint | null, outAmt: bigint | null, fees: ExecutionLeg['fees'] = [], chain: 'solana' | 'base' = 'solana'): ExecutionLeg => ({
  id: kind + from, kind, title: kind,
  input: { chain, assetKey: from, symbol: from.toUpperCase(), decimals: 6, amount: inAmt },
  output: { chain, assetKey: to, symbol: to.toUpperCase(), decimals: 6, amount: outAmt },
  fees, estimatedSeconds: 30, risk: 'low', signatures: 1, expiresAt: NOW + 60_000, notes: [],
});

describe('Aretia fee economics', () => {
  it('reads the rate from the one place it is set, and it is the 0.29% the owner chose, not a copy of another number', () => {
    expect(configuredRateBps()).toBe(LIVE_FEE_CONFIG.policy.rateBps);
    expect(configuredRateBps()).toBe(29);
    const files: string[] = [];
    const walk = (d: string): void => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.ts$/.test(f) && !/\.test\.ts$|fee\.ts$/.test(f)) files.push(p); } };
    walk(join(process.cwd(), 'src/swings/economics'));
    walk(join(process.cwd(), 'src/swings/plan'));
    expect(files.filter((f) => /rateBps\s*[:=]\s*\d/.test(readFileSync(f, 'utf8')))).toEqual([]);
  });

  it('puts the fee on at most one swap in a multi-step plan, so the same money is not charged twice', () => {
    const legs = [leg('swap', 'sol', 'usdc', 1_000_000n, 900_000n), leg('settlement', 'usdc', 'usdc', 900_000n, 899_000n), leg('swap', 'usdc', 'act', 899_000n, 5n)];
    const a = selectFee(legs, ['solana', 'solana', 'solana']);
    expect(a.legIndex).toBe(0);
    expect(a.amount).toBe((1_000_000n * 29n) / 10_000n);
  });

  it('charges nothing on a ramp or a settlement alone, and says why', () => {
    const a = selectFee([leg('ramp-buy', 'usd', 'usdc', 100n, null), leg('settlement', 'usdc', 'usdc', 100n, 99n)], ['solana', 'solana']);
    expect(a).toMatchObject({ legIndex: null, amount: 0n });
    expect(a.reason).toMatch(/No step in this plan is a swap/);
  });

  it('is off when the policy is off, and on every network once the EVM fee address is set', () => {
    expect(selectFee([leg('swap', 'sol', 'act', 1_000_000n, 1n)], ['solana'], DEFAULT_FEE_CONFIG)).toMatchObject({ legIndex: null, reason: 'The Aretia fee is switched off.' });
    expect(selectFee([leg('swap', 'usdc', 'act', 1_000_000n, 1n, [], 'base')], ['base'], liveFeeConfig('0x1111111111111111111111111111111111111111'))).toMatchObject({ legIndex: 0, amount: 2_900n });
  });

  it('reports a blocked fee instead of quietly charging nothing', () => {
    const a = selectFee([leg('swap', 'usdc', 'act', 1_000_000n, 1n, [], 'base')], ['base']);
    expect(a.legIndex).toBeNull();
    expect(a.reason).toMatch(/blocked.*fee address/);
  });
});

describe('disclosure', () => {
  const q = combineLegs('q', [
    leg('ramp-buy', 'fiat:usd', 'usdc', 100n, null, [{ label: 'MoonPay fee and exchange rate', kind: 'ramp', assetKey: 'fiat:usd', symbol: 'USD', decimals: 0, amount: null }, { label: 'Aretia fee', kind: 'ramp', assetKey: 'fiat:usd', symbol: 'USD', decimals: 0, amount: 0n }]),
    leg('swap', 'usdc', 'act', null, 5n, [{ label: 'Network fee', kind: 'network', assetKey: SOL, symbol: 'SOL', decimals: 9, amount: 5000n }, { label: 'Venue fee', kind: 'dex', assetKey: 'usdc', symbol: 'USDC', decimals: 6, amount: 25n }, { label: 'Aretia fee (0.29%)', kind: 'aretia-fee', assetKey: 'usdc', symbol: 'USDC', decimals: 6, amount: 4_950n }]),
  ]);

  it('lists every cost on its own line, in its own asset, in a fixed order, with no generic fee', () => {
    const lines = disclose(q);
    expect(lines.map((l) => l.kind)).toEqual(['amount', 'amount', 'network', 'dex', 'ramp', 'ramp', 'aretia-fee']);
    expect(lines.find((l) => l.label.includes('Network'))!.value).toBe('0.000005 SOL');
    expect(lines.find((l) => l.kind === 'aretia-fee')!.value).toBe('0.00495 USDC');
    expect(lines.find((l) => l.label.includes('MoonPay'))!.value).toMatch(/not known: shown by the provider/);
    expect(lines.find((l) => l.label.endsWith('Aretia fee'))!.value).toBe('0 USD');
    expect(lines.some((l) => /^fee$|^total/i.test(l.label))).toBe(false);
  });

  it('says it does not know what you receive when a step has no price, instead of showing a number', () => {
    const r = disclose(q).find((l) => l.label === 'You receive')!;
    expect(r.value).toMatch(/not known until the provider shows its price/);
  });
});
