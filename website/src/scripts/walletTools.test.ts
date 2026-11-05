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
