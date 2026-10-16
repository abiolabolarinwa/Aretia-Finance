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
