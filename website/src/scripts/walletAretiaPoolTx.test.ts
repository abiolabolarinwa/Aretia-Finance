import { createHash } from 'node:crypto';
import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import vectors from './__fixtures__/aretiaPoolVectors.json';
import { ARETIA_POOL_FEE_ADDRESS, ARETIA_POOL_PROGRAM_ID_DEVNET, type CreateParams } from './walletAretiaPoolCore';
import {
  DISC,
  assemble,
  buildAddLiquidity,
  buildRemoveLiquidity,
  inspectAddLiquidity,
  inspectRemoveLiquidity,
  buildClaim,
  ensureTokenAccount,
  buildCreatePool,
  buildLock,
  buildSwap,
  inspectClaim,
  inspectCreate,
  inspectLock,
  buildSetRecipient,
  inspectSetRecipient,
  buildTransferPosition,
  inspectTransferPosition,
  inspectSwap,
  poolAddress,
  positionAddress,
  solVaultAddress,
} from './walletAretiaPoolTx';
import { LAUNCH_FEE_ADDRESS } from './walletLaunchCore';
import { ATA_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ataAddress } from './walletTools';

const PROGRAM = ARETIA_POOL_PROGRAM_ID_DEVNET;
const CREATOR = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const OTHER = '3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg';
const MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k';
const other = new web3.PublicKey(OTHER);
const params = (over: Partial<CreateParams> = {}): CreateParams => ({ creator: CREATOR, mint: MINT, x0: 600_000_000_000_000n, y0: 0n, l0: 10_000_200_000n, feeBps: 25, lock: true, sniperBps: 1000, decaySecs: 300, vx0: 0n, ...over });

const tamper = (ix: web3.TransactionInstruction, over: { keys?: Record<number, Partial<web3.AccountMeta>>; data?: (d: Buffer) => void; programId?: web3.PublicKey }) => {
  const keys = ix.keys.map((k, i) => ({ ...k, ...(over.keys?.[i] ?? {}) }));
  const d = Buffer.from(ix.data);
  over.data?.(d);
  return new web3.TransactionInstruction({ programId: over.programId ?? ix.programId, keys, data: d });
};

describe('the instruction tags', () => {
  it('are the first 8 bytes of sha256("global:<name>"), as Anchor writes them', () => {
    const tag = (n: string) => Uint8Array.from(createHash('sha256').update(`global:${n}`).digest().subarray(0, 8));
    expect(DISC.createPool).toEqual(tag('create_pool'));
    expect(DISC.swap).toEqual(tag('swap'));
    expect(DISC.addLiquidity).toEqual(tag('add_liquidity'));
    expect(DISC.removeLiquidity).toEqual(tag('remove_liquidity'));
    expect(DISC.claimFees).toEqual(tag('claim_fees'));
    expect(DISC.lockLiquidity).toEqual(tag('lock_liquidity'));
  });
});

describe('the addresses', () => {
  it('match the ones the Rust program derives', () => {
    for (const a of vectors.addresses) {
      const pool = poolAddress(web3, vectors.program, a.mint);
      expect(pool).toBe(a.pool);
      expect(solVaultAddress(web3, vectors.program, pool)).toBe(a.solVault);
      expect(ataAddress(web3, pool, a.mint, TOKEN_2022_PROGRAM_ID)).toBe(a.tokenVault);
      expect(positionAddress(web3, vectors.program, pool, a.owner)).toBe(a.position);
    }
  });
});

