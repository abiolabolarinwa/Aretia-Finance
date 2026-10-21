import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import instructions from './__fixtures__/orders/instructions.json';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './walletTools';
import { WRAPPED_SOL_MINT, cancelOrderInstruction, createOrderInstruction, inspectOrderTransaction, orderAddress, unwrapSolInstruction, wrapSolInstructions } from './walletOrdersTx';
import { createHash } from 'node:crypto';

// The same fixed addresses the Rust golden test uses.
const OWNER = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const LAUNCH = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const QUOTE = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CURVE = 'DvvccGEr3tn116hLZWPporfreqhSstWNQMsKLq8x7kqX';
const FEE = 'DWkwVbRZ3WUPSxLdmLdnNeq3rAkrev5vusjkpwrjU4fw';
const PROGRAM = 'Fnb5FELt2BGQLzXdKc1pFTJThdYuZQwaamLVpc8pGPKH';

interface Golden {
  name: string;
  programId: string;
  dataHex: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
}
const golden = (name: string) => (instructions as Golden[]).find((g) => g.name === name)!;
const shape = (ix: web3.TransactionInstruction) => ({
  programId: ix.programId.toBase58(),
  dataHex: Buffer.from(ix.data).toString('hex'),
  accounts: ix.keys.map((k) => ({
    pubkey: k.pubkey.toBase58(),
    isSigner: k.isSigner,
    isWritable: k.isWritable,
  })),
});
const base = {
  programId: PROGRAM,
  owner: OWNER,
  launchMint: LAUNCH,
  launchTokenProgram: TOKEN_2022_PROGRAM_ID,
  curve: CURVE,
  quoteMint: QUOTE,
};

describe('the order instructions agree with the program (golden file written by its Rust tests)', () => {
  it('create_order, buy', () => {
    expect(
      shape(
        createOrderInstruction(web3, {
          ...base,
          side: 'buy',
          nonce: 7n,
          amountIn: 1_000_000_000n,
          minOut: 500_000_000n,
        }),
      ),
    ).toEqual({
      programId: golden('create_order_buy').programId,
      dataHex: golden('create_order_buy').dataHex,
      accounts: golden('create_order_buy').accounts,
    });
  });

  it('create_order, sell', () => {
    expect(
      shape(
        createOrderInstruction(web3, {
          ...base,
          side: 'sell',
          nonce: 8n,
          amountIn: 600_000_000n,
          minOut: 300_000_000n,
        }),
      ),
    ).toEqual({
      programId: golden('create_order_sell').programId,
      dataHex: golden('create_order_sell').dataHex,
      accounts: golden('create_order_sell').accounts,
    });
  });

  it('cancel_order', () => {
    const order = orderAddress(web3, PROGRAM, OWNER, 7n);
    expect(shape(cancelOrderInstruction(web3, { ...base, order, feeRecipient: FEE }))).toEqual({
      programId: golden('cancel_order').programId,
      dataHex: golden('cancel_order').dataHex,
      accounts: golden('cancel_order').accounts,
    });
  });

  it('uses wrapped SOL as the payment asset unless told otherwise', () => {
    const { quoteMint: _drop, ...noQuote } = base;
    void _drop;
    const ix = createOrderInstruction(web3, {
      ...noQuote,
      side: 'buy',
      nonce: 1n,
      amountIn: 1n,
      minOut: 1n,
    });
    expect(ix.keys[5]!.pubkey.toBase58()).toBe(WRAPPED_SOL_MINT);
  });

  it('the instruction numbers are the hashes of the instruction names', () => {
    const d = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8).toString('hex');
    expect(golden('create_order_buy').dataHex.startsWith(d('create_order'))).toBe(true);
    expect(golden('cancel_order').dataHex).toBe(d('cancel_order'));
  });
});

