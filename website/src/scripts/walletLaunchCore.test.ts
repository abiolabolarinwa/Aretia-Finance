import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FORM,
  LAUNCH_LIMITS,
  bpsText,
  configFromJson,
  configToJson,
  disclosuresOf,
  distributionOf,
  estimateCost,
  pctToBps,
  validateLaunch,
  type LaunchForm,
} from './walletLaunchCore';

const CREATOR = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const TREASURY = '2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2';
const form = (over: Partial<LaunchForm> = {}): LaunchForm => ({ ...DEFAULT_FORM, name: 'Aretia Test Token', symbol: 'ATEST', ...over });
const good = (over: Partial<LaunchForm> = {}) => {
  const r = validateLaunch(form(over), CREATOR);
  if (!r.ok) throw new Error(r.issues.map((i) => `${i.field}: ${i.message}`).join('; '));
  return r.config;
};
const issuesOf = (over: Partial<LaunchForm>, creator = CREATOR) => {
  const r = validateLaunch(form(over), creator);
  return r.ok ? [] : r.issues;
};

describe('pctToBps', () => {
  it('reads plain percentages with at most two decimals', () => {
    expect(pctToBps('10')).toBe(1000);
    expect(pctToBps('12.5')).toBe(1250);
    expect(pctToBps(' 0.05 ')).toBe(5);
    expect(pctToBps('100')).toBe(10_000);
  });
  it('rejects everything else', () => {
    for (const bad of ['', '-1', '1e2', '1.234', '101', '1,5', 'ten', '.5', '5.']) expect(pctToBps(bad), bad).toBeNull();
  });
  it('prints percentages without trailing zeros', () => {
    expect([bpsText(1000), bpsText(1250), bpsText(5), bpsText(10_000)]).toEqual(['10%', '12.5%', '0.05%', '100%']);
  });
});

describe('validateLaunch', () => {
  it('accepts the defaults once a name and symbol are given', () => {
    const c = good();
    expect(c).toMatchObject({ name: 'Aretia Test Token', symbol: 'ATEST', decimals: 6, creatorBps: 1000, reservedBps: 9000, treasury: null });
    expect(c.totalSupplyRaw).toBe(1_000_000_000n * 10n ** 6n);
  });
  it('requires a connected wallet', () => {
    expect(issuesOf({}, '').map((i) => i.field)).toContain('form');
  });
  it('checks name and symbol', () => {
    expect(issuesOf({ name: '  ' }).map((i) => i.field)).toContain('name');
    expect(issuesOf({ name: 'x'.repeat(33) }).map((i) => i.field)).toContain('name');
    expect(issuesOf({ name: 'bad\nname' }).map((i) => i.field)).toContain('name');
    expect(issuesOf({ symbol: 'A B' }).map((i) => i.field)).toContain('symbol');
    expect(issuesOf({ symbol: 'ABCDEFGHIJK' }).map((i) => i.field)).toContain('symbol');
    expect(issuesOf({ symbol: '' }).map((i) => i.field)).toContain('symbol');
  });
  it('keeps decimals and supply inside what Solana can hold', () => {
    expect(issuesOf({ decimals: '10' }).map((i) => i.field)).toContain('decimals');
    expect(issuesOf({ decimals: '-1' }).map((i) => i.field)).toContain('decimals');
    expect(issuesOf({ decimals: '1.5' }).map((i) => i.field)).toContain('decimals');
    expect(issuesOf({ supply: '0' }).map((i) => i.field)).toContain('supply');
    expect(issuesOf({ supply: '1.1234567', decimals: '6' }).map((i) => i.field)).toContain('supply');
    // 2^64 raw is one more than a Solana token can hold.
    expect(issuesOf({ supply: '18446744073709.551616', decimals: '6' }).map((i) => i.field)).toContain('supply');
    expect(good({ supply: '18446744073709.551615', decimals: '6', creatorPct: '0', treasuryPct: '0' }).totalSupplyRaw).toBe(LAUNCH_LIMITS.supplyMax);
  });
  it('caps the creator and treasury shares and keeps something held back', () => {
    expect(issuesOf({ creatorPct: '20.01' }).map((i) => i.field)).toContain('creatorPct');
    expect(issuesOf({ treasuryPct: '10.01', treasuryAddress: TREASURY }).map((i) => i.field)).toContain('treasuryPct');
    expect(good({ creatorPct: '20', treasuryPct: '10', treasuryAddress: TREASURY }).reservedBps).toBe(7000);
  });
  it('needs a valid address for a treasury share, and rejects a bad one even with no share', () => {
    expect(issuesOf({ treasuryPct: '5', treasuryAddress: '' }).map((i) => i.field)).toContain('treasuryAddress');
    expect(issuesOf({ treasuryPct: '5', treasuryAddress: 'nope' }).map((i) => i.field)).toContain('treasuryAddress');
    expect(issuesOf({ treasuryPct: '0', treasuryAddress: 'nope' }).map((i) => i.field)).toContain('treasuryAddress');
    expect(good({ treasuryPct: '0', treasuryAddress: '' }).treasury).toBeNull();
  });
  it('only accepts https and ipfs links', () => {
    for (const uri of ['http://example.com/a.json', 'javascript:alert(1)', 'data:text/plain,hi', 'ftp://x/y', 'not a url', `https://example.com/${'a'.repeat(200)}`])
      expect(issuesOf({ metadataUri: uri }).map((i) => i.field), uri).toContain('metadataUri');
    expect(good({ metadataUri: 'https://example.com/m.json' }).metadataUri).toBe('https://example.com/m.json');
    expect(good({ metadataUri: 'ipfs://bafy/m.json' }).metadataUri).toBe('ipfs://bafy/m.json');
  });
  it('refuses shares that do not divide the supply into whole units', () => {
    // 7 raw units: 10% of 7 is not whole.
    const r = issuesOf({ supply: '0.000007', decimals: '6' });
    expect(r.some((i) => /whole units/.test(i.message))).toBe(true);
  });
  it('reports every problem at once', () => {
    expect(issuesOf({ name: '', symbol: '!', decimals: '6', supply: '0', creatorPct: 'x', metadataUri: 'nope' }).map((i) => i.field).sort()).toEqual(['creatorPct', 'metadataUri', 'name', 'supply', 'symbol']);
  });
});