describe('create pool', () => {
  const make = (p = params(), signed = true) => {
    const b = buildCreatePool(web3, PROGRAM, p);
    const tx = assemble(web3, b.instructions, p.creator, BLOCKHASH, 1);
    return { b, tx, check: { params: p, program: PROGRAM, pool: b.pool }, signed };
  };
  const after = (change: (ix: web3.TransactionInstruction) => web3.TransactionInstruction, p = params()): string => {
    const { b, tx, check } = make(p);
    tx.instructions[0] = change(b.instructions[0]!);
    return inspectCreate(web3, tx, check).join(' ');
  };

  it('is one instruction, and the inspector accepts it, locked or not, at either fee', () => {
    for (const p of [params(), params({ lock: false }), params({ feeBps: 100 }), params({ y0: 3_000_000_000n })]) {
      const { b, tx, check } = make(p);
      expect(b.instructions).toHaveLength(1);
      expect(inspectCreate(web3, tx, check)).toEqual([]);
    }
  });

  it('puts the accounts in the order the program takes them, with the fee going to Aretia’s wallet', () => {
    const { b } = make();
    const ix = b.instructions[0]!;
    expect(ix.programId.toBase58()).toBe(PROGRAM);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      CREATOR,
      CREATOR,
      MINT,
      ataAddress(web3, CREATOR, MINT, TOKEN_2022_PROGRAM_ID),
      b.pool,
      b.solVault,
      b.vault,
      b.position,
      LAUNCH_FEE_ADDRESS,
      TOKEN_2022_PROGRAM_ID,
      ATA_PROGRAM_ID,
      '11111111111111111111111111111111',
      CREATOR,
    ]);
    expect(ARETIA_POOL_FEE_ADDRESS).toBe(LAUNCH_FEE_ADDRESS);
    expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([CREATOR]);
  });

  it('encodes the arguments little-endian after the tag', () => {
    const d = make().b.instructions[0]!.data;
    expect(d.length).toBe(49);
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    expect([v.getBigUint64(8, true), v.getBigUint64(16, true), v.getBigUint64(24, true), v.getUint16(32, true), d[34], v.getUint16(35, true), v.getUint32(37, true), v.getBigUint64(41, true)]).toEqual([600_000_000_000_000n, 0n, 10_000_200_000n, 25, 1, 1000, 300, 0n]);
  });

  it('refuses a different fee payer or an extra signer', () => {
    const { tx, check } = make();
    tx.feePayer = other;
    expect(inspectCreate(web3, tx, check).join(' ')).toMatch(/fee would be paid by an account other than yours/);
    const m = make();
    m.tx.instructions[0] = tamper(m.b.instructions[0]!, { keys: { 4: { isSigner: true } } });
    expect(inspectCreate(web3, m.tx, m.check).join(' ')).toMatch(/unexpected account would have to sign/);
  });

  it('refuses any extra, missing or reordered instruction', () => {
    const { b, tx, check } = make();
    tx.add(web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(CREATOR), toPubkey: other, lamports: 1 }));
    expect(inspectCreate(web3, tx, check).join(' ')).toMatch(/not the single step/);
    const front = assemble(web3, [web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(CREATOR), toPubkey: other, lamports: 1 }), ...b.instructions], CREATOR, BLOCKHASH, 1);
    expect(inspectCreate(web3, front, check).join(' ')).toMatch(/not the single step/);
    expect(inspectCreate(web3, new web3.Transaction({ feePayer: new web3.PublicKey(CREATOR), blockhash: BLOCKHASH, lastValidBlockHeight: 1 }), check).join(' ')).toMatch(/not the single step/);
  });

  it('refuses another program, another step, or a different set of accounts', () => {
    expect(after((ix) => tamper(ix, { programId: other }))).toMatch(/not made by the pool program/);
    expect(after((ix) => tamper(ix, { data: (d) => d.set([1, 2, 3, 4, 5, 6, 7, 8]) }))).toMatch(/not the expected one/);
    expect(after((ix) => new web3.TransactionInstruction({ programId: ix.programId, keys: ix.keys.slice(0, 12), data: ix.data }))).toMatch(/different set of accounts/);
    expect(after((ix) => new web3.TransactionInstruction({ programId: ix.programId, keys: ix.keys, data: Buffer.concat([ix.data, Buffer.from([0])]) }))).toMatch(/not the expected one/);
  });

  it('refuses every account being swapped for another', () => {
    for (let i = 0; i < 13; i++) {
      const msg = after((ix) => tamper(ix, { keys: { [i]: { pubkey: other } } }));
      expect(msg, `account ${i}`).toMatch(/unexpected account in position|fee would be paid|have to sign/);
    }
    // The tokens are taken from the creator's own account only; the fee goes to Aretia only.
    expect(after((ix) => tamper(ix, { keys: { 8: { pubkey: other } } }))).toMatch(/position 9/);
    expect(after((ix) => tamper(ix, { keys: { 3: { pubkey: other } } }))).toMatch(/position 4/);
  });

  it('refuses wrong flags on the accounts', () => {
    for (let i = 0; i < 13; i++) {
      const flip = after((ix) => tamper(ix, { keys: { [i]: { isWritable: !ix.keys[i]!.isWritable } } }));
      expect(flip, `writable flag ${i}`).toMatch(/unexpected account in position/);
    }
  });

  it('refuses each argument being different from what was shown', () => {
    const edit = (f: (v: DataView, d: Buffer) => void) => after((ix) => tamper(ix, { data: (d) => f(new DataView(d.buffer, d.byteOffset, d.byteLength), d) }));
    expect(edit((v) => v.setBigUint64(8, 1n, true))).toMatch(/tokens going in/);
    expect(edit((v) => v.setBigUint64(16, 5n, true))).toMatch(/SOL going in/);
    expect(edit((v) => v.setBigUint64(24, 1n, true))).toMatch(/starting price/);
    expect(edit((v) => v.setUint16(32, 100, true))).toMatch(/trading fee/);
    expect(edit((_v, d) => (d[34] = 0))).toMatch(/would not be locked/);
    expect(edit((v) => v.setUint16(35, 2500, true))).toMatch(/launch protection/);
    expect(edit((v) => v.setUint32(37, 3600, true))).toMatch(/launch protection/);
    expect(edit((v) => v.setBigUint64(41, 5n, true))).toMatch(/price range/);
    expect(after((ix) => tamper(ix, { data: (d) => (d[34] = 1) }), params({ lock: false }))).toMatch(/would be locked, which was not chosen/);
  });

  it('refuses a pool address that is not the one shown', () => {
    const { tx, check } = make();
    expect(inspectCreate(web3, tx, { ...check, pool: OTHER }).join(' ')).toMatch(/pool address is not the one shown/);
  });

  it('refuses a transaction built for the wrong program', () => {
    const { tx, check } = make();
    expect(inspectCreate(web3, tx, { ...check, program: 'CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu' }).length).toBeGreaterThan(0);
  });
});

