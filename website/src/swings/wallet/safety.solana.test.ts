import { describe, expect, it } from 'vitest';
import { solanaInstructionProblems } from './safety.js';

const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const CCTP = 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe';
const sys = (kind: number, len = 12) => {
  const b = new Uint8Array(len);
  new DataView(b.buffer).setUint32(0, kind, true);
  return { program: SYSTEM, data: b };
};
const tok = (program: string, kind: number) => ({ program, data: new Uint8Array([kind, 0, 0, 0, 0, 0, 0, 0, 0]) });

describe('Solana instruction check for settlement transactions', () => {
  it('lets through what a bridge burn needs: account creation, the bridge call, a compute budget', () => {
    expect(solanaInstructionProblems([sys(0, 52), { program: CCTP, data: new Uint8Array([1, 2, 3]) }, tok(TOKEN, 1), tok(TOKEN, 17)])).toEqual([]);
  });
  it('refuses a System transfer, whatever the destination', () => {
    expect(solanaInstructionProblems([sys(2)])[0]).toMatch(/sends SOL to another account/);
    expect(solanaInstructionProblems([sys(11, 20)])[0]).toMatch(/sends SOL/);
  });
  it('refuses handing an account to another program or a nonce account away', () => {
    for (const kind of [1, 5, 7, 10]) expect(solanaInstructionProblems([sys(kind)]).length).toBe(1);
  });
  it('refuses token transfers, approvals, authority changes, burns and closes, on both token programs', () => {
    for (const program of [TOKEN, TOKEN22]) for (const kind of [3, 4, 6, 8, 9, 12, 13, 15]) expect(solanaInstructionProblems([tok(program, kind)]).length, `${program} ${kind}`).toBe(1);
  });
  it('refuses an instruction it cannot read, and reports each problem once', () => {
    expect(solanaInstructionProblems([{ program: SYSTEM, data: new Uint8Array([2]) }]).length).toBe(1);
    expect(solanaInstructionProblems([{ program: TOKEN, data: new Uint8Array() }]).length).toBe(1);
    expect(solanaInstructionProblems([sys(2), sys(2), sys(2)]).length).toBe(1);
  });
});
