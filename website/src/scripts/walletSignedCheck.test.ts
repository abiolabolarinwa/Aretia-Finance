import { describe, expect, it } from 'vitest';
import * as web3 from '@solana/web3.js';
import { checkSignedTransaction, MAX_PRIORITY_FEE_LAMPORTS, WALLET_GUARD_PROGRAMS } from './walletSignedCheck';

const key = (n: number): web3.PublicKey => new web3.PublicKey(new Uint8Array(32).fill(n));
const PAYER = key(1);
const BLOCKHASH = web3.PublicKey.default.toBase58();
const LIGHTHOUSE = new web3.PublicKey(WALLET_GUARD_PROGRAMS[0]!);

const swapIx = (data = [1, 2, 3]) => new web3.TransactionInstruction({ programId: key(9), keys: [{ pubkey: PAYER, isSigner: true, isWritable: true }, { pubkey: key(5), isSigner: false, isWritable: true }, { pubkey: key(6), isSigner: false, isWritable: false }], data: Buffer.from(data) });
const guardIx = () => new web3.TransactionInstruction({ programId: LIGHTHOUSE, keys: [{ pubkey: key(5), isSigner: false, isWritable: false }, { pubkey: key(7), isSigner: false, isWritable: false }], data: Buffer.from([9, 9]) });
const v0 = (ixs: web3.TransactionInstruction[], payer = PAYER, blockhash = BLOCKHASH) => new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
const legacy = (ixs: web3.TransactionInstruction[]) => new web3.Transaction({ feePayer: PAYER, recentBlockhash: BLOCKHASH }).add(...ixs);
const roundTrip = (t: web3.Transaction) => web3.Transaction.from(t.serialize({ requireAllSignatures: false, verifySignatures: false }));

const BUDGET = new web3.PublicKey('ComputeBudget111111111111111111111111111111');
const unitLimit = (units: number) => web3.ComputeBudgetProgram.setComputeUnitLimit({ units });
const unitPrice = (microLamports: number) => web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports });

describe('the priority fee a wallet adds', () => {
  it('passes when the wallet adds a unit limit and a unit price (Phantom does), and when they were already there', () => {
    const planned = v0([swapIx()]);
    expect(checkSignedTransaction(web3, planned, v0([unitLimit(200_000), unitPrice(5_000), swapIx()])).ok).toBe(true);
    expect(checkSignedTransaction(web3, v0([unitLimit(300_000), swapIx()]), v0([unitLimit(300_000), unitPrice(1_000), swapIx()])).ok).toBe(true);
  });

  it('refuses a priority fee above the cap', () => {
    // 1,000,000 units at 10,000,000 micro-lamports is 10,000,000 lamports: twice the cap.
    const r = checkSignedTransaction(web3, v0([swapIx()]), v0([unitLimit(1_000_000), unitPrice(10_000_000), swapIx()]));
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: expect.stringContaining('priority fee') });
    expect(MAX_PRIORITY_FEE_LAMPORTS).toBe(5_000_000);
  });

  it('treats a price with no unit limit as if the whole 1,400,000 units could be used', () => {
    expect(checkSignedTransaction(web3, v0([swapIx()]), v0([unitPrice(2_000_000), swapIx()])).ok).toBe(true);
    expect(checkSignedTransaction(web3, v0([swapIx()]), v0([unitPrice(5_000_000), swapIx()])).ok).toBe(false);
  });

  it('still refuses other ComputeBudget instructions and any change beside the fee', () => {
    const heap = new web3.TransactionInstruction({ programId: BUDGET, keys: [], data: Buffer.from([1, 0, 0, 4, 0]) });
    expect(checkSignedTransaction(web3, v0([swapIx()]), v0([heap, swapIx()])).ok).toBe(false);
    expect(checkSignedTransaction(web3, v0([swapIx()]), v0([unitPrice(1_000), swapIx([9])])).ok).toBe(false);
  });
});

describe('the transaction a wallet hands back', () => {
  it('passes when nothing was changed', () => {
    expect(checkSignedTransaction(web3, v0([swapIx()]), v0([swapIx()]))).toEqual({ ok: true, guards: 0 });
  });

  it("passes when the wallet adds its own guard instructions (Phantom's Lighthouse), before and after", () => {
    const planned = v0([swapIx()]);
    expect(checkSignedTransaction(web3, planned, v0([guardIx(), swapIx(), guardIx()]))).toEqual({ ok: true, guards: 2 });
    expect(checkSignedTransaction(web3, legacy([swapIx()]), roundTrip(legacy([guardIx(), swapIx()])))).toEqual({ ok: true, guards: 1 });
  });

  it('refuses any other added instruction, naming its program', () => {
    const evil = new web3.TransactionInstruction({ programId: key(40), keys: [{ pubkey: PAYER, isSigner: true, isWritable: true }], data: Buffer.from([2]) });
    const r = checkSignedTransaction(web3, v0([swapIx()]), v0([swapIx(), evil]));
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: expect.stringContaining('added an instruction from') });
  });

  it('refuses a changed instruction: other data, another account, another program, a removed instruction', () => {
    const planned = v0([swapIx()]);
    expect(checkSignedTransaction(web3, planned, v0([swapIx([1, 2, 4])])).ok).toBe(false);
    const other = new web3.TransactionInstruction({ programId: key(9), keys: [{ pubkey: PAYER, isSigner: true, isWritable: true }, { pubkey: key(50), isSigner: false, isWritable: true }, { pubkey: key(6), isSigner: false, isWritable: false }], data: Buffer.from([1, 2, 3]) });
    expect(checkSignedTransaction(web3, planned, v0([other])).ok).toBe(false);
    expect(checkSignedTransaction(web3, planned, v0([new web3.TransactionInstruction({ programId: key(10), keys: swapIx().keys, data: Buffer.from([1, 2, 3]) })])).ok).toBe(false);
    expect(checkSignedTransaction(web3, v0([swapIx(), swapIx([7])]), v0([swapIx()])).ok).toBe(false);
  });

  it('refuses a different payer or blockhash even with no instruction changed', () => {
    expect(checkSignedTransaction(web3, v0([swapIx()]), v0([swapIx()], key(2))).ok).toBe(false);
    expect(checkSignedTransaction(web3, v0([swapIx()]), v0([swapIx()], PAYER, key(3).toBase58())).ok).toBe(false);
  });

  it('refuses a swap whose guard makes an account less writable than it was shown, or hides a guard-program instruction that is not a guard', () => {
    const planned = v0([swapIx()]);
    const lessWritable = new web3.TransactionInstruction({ programId: key(9), keys: [{ pubkey: PAYER, isSigner: true, isWritable: true }, { pubkey: key(5), isSigner: false, isWritable: false }, { pubkey: key(6), isSigner: false, isWritable: false }], data: Buffer.from([1, 2, 3]) });
    expect(checkSignedTransaction(web3, planned, v0([lessWritable])).ok).toBe(false);
    // With a custom guard list that does not include Lighthouse, Lighthouse counts as an unknown addition.
    expect(checkSignedTransaction(web3, planned, v0([guardIx(), swapIx()]), [], []).ok).toBe(false);
  });
});