describe('swap', () => {
  const s = { trader: CREATOR, mint: MINT, isBuy: true, amountIn: 2_000_000_000n, minOut: 12_345n };
  const make = () => {
    const ix = buildSwap(web3, PROGRAM, s);
    return { ix, tx: assemble(web3, [ix], CREATOR, BLOCKHASH, 1) };
  };
  it('is accepted when it is what was shown, buying or selling', () => {
    for (const x of [s, { ...s, isBuy: false, amountIn: 5n, minOut: 1n }]) {
      const ix = buildSwap(web3, PROGRAM, x);
      expect(inspectSwap(web3, assemble(web3, [ix], CREATOR, BLOCKHASH, 1), { ...x, program: PROGRAM })).toEqual([]);
    }
  });
  it('pays the fee wallet only and sends the tokens to the trader’s own account', () => {
    const { ix } = make();
    const keys = ix.keys.map((k) => k.pubkey.toBase58());
    expect(keys[6]).toBe(LAUNCH_FEE_ADDRESS);
    expect(keys[5]).toBe(ataAddress(web3, CREATOR, MINT, TOKEN_2022_PROGRAM_ID));
    expect(ix.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
  });
  it('refuses a changed direction, amount or floor, and a floor of zero', () => {
    const run = (edit: (d: DataView, b: Buffer) => void) => {
      const { ix, tx } = make();
      tx.instructions[0] = tamper(ix, { data: (b) => edit(new DataView(b.buffer, b.byteOffset, b.byteLength), b) });
      return inspectSwap(web3, tx, { ...s, program: PROGRAM }).join(' ');
    };
    expect(run((_d, b) => (b[8] = 0))).toMatch(/direction/);
    expect(run((d) => d.setBigUint64(9, 1n, true))).toMatch(/amount being traded/);
    expect(run((d) => d.setBigUint64(17, 1n, true))).toMatch(/minimum you receive/);
    const { ix, tx } = make();
    tx.instructions[0] = tamper(ix, { data: (b) => new DataView(b.buffer, b.byteOffset).setBigUint64(17, 0n, true) });
    expect(inspectSwap(web3, tx, { ...s, minOut: 0n, program: PROGRAM }).join(' ')).toMatch(/no minimum/);
  });
  it('refuses another trader token account or fee wallet', () => {
    for (const i of [5, 6, 4, 2, 1]) {
      const { ix, tx } = make();
      tx.instructions[0] = tamper(ix, { keys: { [i]: { pubkey: other } } });
      expect(inspectSwap(web3, tx, { ...s, program: PROGRAM }).join(' '), `account ${i}`).toMatch(/unexpected account in position/);
    }
  });
});

describe('claim and lock', () => {
  it('are accepted when they are what was shown', () => {
    const c = buildClaim(web3, PROGRAM, CREATOR, MINT);
    expect(inspectClaim(web3, assemble(web3, [c], CREATOR, BLOCKHASH, 1), { program: PROGRAM, owner: CREATOR, mint: MINT })).toEqual([]);
    const l = buildLock(web3, PROGRAM, CREATOR, MINT, 77n);
    expect(inspectLock(web3, assemble(web3, [l], CREATOR, BLOCKHASH, 1), { program: PROGRAM, owner: CREATOR, mint: MINT, amount: 77n })).toEqual([]);
  });
  it('refuse another position, another amount, extra steps', () => {
    const c = buildClaim(web3, PROGRAM, CREATOR, MINT);
    const bad = assemble(web3, [tamper(c, { keys: { 3: { pubkey: other } } })], CREATOR, BLOCKHASH, 1);
    expect(inspectClaim(web3, bad, { program: PROGRAM, owner: CREATOR, mint: MINT }).join(' ')).toMatch(/unexpected account in position 4/);
    const pay = assemble(web3, [c, web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(CREATOR), toPubkey: other, lamports: 1 })], CREATOR, BLOCKHASH, 1);
    expect(inspectClaim(web3, pay, { program: PROGRAM, owner: CREATOR, mint: MINT }).join(' ')).toMatch(/not the single step/);
    const l = buildLock(web3, PROGRAM, CREATOR, MINT, 77n);
    expect(inspectLock(web3, assemble(web3, [l], CREATOR, BLOCKHASH, 1), { program: PROGRAM, owner: CREATOR, mint: MINT, amount: 78n }).join(' ')).toMatch(/amount being locked/);
    expect(TOKEN_PROGRAM_ID).toBeTruthy();
  });
});

