import { describe, expect, it } from 'vitest';
import { explainTrialError } from './walletTools';
import { previewFromMint } from './walletLaunchPreviewCore';

const SYSTEM = '11111111111111111111111111111111';

describe('a refused trial run, in plain words', () => {
  it('says "not enough SOL" for the system program insufficient-funds error', () => {
    const words = explainTrialError(`Program ${SYSTEM} failed: custom program error: 0x1`);
    expect(words).toContain('does not hold enough SOL');
    expect(words).not.toContain('0x1');
  });

  it('explains an account that already exists', () => {
    expect(explainTrialError(`Program ${SYSTEM} failed: custom program error: 0x0`)).toContain('already exists');
  });

  it('leaves any other error as it came, and names a missing one', () => {
    const other = 'Program ABCDEFG failed: custom program error: 0x1';
    expect(explainTrialError(other)).toBe(other);
    expect(explainTrialError(`Program ${SYSTEM} failed: custom program error: 0x99`)).toContain('0x99');
    expect(explainTrialError(null)).toBe('unknown reason');
  });
});

describe('the preview card rebuilt from the token on the network', () => {
  const info = (over: Record<string, unknown> = {}) => ({
    supply: '1000000000000000',
    decimals: 6,
    extensions: [{ extension: 'metadataPointer', state: {} }, { extension: 'tokenMetadata', state: { name: 'Master', symbol: 'mas' } }],
    ...over,
  });

  it('reads the name, symbol and whole-token supply', () => {
    expect(previewFromMint(info())).toEqual({ name: 'Master', symbol: 'MAS', supply: '1000000000', share: null });
  });

  it('gives nothing for a mint it cannot read', () => {
    expect(previewFromMint(null)).toBeNull();
    expect(previewFromMint(info({ supply: 12 }))).toBeNull();
    expect(previewFromMint(info({ decimals: 99 }))).toBeNull();
    expect(previewFromMint(info({ extensions: [] }))).toBeNull();
  });
});
