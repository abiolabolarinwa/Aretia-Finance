import { describe, expect, it } from 'vitest';

describe('the slippage a swap starts with, from how the token is behaving', () => {
  const calm = { liquidityUsd: 5_000_000, ageMs: 30 * 86_400_000, change5mPct: 0.4, change1hPct: 1 };
  it('keeps the usual 0.5% for a deep, old, calm pool, and for a token nothing is known about', async () => {
    const { autoSlippage } = await import('./walletTools.js');
    expect(autoSlippage(calm)).toEqual({ bps: 50, reason: null });
    expect(autoSlippage({ liquidityUsd: null, ageMs: null })).toEqual({ bps: 50, reason: null }); // unknown never raises it
  });
  it('widens to 3% for a thin or small pool, a pool under an hour old, or a price moving fast', async () => {
    const { autoSlippage } = await import('./walletTools.js');
    expect(autoSlippage({ ...calm, liquidityUsd: 4_000 })).toMatchObject({ bps: 300, reason: expect.stringContaining('thin pool') });
    expect(autoSlippage({ ...calm, liquidityUsd: 30_000 })).toMatchObject({ bps: 300, reason: expect.stringContaining('small pool') });
    expect(autoSlippage({ ...calm, ageMs: 20 * 60_000 })).toMatchObject({ bps: 300, reason: 'a pool under an hour old' });
    expect(autoSlippage({ ...calm, change5mPct: -12 })).toMatchObject({ bps: 300, reason: 'a price that is moving fast' });
    expect(autoSlippage({ ...calm, change1hPct: 45 })).toMatchObject({ bps: 300 });
  });
  it('uses 1% for a modest pool, a pool under a day old, or a price that is moving', async () => {
    const { autoSlippage } = await import('./walletTools.js');
    expect(autoSlippage({ ...calm, liquidityUsd: 120_000 })).toMatchObject({ bps: 100, reason: expect.stringContaining('modest pool') });
    expect(autoSlippage({ ...calm, ageMs: 5 * 3_600_000 })).toMatchObject({ bps: 100, reason: 'a pool under a day old' });
    expect(autoSlippage({ ...calm, change5mPct: 4 })).toMatchObject({ bps: 100, reason: 'a price that is moving' });
  });
  it('takes the most cautious rule that applies, and never goes beyond the widest preset', async () => {
    const { autoSlippage, SLIPPAGE_PRESETS_BPS } = await import('./walletTools.js');
    const worst = autoSlippage({ liquidityUsd: 500, ageMs: 60_000, change5mPct: 80, change1hPct: 500 });
    expect(worst.bps).toBe(300);
    for (const f of [calm, { ...calm, liquidityUsd: 100 }, { ...calm, ageMs: 1000 }, { ...calm, change5mPct: 50 }]) expect(SLIPPAGE_PRESETS_BPS).toContain(autoSlippage(f).bps as never);
  });
});

describe('the slippage a failed swap offers to try again with', () => {
  it('is the widest preset when the swap used less, and nothing when it already used the widest', async () => {
    const { retrySlippageBps, SLIPPAGE_PRESETS_BPS } = await import('./walletTools.js');
    expect(retrySlippageBps(50)).toBe(300);
    expect(retrySlippageBps(100)).toBe(300);
    expect(retrySlippageBps(299)).toBe(300);
    expect(retrySlippageBps(300)).toBeNull();
    expect(retrySlippageBps(500)).toBeNull();
    expect(retrySlippageBps(Number.NaN)).toBeNull();
    expect(SLIPPAGE_PRESETS_BPS).toContain(300); // the button only offers a number the Details chips also offer
  });
});

describe('explainProgramError', () => {
  it('says what Pump.fun\'s program error means, and leaves other programs alone', async () => {
    const { explainProgramError } = await import('./walletTools.js');
    const pump = 'Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA failed: custom program error: 0x17a5';
    expect(explainProgramError(pump)).toMatch(/buyback fee recipient was not accepted \(its error 6053\)/);
    expect(explainProgramError(pump)).toMatch(/not in your balance/);
    expect(explainProgramError(pump.replace('17a5', '1'))).toMatch(/its error 1\)/);
    const other = 'Program 11111111111111111111111111111111 failed: custom program error: 0x1';
    expect(explainProgramError(other)).toBe(other);
  });
});

describe('explainProgramError for Meteora DAMM v2', () => {
  it('says why a sale into a pool at its floor is refused (error 6015), and names other known errors', async () => {
    const { explainProgramError } = await import('./walletTools.js');
    const damm = (hex: string) => `Program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG failed: custom program error: 0x${hex}`;
    expect(explainProgramError(damm('177f'))).toMatch(/holds almost none of the token you want to receive/);
    expect(explainProgramError(damm('177f'))).not.toMatch(/0x177f/);
    expect(explainProgramError(damm('1772'))).toMatch(/slippage limit \(its error 6002\)/);
    expect(explainProgramError(damm('1'))).toMatch(/its error 1\)/);
  });
});

describe('isClosedAccount', () => {
  it('treats a missing account as closed', async () => {
    const { isClosedAccount } = await import('./walletTools.js');
    expect(isClosedAccount(null)).toBe(true);
    expect(isClosedAccount(undefined)).toBe(true);
  });

  it('treats an emptied account handed to the system program as closed, which is how the simulator shows a closed token account', async () => {
    const { isClosedAccount, SYSTEM_PROGRAM_ID } = await import('./walletTools.js');
    expect(isClosedAccount({ lamports: 0, owner: SYSTEM_PROGRAM_ID })).toBe(true);
    expect(isClosedAccount({ lamports: 0n })).toBe(true);
  });

  it('does not treat a funded account, or one a token program still owns, as closed', async () => {
    const { isClosedAccount, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } = await import('./walletTools.js');
    expect(isClosedAccount({ lamports: 2_039_280, owner: TOKEN_PROGRAM_ID })).toBe(false);
    expect(isClosedAccount({ lamports: 2_039_280, owner: SYSTEM_PROGRAM_ID })).toBe(false);
    expect(isClosedAccount({ lamports: 0, owner: TOKEN_PROGRAM_ID })).toBe(false);
  });
});