describe('add and remove liquidity', () => {
  const l = { owner: CREATOR, mint: MINT, dl: 2_000_000_000n, tokens: 111n, sol: 222n };
  const tx = (ix: web3.TransactionInstruction) => assemble(web3, [ix], CREATOR, BLOCKHASH, 1);
  it('are accepted when they are what was shown', () => {
    expect(inspectAddLiquidity(web3, tx(buildAddLiquidity(web3, PROGRAM, l)), { ...l, program: PROGRAM })).toEqual([]);
    expect(buildAddLiquidity(web3, PROGRAM, l).keys).toHaveLength(10);
    expect(buildRemoveLiquidity(web3, PROGRAM, l).keys).toHaveLength(9);
    expect(inspectRemoveLiquidity(web3, tx(buildRemoveLiquidity(web3, PROGRAM, l)), { ...l, program: PROGRAM })).toEqual([]);
  });
  it('are not interchangeable: an add is refused where a remove was shown', () => {
    expect(inspectRemoveLiquidity(web3, tx(buildAddLiquidity(web3, PROGRAM, l)), { ...l, program: PROGRAM }).join(' ')).toMatch(/not the expected one/);
  });
  it('refuse a changed amount, cap or floor, and any swapped account', () => {
    const edit = (at: number) => inspectAddLiquidity(web3, tx(tamper(buildAddLiquidity(web3, PROGRAM, l), { data: (d) => new DataView(d.buffer, d.byteOffset).setBigUint64(at, 1n, true) })), { ...l, program: PROGRAM }).join(' ');
    expect(edit(8)).toMatch(/amount of liquidity/);
    expect(edit(16)).toMatch(/most tokens/);
    expect(edit(24)).toMatch(/most SOL/);
    for (let i = 0; i < 9; i++) {
      const bad = tx(tamper(buildRemoveLiquidity(web3, PROGRAM, l), { keys: { [i]: { pubkey: other } } }));
      expect(inspectRemoveLiquidity(web3, bad, { ...l, program: PROGRAM }).length, `account ${i}`).toBeGreaterThan(0);
    }
  });
});

