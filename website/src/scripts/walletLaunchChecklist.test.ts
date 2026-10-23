import { describe, expect, it } from 'vitest';
import { estimateCost } from './walletLaunchCore';
import { estimateSolanaForm, evmChecklist, rentFor, solanaChecklist } from './walletLaunchChecklist';

const cost = estimateCost({ mintDeposit: 3_000_000n, tokenAccountDeposit: 2_000_000n, accountCount: 1 });
const base = { symbol: 'EXMP', supplyText: '1,000,000,000', nameChangeable: false, creatorBps: 1000, treasuryBps: 0, cost, exact: true };

describe('solanaChecklist', () => {
  it('lists the supply, both authorities and the name as locked, and the pool rule', () => {
    const c = solanaChecklist(base);
    const text = c.locked.join(' ');
    expect(text).toContain('1,000,000,000 EXMP');
    expect(text).toMatch(/mint more/);
    expect(text).toMatch(/freeze/);
    expect(text).toContain('cannot be changed after creation');
    expect(text).toMatch(/locked for good/);
  });
  it('says plainly when the name stays changeable', () => {
    expect(solanaChecklist({ ...base, nameChangeable: true }).locked.join(' ')).toContain('Not locked');
  });
  it('adds the cost lines up to the total, in SOL', () => {
    const c = solanaChecklist(base);
    expect(c.cost.map((l) => l.label)).toEqual(['Aretia fee', 'Network fees', 'Deposits for 2 accounts (the token and 1 wallet)', 'Total']);
    expect(c.cost[0]!.value).toBe('0.05 SOL');
    expect(c.cost[1]!.value).toBe('0.000015 SOL');
    expect(c.cost[2]!.value).toBe('0.005 SOL');
    // 0.05 + 0.000015 + 0.005
    expect(c.cost[3]).toEqual({ label: 'Total', value: '0.055015 SOL', total: true });
  });
  it('marks an estimate as "about"', () => {
    const c = solanaChecklist({ ...base, exact: false });
    expect(c.cost.at(-1)!.label).toBe('Total, about');
    expect(c.costNote).toMatch(/estimate/);
  });
  it('says what the creator keeps, with a treasury share', () => {
    const c = solanaChecklist({ ...base, treasuryBps: 500 });
    expect(c.keeps[0]).toContain('10% as your share and 85% held back, 95% in all');
    expect(c.keeps.join(' ')).toContain('5% goes to the treasury');
    expect(c.keeps.join(' ')).toContain('Nothing locks the tokens you keep');
  });
  it('asks for a share while the percentage is not valid', () => {
    expect(solanaChecklist({ ...base, creatorBps: null }).keeps[0]).toMatch(/Enter your share/);
  });
  it('never claims safety', () => {
    const all = JSON.stringify(solanaChecklist(base));
    expect(all).not.toMatch(/\bsafe\b|audited|guarantee|secure|rug/i);
  });
});

describe('the form estimate', () => {
  it('uses the rent rule and counts a treasury wallet', () => {
    expect(rentFor(165)).toBe((165n + 128n) * 6960n);
    const one = estimateSolanaForm({ creatorPct: '10', treasuryPct: '0', treasuryAddress: '', mintBytes: 400, tokenAccountBytes: 170 });
    const two = estimateSolanaForm({ creatorPct: '10', treasuryPct: '5', treasuryAddress: 'Addr', mintBytes: 400, tokenAccountBytes: 170 });
    expect(one.accountCount).toBe(1);
    expect(two.accountCount).toBe(2);
    expect(two.total - one.total).toBe(rentFor(170));
    expect(one.aretiaFee).toBe(50_000_000n);
  });
});

describe('evmChecklist', () => {
  const e = { symbol: 'EXMP', supplyText: '1000', coin: 'BNB', mode: 'locked' as const, testnet: false, feeWei: 28n * 10n ** 15n, poolCoinWei: 10n ** 17n, poolBps: 7000, gasWei: 10n ** 15n };
  it('totals the fee, the pool coin and the gas', () => {
    const c = evmChecklist(e);
    expect(c.cost.map((l) => l.value)).toEqual(['0.028 BNB', '0.1 BNB', '0.001 BNB', '0.129 BNB']);
    expect(c.locked.join(' ')).toContain('70% of the supply');
    expect(c.keeps[0]).toContain('30%');
  });
  it('says gas is priced later when it is not known yet', () => {
    const c = evmChecklist({ ...e, gasWei: null });
    expect(c.cost.at(-2)!.value).toBe('priced at Review');
    expect(c.cost.at(-1)!.label).toBe('Total so far');
  });
  it('plain mode has no pool and keeps everything', () => {
    const c = evmChecklist({ ...e, mode: 'plain', poolCoinWei: 0n, poolBps: 0, feeWei: 14n * 10n ** 15n });
    expect(c.locked.join(' ')).toContain('opens no pool');
    expect(c.cost.map((l) => l.label)).not.toContain('Coin for the locked pool');
    expect(c.keeps[0]).toContain('whole supply');
  });
});
