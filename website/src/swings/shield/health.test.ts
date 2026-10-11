import { describe, expect, it } from 'vitest';
import { analyseWallet, chunk, CLOSE_ACCOUNT_DATA, isReclaimable, readTokenAccounts, REVOKE_DATA, TOKEN_2022_PROGRAM, TOKEN_ACCOUNT_RENT_LAMPORTS, TOKEN_PROGRAM, type HeldTokenCheck, type TokenAccount } from './health.js';

const acct = (over: Partial<TokenAccount> = {}): TokenAccount => ({ address: 'AcctAcctAcctAcctAcctAcctAcctAcctAcctAcct11', mint: 'MintMintMintMintMintMintMintMintMintMint111', program: TOKEN_PROGRAM, amount: 5_000_000n, decimals: 6, uiAmount: 5, delegate: null, delegatedAmount: 0n, frozen: false, lamports: TOKEN_ACCOUNT_RENT_LAMPORTS, ...over });
const check = (over: Partial<HeldTokenCheck> = {}): HeldTokenCheck => ({ mint: 'MintMintMintMintMintMintMintMintMintMint111', symbol: 'ABC', band: 'yellow', ratingLabel: 'Unverified', noMarket: false, ...over });
const base = { lamports: 1_000_000_000n, skipped: 0 };

describe('reading token accounts', () => {
  it('reads both token programs and the permission each account carries', async () => {
    const calls: string[] = [];
    const sol = (async (method: string, params: unknown[]) => {
      calls.push(String((params[1] as { programId: string }).programId));
      const mine = (params[1] as { programId: string }).programId === TOKEN_PROGRAM;
      return {
        value: mine
          ? [{ pubkey: 'P1', account: { lamports: 2_039_280, data: { parsed: { info: { mint: 'M1', state: 'initialized', delegate: 'DELEG', delegatedAmount: { amount: '2500000' }, tokenAmount: { amount: '5000000', decimals: 6, uiAmount: 5 } } } } } }, { pubkey: 'junk', account: {} }]
          : [{ pubkey: 'P2', account: { lamports: 2_100_000, data: { parsed: { info: { mint: 'M2', state: 'frozen', tokenAmount: { amount: '0', decimals: 9, uiAmount: 0 } } } } } }],
      };
    }) as unknown as Parameters<typeof readTokenAccounts>[1];
    const out = await readTokenAccounts('OWNER', sol);
    expect(calls).toEqual([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ address: 'P1', mint: 'M1', delegate: 'DELEG', delegatedAmount: 2_500_000n, amount: 5_000_000n, frozen: false });
    expect(out[1]).toMatchObject({ address: 'P2', frozen: true, program: TOKEN_2022_PROGRAM });
  });
});

describe('analysing a wallet', () => {
  it('is green when nothing is wrong, and says what it looked at', () => {
    const r = analyseWallet({ ...base, accounts: [acct()], checks: [check({ band: 'green', ratingLabel: 'Established' })] });
    expect(r.band).toBe('green');
    expect(r.items.map((i) => i.id)).toEqual(['no-delegates']);
    expect(r.couldNot.join(' ')).toMatch(/other networks/);
  });
  it('flags a standing permission, names the token, and offers to take it back', () => {
    const r = analyseWallet({ ...base, accounts: [acct({ delegate: 'DrainerDrainerDrainerDrainerDrainer1111', delegatedAmount: 5_000_000n })], checks: [check()] });
    expect(r.band).toBe('orange');
    const item = r.items[0]!;
    expect(item.severity).toBe('warn');
    expect(item.title).toMatch(/can move all of your 5 ABC without asking/);
    expect(item.action?.kind).toBe('revoke');
    expect(item.action?.accounts).toHaveLength(1);
    expect(r.items.some((i) => i.id === 'no-delegates')).toBe(false);
  });
  it('is red for a held token rated high risk, and does not mention one that is not held', () => {
    const r = analyseWallet({ ...base, accounts: [acct()], checks: [check({ band: 'red', ratingLabel: 'High risk' }), check({ mint: 'OtherOtherOtherOtherOtherOtherOtherOther', band: 'red', symbol: 'XYZ' })] });
    expect(r.band).toBe('red');
    expect(r.items.filter((i) => i.id.startsWith('risk-'))).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ severity: 'bad', action: { kind: 'check' } });
  });
  it('calls tokens with no market spam, and lists them without alarm', () => {
    const r = analyseWallet({ ...base, accounts: [acct({ address: 'A1', mint: 'M1' }), acct({ address: 'A2', mint: 'M2' })], checks: [check({ mint: 'M1', symbol: null, noMarket: true }), check({ mint: 'M2', symbol: 'FREE', noMarket: true })] });
    const spam = r.items.find((i) => i.id === 'no-market')!;
    expect(spam.severity).toBe('note');
    expect(spam.title).toMatch(/2 tokens have no market/);
    expect(r.band).toBe('yellow');
  });
  it('offers to close empty accounts, counting the rent that comes back', () => {
    const empty = [acct({ address: 'E1', amount: 0n }), acct({ address: 'E2', amount: 0n, lamports: 2_039_280n }), acct({ address: 'E3', amount: 0n, frozen: true }), acct({ address: 'E4', amount: 0n, program: TOKEN_2022_PROGRAM })];
    const r = analyseWallet({ ...base, accounts: empty, checks: [] });
    const item = r.items.find((i) => i.id === 'reclaim')!;
    expect(item.action?.accounts?.map((a) => a.address)).toEqual(['E1', 'E2']);
    expect(item.title).toMatch(/2 empty token accounts hold about 0.0041 SOL/);
    expect(r.reclaimLamports).toBe(TOKEN_ACCOUNT_RENT_LAMPORTS * 2n);
  });
  it('never offers to close an account that is frozen, delegated or holds a balance', () => {
    expect(isReclaimable(acct({ amount: 0n }))).toBe(true);
    expect(isReclaimable(acct({ amount: 1n }))).toBe(false);
    expect(isReclaimable(acct({ amount: 0n, frozen: true }))).toBe(false);
    expect(isReclaimable(acct({ amount: 0n, delegate: 'x' }))).toBe(false);
    expect(isReclaimable(acct({ amount: 0n, program: TOKEN_2022_PROGRAM }))).toBe(false);
  });
  it('notes frozen holdings and a nearly empty SOL balance', () => {
    const r = analyseWallet({ lamports: 1_000_000n, skipped: 3, accounts: [acct({ frozen: true })], checks: [check()] });
    expect(r.items.map((i) => i.id)).toEqual(expect.arrayContaining(['frozen', 'low-sol']));
    expect(r.couldNot.join(' ')).toMatch(/3 smaller tokens were not rated/);
  });
  it('words the headline by how many things there are', () => {
    const r = analyseWallet({ ...base, accounts: [acct({ amount: 0n })], checks: [] });
    expect(r.headline).toMatch(/^1 thing to look at\./);
  });
  it('uses the real instruction numbers', () => {
    expect([...REVOKE_DATA]).toEqual([5]);
    expect([...CLOSE_ACCOUNT_DATA]).toEqual([9]);
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
