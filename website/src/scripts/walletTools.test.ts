import { describe, expect, it } from 'vitest';

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