describe('wrapping and unwrapping SOL', () => {
  it('creates the account, moves the SOL in and syncs it', () => {
    const ixs = wrapSolInstructions(web3, OWNER, 1_500_000_000n);
    expect(ixs).toHaveLength(3);
    expect(ixs[0]!.programId.toBase58()).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    expect(ixs[1]!.programId.toBase58()).toBe('11111111111111111111111111111111');
    expect(ixs[2]!.programId.toBase58()).toBe(TOKEN_PROGRAM_ID);
    expect(Buffer.from(ixs[2]!.data).toString('hex')).toBe('11'); // SyncNative
  });

  it('only creates the account when nothing needs wrapping', () => {
    expect(wrapSolInstructions(web3, OWNER, 0n)).toHaveLength(1);
  });

  it('closes the wrapped-SOL account back to the owner', () => {
    const ix = unwrapSolInstruction(web3, OWNER);
    expect(Buffer.from(ix.data).toString('hex')).toBe('09'); // CloseAccount
    expect(ix.keys[1]!.pubkey.toBase58()).toBe(OWNER);
    expect(ix.keys[2]).toMatchObject({ isSigner: true });
  });
});

describe('inspectOrderTransaction', () => {
  const ixs = () => [
    createOrderInstruction(web3, {
      ...base,
      side: 'buy',
      nonce: 7n,
      amountIn: 1_000_000_000n,
      minOut: 500_000_000n,
    }),
  ];
  const txOf = (list: web3.TransactionInstruction[], payer = OWNER) => {
    const tx = new web3.Transaction({
      feePayer: new web3.PublicKey(payer),
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 1,
    });
    tx.add(...list);
    return tx;
  };
  const expected = () => ({
    programId: PROGRAM,
    owner: OWNER,
    instructions: ixs(),
  });

  it('accepts exactly what was built', () => {
    expect(inspectOrderTransaction(web3, txOf(ixs()), expected())).toEqual([]);
  });

  it('catches a changed amount', () => {
    const changed = [
      createOrderInstruction(web3, {
        ...base,
        side: 'buy',
        nonce: 7n,
        amountIn: 1_000_000_001n,
        minOut: 500_000_000n,
      }),
    ];
    expect(inspectOrderTransaction(web3, txOf(changed), expected())).toEqual(['Step 1 is not what this page built.']);
  });

  it('catches a lower limit, which would let the order fill at a worse price', () => {
    const changed = [
      createOrderInstruction(web3, {
        ...base,
        side: 'buy',
        nonce: 7n,
        amountIn: 1_000_000_000n,
        minOut: 1n,
      }),
    ];
    expect(inspectOrderTransaction(web3, txOf(changed), expected())).toContain('Step 1 is not what this page built.');
  });

  it('catches an extra step, a foreign program and a stranger asked to sign', () => {
    const extra = [
      ...ixs(),
      web3.SystemProgram.transfer({
        fromPubkey: new web3.PublicKey(OWNER),
        toPubkey: new web3.PublicKey(FEE),
        lamports: 5n,
      }),
    ];
    expect(inspectOrderTransaction(web3, txOf(extra), expected())).toContain('The transaction has a different number of steps than expected.');

    const foreign = new web3.TransactionInstruction({
      programId: new web3.PublicKey(FEE),
      keys: [],
      data: Buffer.alloc(0),
    });
    const withForeign = {
      programId: PROGRAM,
      owner: OWNER,
      instructions: [foreign],
    };
    expect(inspectOrderTransaction(web3, txOf([foreign]), withForeign)).toContain('Step 1 calls a program this page did not mean to use.');

    const stranger = new web3.TransactionInstruction({
      programId: new web3.PublicKey(PROGRAM),
      keys: [{ pubkey: new web3.PublicKey(FEE), isSigner: true, isWritable: false }],
      data: Buffer.alloc(0),
    });
    const strangerExpected = {
      programId: PROGRAM,
      owner: OWNER,
      instructions: [stranger],
    };
    expect(inspectOrderTransaction(web3, txOf([stranger]), strangerExpected)).toContain('Step 1 asks for a signature from an account that is not yours.');
  });

  it('catches a different fee payer', () => {
    expect(inspectOrderTransaction(web3, txOf(ixs(), FEE), expected())).toContain('The transaction is not paid for by your wallet.');
  });
});