describe('distributionOf', () => {
  it('gives the creator their share plus the held-back share, and the treasury its own line', () => {
    const c = good({ creatorPct: '10', treasuryPct: '5', treasuryAddress: TREASURY });
    const d = distributionOf(c);
    expect(d).toHaveLength(2);
    // the creator's own 10% plus the 85% held back in their wallet
    expect(d.find((l) => l.owner === CREATOR)!.amount).toBe((c.totalSupplyRaw * 9500n) / 10_000n);
    expect(d.find((l) => l.owner === TREASURY)!.amount).toBe(c.totalSupplyRaw * 500n / 10_000n);
    expect(d.reduce((s, l) => s + l.amount, 0n)).toBe(c.totalSupplyRaw);
  });
  it('is one line when there is no treasury, and when the treasury is the creator', () => {
    expect(distributionOf(good())).toHaveLength(1);
    const same = distributionOf(good({ treasuryPct: '5', treasuryAddress: CREATOR }));
    expect(same).toHaveLength(1);
    expect(same[0]!.amount).toBe(good().totalSupplyRaw);
  });
  it('always adds up to exactly the supply', () => {
    for (const [c, t] of [['0', '0'], ['20', '10'], ['0.01', '0.01'], ['12.5', '2.5']] as const) {
      const cfg = good({ creatorPct: c, treasuryPct: t, treasuryAddress: Number(t) > 0 ? TREASURY : '' });
      expect(distributionOf(cfg).reduce((s, l) => s + l.amount, 0n)).toBe(cfg.totalSupplyRaw);
    }
  });
});

describe('disclosuresOf', () => {
  it('never says safe, audited or locked', () => {
    const text = disclosuresOf(good()).map((d) => d.text).join(' ');
    expect(text).not.toMatch(/\bsafe\b|audited|locked/i);
  });
  it('flags that held-back tokens are not locked, that there is no market, and that this is mainnet', () => {
    const text = disclosuresOf(good()).map((d) => d.text).join(' ');
    expect(text).toMatch(/Nothing locks it/);
    expect(text).toMatch(/does not create a market/);
    expect(text).toMatch(/Solana mainnet/);
  });
  it('turns the metadata line to a caution when the metadata stays changeable', () => {
    const line = (c: ReturnType<typeof good>) => disclosuresOf(c).find((d) => /name, symbol and link/.test(d.text))!;
    expect(line(good()).severity).toBe('info');
    expect(line(good({ metadataMutable: true })).severity).toBe('caution');
  });
});

describe('estimateCost', () => {
  it('adds the network fee for the three signatures to the deposits', () => {
    const c = estimateCost({ mintDeposit: 3_000_000n, tokenAccountDeposit: 2_100_000n, accountCount: 2 });
    expect(c.networkFee).toBe(15_000n);
    expect(c.tokenAccountDeposits).toBe(4_200_000n);
    expect(c.total).toBe(15_000n + 3_000_000n + 4_200_000n);
  });
});

describe('stored configurations', () => {
  it('round-trip', () => {
    const c = good({ creatorPct: '10', treasuryPct: '5', treasuryAddress: TREASURY, metadataUri: 'https://example.com/m.json' });
    expect(configFromJson(JSON.parse(JSON.stringify(configToJson(c))))).toEqual(c);
  });
  it('are rejected when anything is off, instead of being repaired', () => {
    const j = JSON.parse(JSON.stringify(configToJson(good())));
    expect(configFromJson({ ...j, creator: 'nope' })).toBeNull();
    expect(configFromJson({ ...j, totalSupplyRaw: '0' })).toBeNull();
    expect(configFromJson({ ...j, totalSupplyRaw: '1.5' })).toBeNull();
    expect(configFromJson({ ...j, totalSupplyRaw: (2n ** 64n).toString() })).toBeNull();
    expect(configFromJson({ ...j, decimals: 12 })).toBeNull();
    expect(configFromJson({ ...j, reservedBps: 8999 })).toBeNull(); // shares no longer add up
    expect(configFromJson({ ...j, creatorBps: 10_000, reservedBps: 0 })).toBeNull(); // nothing held back
    expect(configFromJson({ ...j, treasury: { address: 'nope', bps: 0 } })).toBeNull();
    expect(configFromJson(null)).toBeNull();
    expect(configFromJson('x')).toBeNull();
  });
});