describe('claim to another wallet, and naming it', () => {
  const tx = (ix: web3.TransactionInstruction) => assemble(web3, [ix], CREATOR, BLOCKHASH, 1);
  it('claim names the recipient and the inspector holds it to the one shown', () => {
    const c = buildClaim(web3, PROGRAM, CREATOR, MINT, OTHER);
    expect(c.keys[4]!.pubkey.toBase58()).toBe(OTHER);
    expect(inspectClaim(web3, tx(c), { program: PROGRAM, owner: CREATOR, mint: MINT, recipient: OTHER })).toEqual([]);
    expect(inspectClaim(web3, tx(c), { program: PROGRAM, owner: CREATOR, mint: MINT }).join(' ')).toMatch(/position 5/);
    expect(inspectClaim(web3, tx(buildClaim(web3, PROGRAM, CREATOR, MINT)), { program: PROGRAM, owner: CREATOR, mint: MINT, recipient: OTHER }).join(' ')).toMatch(/position 5/);
  });
  it('setting the recipient is checked byte for byte', () => {
    const s = buildSetRecipient(web3, PROGRAM, CREATOR, MINT, OTHER);
    expect(inspectSetRecipient(web3, tx(s), { program: PROGRAM, owner: CREATOR, mint: MINT, recipient: OTHER })).toEqual([]);
    expect(inspectSetRecipient(web3, tx(s), { program: PROGRAM, owner: CREATOR, mint: MINT, recipient: CREATOR }).join(' ')).toMatch(/would receive the fees/);
    const bad = tamper(s, { keys: { 2: { pubkey: other } } });
    expect(inspectSetRecipient(web3, tx(bad), { program: PROGRAM, owner: CREATOR, mint: MINT, recipient: OTHER }).join(' ')).toMatch(/position 3/);
  });
  it('the tag is sha256("global:set_recipient")', () => {
    expect(DISC.setRecipient).toEqual(Uint8Array.from(createHash('sha256').update('global:set_recipient').digest().subarray(0, 8)));
  });
});

describe('position ids and transfers', () => {
  const tx = (ix: web3.TransactionInstruction) => assemble(web3, [ix], CREATOR, BLOCKHASH, 1);
  const EXTRA = web3.Keypair.generate().publicKey.toBase58();
  it('the position address is derived from its id, not from whoever owns it now', () => {
    const pool = poolAddress(web3, PROGRAM, MINT);
    expect(positionAddress(web3, PROGRAM, pool, CREATOR)).not.toBe(positionAddress(web3, PROGRAM, pool, EXTRA));
    const c = buildClaim(web3, PROGRAM, OTHER, MINT, OTHER, CREATOR); // the new owner claims the position opened under CREATOR
    expect(c.keys[3]!.pubkey.toBase58()).toBe(positionAddress(web3, PROGRAM, pool, CREATOR));
    expect(inspectClaim(web3, assemble(web3, [c], OTHER, BLOCKHASH, 1), { program: PROGRAM, owner: OTHER, mint: MINT, recipient: OTHER, positionId: CREATOR })).toEqual([]);
    expect(inspectClaim(web3, assemble(web3, [c], OTHER, BLOCKHASH, 1), { program: PROGRAM, owner: OTHER, mint: MINT, recipient: OTHER }).join(' ')).toMatch(/position 4/);
  });
  it('a position under another id must be signed for by that id, in the builder and for the inspector', () => {
    const l = { owner: CREATOR, mint: MINT, positionId: EXTRA, dl: 5_000n, tokens: 1n, sol: 2n };
    const add = buildAddLiquidity(web3, PROGRAM, l);
    expect(add.keys[9]).toMatchObject({ isSigner: true, isWritable: false });
    expect(add.keys[9]!.pubkey.toBase58()).toBe(EXTRA);
    expect(inspectAddLiquidity(web3, tx(add), { ...l, program: PROGRAM })).toEqual([]);
    const unsigned = tamper(add, { keys: { 9: { isSigner: false } } });
    expect(inspectAddLiquidity(web3, tx(unsigned), { ...l, program: PROGRAM }).join(' ')).toMatch(/position 10/);
    const c = buildCreatePool(web3, PROGRAM, params(), CREATOR, EXTRA);
    expect(c.positionId).toBe(EXTRA);
    expect(inspectCreate(web3, tx(c.instructions[0]!), { params: params(), program: PROGRAM, pool: c.pool, positionId: EXTRA })).toEqual([]);
    expect(inspectCreate(web3, tx(c.instructions[0]!), { params: params(), program: PROGRAM, pool: c.pool }).join(' ')).toMatch(/position 8|position 13/);
  });
  it('a transfer is checked byte for byte, and the tag is right', () => {
    const t = buildTransferPosition(web3, PROGRAM, CREATOR, MINT, OTHER);
    expect(inspectTransferPosition(web3, tx(t), { program: PROGRAM, owner: CREATOR, mint: MINT, newOwner: OTHER })).toEqual([]);
    expect(inspectTransferPosition(web3, tx(t), { program: PROGRAM, owner: CREATOR, mint: MINT, newOwner: EXTRA }).join(' ')).toMatch(/would go to/);
    const bad = tamper(t, { keys: { 2: { pubkey: other } } });
    expect(inspectTransferPosition(web3, tx(bad), { program: PROGRAM, owner: CREATOR, mint: MINT, newOwner: OTHER }).join(' ')).toMatch(/position 3/);
    expect(DISC.transferPosition).toEqual(Uint8Array.from(createHash('sha256').update('global:transfer_position').digest().subarray(0, 8)));
  });
});

