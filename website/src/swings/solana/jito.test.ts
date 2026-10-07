import { describe, expect, it } from 'vitest';
import * as web3 from '@solana/web3.js';
import { checkTip, DEFAULT_TIP_LAMPORTS, findTip, JITO_TIP_ACCOUNTS, MAX_TIP_LAMPORTS, MIN_TIP_LAMPORTS, pickTipAccount, tipInstruction } from './jito.js';

const payer = web3.Keypair.generate();
const other = web3.Keypair.generate().publicKey;
const tx = (ixs: web3.TransactionInstruction[]): web3.VersionedTransaction =>
  new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: web3.PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message());

describe('Jito tip', () => {
  it('accepts only whole lamports within the cap, and never clamps', () => {
    expect(checkTip(DEFAULT_TIP_LAMPORTS)).toBe(DEFAULT_TIP_LAMPORTS);
    for (const bad of [0, MIN_TIP_LAMPORTS - 1, MAX_TIP_LAMPORTS + 1, 1.5, Number.NaN, -5]) expect(() => checkTip(bad)).toThrow(/tip must be/);
  });

  it('only ever pays one of the published Jito tip accounts', () => {
    expect(JITO_TIP_ACCOUNTS).toHaveLength(8);
    expect(JITO_TIP_ACCOUNTS.every((a) => new web3.PublicKey(a).toBase58() === a)).toBe(true);
    expect(() => tipInstruction(web3, payer.publicKey.toBase58(), 5_000, other.toBase58())).toThrow(/tip account/);
    for (const r of [0, 0.5, 0.999999, 1]) expect(JITO_TIP_ACCOUNTS).toContain(pickTipAccount(() => r));
  });

  it('finds the tip in a transaction: who pays, whom and how much', () => {
    const account = JITO_TIP_ACCOUNTS[3]!;
    const found = findTip(tx([web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: other, lamports: 5 }), tipInstruction(web3, payer.publicKey.toBase58(), 12_345, account)]));
    expect(found).toEqual({ from: payer.publicKey.toBase58(), account, lamports: 12_345n });
  });

  it('does not mistake an ordinary transfer, or a transfer from a tip account, for a tip', () => {
    expect(findTip(tx([web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: other, lamports: 5_000 })]))).toBeNull();
    expect(findTip(tx([]))).toBeNull();
    const reverse = web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(JITO_TIP_ACCOUNTS[0]!), toPubkey: other, lamports: 5_000 });
    expect(findTip(tx([reverse]))).toBeNull();
  });
});
