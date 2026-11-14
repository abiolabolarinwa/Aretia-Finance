import { describe, expect, it } from 'vitest';
import { lockView } from './lockView.js';

const base = { lockedPct: null, lockInfo: null, risk: null, lockState: undefined, lockLowPct: undefined, pool: '0x' + 'a'.repeat(40) } as Parameters<typeof lockView>[0];

describe('what every row says about its liquidity lock', () => {
  it('says burned, with the share, when the liquidity tokens are burned', () => {
    const v = lockView({ ...base, lockedPct: 100 });
    expect(v.kind).toBe('locked');
    expect(v.text).toBe('Burned 100%');
    expect(v.title).toContain('can never be withdrawn');
    expect(lockView({ ...base, lockedPct: 87.5 }).text).toBe('Burned 87.5%');
  });

  it('says locked with the date for a time lock, and says when it has no date', () => {
    const until = Date.UTC(2027, 2, 12);
    const v = lockView({ ...base, lockedPct: 80, lockInfo: { kind: 'time-locked', until, by: 'UNCX' } });
    expect(v.kind).toBe('timed');
    expect(v.text).toContain('Locked');
    expect(v.text).toContain('27');
    expect(v.title).toContain("UNCX's locker");
    expect(v.title).toContain('time lock, not a burn');
    expect(lockView({ ...base, lockedPct: 80, lockInfo: { kind: 'time-locked', until: null } }).text).toBe('Locked');
  });

  it('warns when the token keeps an admin power, since a lock then does not protect a buyer', () => {
    const v = lockView({ ...base, lockedPct: 100, risk: { status: 'high', label: 'x', score: 1, adminPowers: true } });
    expect(v.kind).toBe('guarded');
    expect(v.text).toContain('admin powers');
    expect(v.title).toContain('does not protect a buyer');
  });

  it('says "no lock found" for a pool that was read, never "unlocked", and says what that does not prove', () => {
    const v = lockView({ ...base, lockState: 'checked', lockLowPct: 0 });
    expect(v.kind).toBe('open');
    expect(v.text).toBe('No lock found');
    expect(v.title).toContain('not proof');
    expect(lockView({ ...base, lockState: 'checked', lockLowPct: 12.5 }).title).toContain('12.5%');
  });

  it('says "not checked" for a pool kind it cannot read and for a chain that did not answer, and "checking" while it reads', () => {
    expect(lockView({ ...base, lockState: 'unsupported' })).toMatchObject({ kind: 'unknown', text: 'Not checked' });
    expect(lockView({ ...base, lockState: 'unreadable' })).toMatchObject({ kind: 'unknown', text: 'Not checked' });
    expect(lockView(base)).toMatchObject({ kind: 'checking', text: 'Checking…' });
    expect(lockView({ ...base, pool: '' })).toMatchObject({ kind: 'unknown' });
  });

  it('never shows a lock that was not proven, whatever else is set', () => {
    expect(lockView({ ...base, lockState: 'unsupported', lockLowPct: 99 }).kind).toBe('unknown');
  });
});