describe('the buyer’s own token account', () => {
  const s = { trader: CREATOR, mint: MINT, isBuy: true, amountIn: 1_000_000_000n, minOut: 5n };
  const ata = ensureTokenAccount(web3, CREATOR, MINT);
  const swap = buildSwap(web3, PROGRAM, s);
  const tx = (...ixs: web3.TransactionInstruction[]) => assemble(web3, ixs, CREATOR, BLOCKHASH, 1);
  it('may come first, byte for byte, and is optional', () => {
    expect(inspectSwap(web3, tx(ata, swap), { ...s, program: PROGRAM })).toEqual([]);
    expect(inspectSwap(web3, tx(swap), { ...s, program: PROGRAM })).toEqual([]);
  });
  it('is refused if it creates an account for anyone else, or does anything else', () => {
    const forOther = tamper(ata, { keys: { 2: { pubkey: other } } });
    expect(inspectSwap(web3, tx(forOther, swap), { ...s, program: PROGRAM }).join(' ')).toMatch(/creation of your own token account/);
    const wrongAccount = tamper(ata, { keys: { 1: { pubkey: other } } });
    expect(inspectSwap(web3, tx(wrongAccount, swap), { ...s, program: PROGRAM }).join(' ')).toMatch(/creation of your own token account/);
    const notCreate = tamper(ata, { data: (d) => (d[0] = 0) });
    expect(inspectSwap(web3, tx(notCreate, swap), { ...s, program: PROGRAM }).join(' ')).toMatch(/creation of your own token account/);
    const steal = web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(CREATOR), toPubkey: other, lamports: 1 });
    expect(inspectSwap(web3, tx(steal, swap), { ...s, program: PROGRAM }).join(' ')).toMatch(/creation of your own token account/);
    expect(inspectSwap(web3, tx(ata, swap, steal), { ...s, program: PROGRAM }).join(' ')).toMatch(/not the single step/);
  });
  it('is allowed before adding liquidity but not before a claim', () => {
    const l = { owner: CREATOR, mint: MINT, dl: 5_000n, tokens: 1n, sol: 2n };
    expect(inspectAddLiquidity(web3, tx(ata, buildAddLiquidity(web3, PROGRAM, l)), { ...l, program: PROGRAM })).toEqual([]);
    expect(inspectClaim(web3, tx(ata, buildClaim(web3, PROGRAM, CREATOR, MINT)), { program: PROGRAM, owner: CREATOR, mint: MINT }).join(' ')).toMatch(/not the single step/);
  });
});
