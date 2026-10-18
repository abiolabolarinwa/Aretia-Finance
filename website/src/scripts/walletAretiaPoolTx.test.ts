import { createHash } from 'node:crypto';
import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import vectors from './__fixtures__/aretiaPoolVectors.json';
import { ARETIA_POOL_FEE_ADDRESS, ARETIA_POOL_PROGRAM_ID_DEVNET, type CreateParams } from './walletAretiaPoolCore';
import {
  DISC,
  assemble,
  buildAddLiquidity,
  buildAddSteps,
  buildClaimSteps,
  buildCreatePool,
  buildLock,
  buildRemoveLiquidity,
  buildRemoveSteps,
  buildSetRecipient,
  buildSwap,
  buildSwapSteps,
  buildTransferPosition,
  inspectAddLiquidity,
  inspectClaim,
  inspectCreate,
  inspectLock,
  inspectRemoveLiquidity,
  inspectSetRecipient,
  inspectSwap,
  inspectTransferPosition,
  poolAddress,
  positionAddress,
  solVaultAddress,
  wsolAccount,
} from './walletAretiaPoolTx';
import { LAUNCH_FEE_ADDRESS } from './walletLaunchCore';
import { WSOL_MINT } from './walletPoolCore';
import { ATA_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ataAddress } from './walletTools';

const PROGRAM = ARETIA_POOL_PROGRAM_ID_DEVNET;
const CREATOR = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const OTHER = '3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg';
const MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k';
const other = new web3.PublicKey(OTHER);
const EXTRA = web3.Keypair.generate().publicKey.toBase58();
const params = (over: Partial<CreateParams> = {}): CreateParams => ({ creator: CREATOR, mint: MINT, x0: 600_000_000_000_000n, y0: 0n, l0: 10_000_200_000n, feeBps: 25, lock: true, sniperBps: 1000, decaySecs: 300, vx0: 0n, ...over });

const tamper = (ix: web3.TransactionInstruction, over: { keys?: Record<number, Partial<web3.AccountMeta>>; data?: (d: Buffer) => void; programId?: web3.PublicKey }) => {
  const keys = ix.keys.map((k, i) => ({ ...k, ...(over.keys?.[i] ?? {}) }));
  const d = Buffer.from(ix.data);
  over.data?.(d);
  return new web3.TransactionInstruction({ programId: over.programId ?? ix.programId, keys, data: d });
};
const tx = (ixs: web3.TransactionInstruction[], payer = CREATOR) => assemble(web3, ixs, payer, BLOCKHASH, 1);
/** The index of the pool program's own step in a list. */
const poolAt = (ixs: web3.TransactionInstruction[]) => ixs.findIndex((i) => i.programId.toBase58() === PROGRAM);
/** Replaces one step with a changed copy. */
const change = (ixs: web3.TransactionInstruction[], at: number, f: (ix: web3.TransactionInstruction) => web3.TransactionInstruction) => ixs.map((ix, i) => (i === at ? f(ix) : ix));

describe('the instruction tags', () => {
  it('are the first 8 bytes of sha256("global:<name>"), as Anchor writes them', () => {
    const tag = (n: string) => Uint8Array.from(createHash('sha256').update(`global:${n}`).digest().subarray(0, 8));
    expect(DISC.createPool).toEqual(tag('create_pool'));
    expect(DISC.swap).toEqual(tag('swap'));
    expect(DISC.addLiquidity).toEqual(tag('add_liquidity'));
    expect(DISC.removeLiquidity).toEqual(tag('remove_liquidity'));
    expect(DISC.claimFees).toEqual(tag('claim_fees'));
    expect(DISC.lockLiquidity).toEqual(tag('lock_liquidity'));
    expect(DISC.transferPosition).toEqual(tag('transfer_position'));
    expect(DISC.setRecipient).toEqual(tag('set_recipient'));
  });
});

describe('the addresses', () => {
  it('match the ones the Rust program derives, and the SOL vault is the pool’s wrapped-SOL account', () => {
    for (const a of vectors.addresses) {
      const pool = poolAddress(web3, vectors.program, a.mint);
      expect(pool).toBe(a.pool);
      expect(solVaultAddress(web3, vectors.program, pool)).toBe(a.solVault);
      expect(a.solVault).toBe(ataAddress(web3, pool, WSOL_MINT, TOKEN_PROGRAM_ID));
      expect(ataAddress(web3, pool, a.mint, TOKEN_2022_PROGRAM_ID)).toBe(a.tokenVault);
      expect(positionAddress(web3, vectors.program, pool, a.owner)).toBe(a.position);
    }
  });
});

describe('create pool', () => {
  const make = (p = params()) => {
    const b = buildCreatePool(web3, PROGRAM, p);
    return { b, ixs: b.instructions, check: { params: p, program: PROGRAM, pool: b.pool } };
  };

  it('is Aretia’s wrapped-SOL account, the pool, and nothing else when no SOL is brought; the inspector accepts it', () => {
    for (const p of [params(), params({ lock: false }), params({ feeBps: 100 }), params({ vx0: 7n })]) {
      const { ixs, check } = make(p);
      expect(ixs).toHaveLength(2);
      expect(inspectCreate(web3, tx(ixs), check)).toEqual([]);
    }
  });

  it('wraps and unwraps the SOL the creator brings, step by step, and the inspector accepts that', () => {
    const { ixs, check } = make(params({ y0: 3_000_000_000n }));
    // fee account, ata, transfer, sync, pool, close
    expect(ixs).toHaveLength(6);
    expect(inspectCreate(web3, tx(ixs), check)).toEqual([]);
    // Wrapping a different amount than the pool is told about is refused.
    const bad = change(ixs, 2, (ix) => tamper(ix, { data: (d) => d.writeBigUInt64LE(1n, 4) }));
    expect(inspectCreate(web3, tx(bad), check).join(' ')).toMatch(/Step 3/);
  });

  it('puts the accounts in the order the program takes them, with the creation fee going to Aretia’s wallet', () => {
    const { b, ixs } = make();
    const ix = ixs[poolAt(ixs)]!;
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
      WSOL_MINT,
      wsolAccount(web3, CREATOR),
      TOKEN_PROGRAM_ID,
    ]);
    expect(ARETIA_POOL_FEE_ADDRESS).toBe(LAUNCH_FEE_ADDRESS);
    expect(ixs.flatMap((i) => i.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58()))).toSatisfy((s: string[]) => s.every((x) => x === CREATOR));
  });

  it('encodes the arguments little-endian after the tag', () => {
    const { ixs } = make();
    const d = ixs[poolAt(ixs)]!.data;
    expect(d.length).toBe(49);
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    expect([v.getBigUint64(8, true), v.getBigUint64(16, true), v.getBigUint64(24, true), v.getUint16(32, true), d[34], v.getUint16(35, true), v.getUint32(37, true), v.getBigUint64(41, true)]).toEqual([600_000_000_000_000n, 0n, 10_000_200_000n, 25, 1, 1000, 300, 0n]);
  });

  it('refuses a different fee payer or an extra signer', () => {
    const { ixs, check } = make();
    const t = tx(ixs);
    t.feePayer = other;
    expect(inspectCreate(web3, t, check).join(' ')).toMatch(/fee would be paid by an account other than yours/);
    const signed = change(ixs, poolAt(ixs), (ix) => tamper(ix, { keys: { 4: { isSigner: true } } }));
    expect(inspectCreate(web3, tx(signed), check).join(' ')).toMatch(/unexpected account would have to sign/);
  });

  it('refuses any extra, missing or reordered step', () => {
    const { ixs, check } = make();
    const steal = web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(CREATOR), toPubkey: other, lamports: 1 });
    expect(inspectCreate(web3, tx([...ixs, steal]), check).join(' ')).toMatch(/not the set of steps/);
    expect(inspectCreate(web3, tx([steal, ...ixs]), check).join(' ')).toMatch(/not the set of steps/);
    expect(inspectCreate(web3, tx([ixs[1]!]), check).join(' ')).toMatch(/not the set of steps/);
    expect(inspectCreate(web3, tx([ixs[1]!, ixs[0]!]), check).join(' ').length).toBeGreaterThan(0);
    expect(inspectCreate(web3, new web3.Transaction({ feePayer: new web3.PublicKey(CREATOR), blockhash: BLOCKHASH, lastValidBlockHeight: 1 }), check).join(' ')).toMatch(/not the set of steps/);
  });

  it('refuses a fee account made for anyone but Aretia, or paid by anyone else', () => {
    const { ixs, check } = make();
    expect(inspectCreate(web3, tx(change(ixs, 0, (ix) => tamper(ix, { keys: { 2: { pubkey: other } } }))), check).join(' ')).toMatch(/Step 1/);
    expect(inspectCreate(web3, tx(change(ixs, 0, (ix) => tamper(ix, { keys: { 0: { pubkey: other } } }))), check).join(' ')).toMatch(/Step 1|fee/);
  });

  it('refuses another program, another step, or a different set of accounts', () => {
    const { ixs, check } = make();
    const at = poolAt(ixs);
    expect(inspectCreate(web3, tx(change(ixs, at, (ix) => tamper(ix, { programId: other }))), check).join(' ')).toMatch(/not made by the pool program/);
    expect(inspectCreate(web3, tx(change(ixs, at, (ix) => tamper(ix, { data: (d) => d.set([1, 2, 3, 4, 5, 6, 7, 8]) }))), check).join(' ')).toMatch(/not the expected one/);
    expect(inspectCreate(web3, tx(change(ixs, at, (ix) => new web3.TransactionInstruction({ programId: ix.programId, keys: ix.keys.slice(0, 15), data: ix.data }))), check).join(' ')).toMatch(/different set of accounts/);
    expect(inspectCreate(web3, tx(change(ixs, at, (ix) => new web3.TransactionInstruction({ programId: ix.programId, keys: ix.keys, data: Buffer.concat([ix.data, Buffer.from([0])]) }))), check).join(' ')).toMatch(/not the expected one/);
  });

  it('refuses every account being swapped for another, and every flag flipped', () => {
    const { ixs, check } = make();
    const at = poolAt(ixs);
    for (let i = 0; i < 16; i++) {
      const msg = inspectCreate(web3, tx(change(ixs, at, (ix) => tamper(ix, { keys: { [i]: { pubkey: other } } }))), check).join(' ');
      expect(msg, `account ${i}`).toMatch(/unexpected account in position|have to sign/);
      const flip = inspectCreate(web3, tx(change(ixs, at, (ix) => tamper(ix, { keys: { [i]: { isWritable: !ix.keys[i]!.isWritable } } }))), check).join(' ');
      expect(flip, `flag ${i}`).toMatch(/unexpected account in position/);
    }
  });

  it('refuses each argument being different from what was shown', () => {
    const { ixs, check } = make();
    const at = poolAt(ixs);
    const edit = (f: (v: DataView, d: Buffer) => void) => inspectCreate(web3, tx(change(ixs, at, (ix) => tamper(ix, { data: (d) => f(new DataView(d.buffer, d.byteOffset, d.byteLength), d) }))), check).join(' ');
    expect(edit((v) => v.setBigUint64(8, 1n, true))).toMatch(/tokens going in/);
    expect(edit((v) => v.setBigUint64(16, 5n, true))).toMatch(/SOL going in/);
    expect(edit((v) => v.setBigUint64(24, 1n, true))).toMatch(/starting price/);
    expect(edit((v) => v.setUint16(32, 100, true))).toMatch(/trading fee/);
    expect(edit((_v, d) => (d[34] = 0))).toMatch(/would not be locked/);
    expect(edit((v) => v.setUint16(35, 2500, true))).toMatch(/launch protection/);
    expect(edit((v) => v.setUint32(37, 3600, true))).toMatch(/launch protection/);
    expect(edit((v) => v.setBigUint64(41, 5n, true))).toMatch(/price range/);
    const unlocked = make(params({ lock: false }));
    expect(inspectCreate(web3, tx(change(unlocked.ixs, poolAt(unlocked.ixs), (ix) => tamper(ix, { data: (d) => (d[34] = 1) }))), unlocked.check).join(' ')).toMatch(/would be locked, which was not chosen/);
  });

  it('refuses a pool address that is not the one shown, and a program that is not the one shown', () => {
    const { ixs, check } = make();
    expect(inspectCreate(web3, tx(ixs), { ...check, pool: OTHER }).join(' ')).toMatch(/pool address is not the one shown/);
    expect(inspectCreate(web3, tx(ixs), { ...check, program: 'CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu' }).length).toBeGreaterThan(0);
  });

  it('a position under another id must be signed for by that id', () => {
    const c = buildCreatePool(web3, PROGRAM, params(), CREATOR, EXTRA);
    expect(c.positionId).toBe(EXTRA);
    const check = { params: params(), program: PROGRAM, pool: c.pool, positionId: EXTRA };
    expect(inspectCreate(web3, tx(c.instructions), check)).toEqual([]);
    expect(inspectCreate(web3, tx(c.instructions), { ...check, positionId: undefined }).join(' ')).toMatch(/position 8|position 13/);
  });
});

describe('swap', () => {
  const buy = { trader: CREATOR, mint: MINT, isBuy: true, amountIn: 2_000_000_000n, minOut: 12_345n };
  const sell = { trader: CREATOR, mint: MINT, isBuy: false, amountIn: 5_000n, minOut: 1n };
  it('a buy wraps the SOL, swaps, and unwraps: six steps, all accepted', () => {
    const ixs = buildSwapSteps(web3, PROGRAM, buy);
    expect(ixs).toHaveLength(6); // token account, wsol account, transfer, sync, swap, close
    expect(inspectSwap(web3, tx(ixs), { ...buy, program: PROGRAM })).toEqual([]);
  });
  it('a sell makes the wrapped-SOL account and unwraps the proceeds: three steps', () => {
    const ixs = buildSwapSteps(web3, PROGRAM, sell);
    expect(ixs).toHaveLength(3);
    expect(inspectSwap(web3, tx(ixs), { ...sell, program: PROGRAM })).toEqual([]);
  });
  it('the swap itself takes the trader’s and Aretia’s wrapped-SOL accounts and both token programs', () => {
    const ix = buildSwap(web3, PROGRAM, buy);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      CREATOR,
      poolAddress(web3, PROGRAM, MINT),
      solVaultAddress(web3, PROGRAM, poolAddress(web3, PROGRAM, MINT)),
      MINT,
      ataAddress(web3, poolAddress(web3, PROGRAM, MINT), MINT, TOKEN_2022_PROGRAM_ID),
      ataAddress(web3, CREATOR, MINT, TOKEN_2022_PROGRAM_ID),
      wsolAccount(web3, CREATOR),
      wsolAccount(web3, LAUNCH_FEE_ADDRESS),
      TOKEN_2022_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
    ]);
    expect(ix.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
  });
  it('refuses a wrap of a different amount, an unwrap into someone else’s account, and a missing unwrap', () => {
    const ixs = buildSwapSteps(web3, PROGRAM, buy);
    const check = { ...buy, program: PROGRAM };
    expect(inspectSwap(web3, tx(change(ixs, 2, (ix) => tamper(ix, { data: (d) => d.writeBigUInt64LE(9_000_000_000n, 4) }))), check).join(' ')).toMatch(/Step 3/);
    expect(inspectSwap(web3, tx(change(ixs, 5, (ix) => tamper(ix, { keys: { 1: { pubkey: other } } }))), check).join(' ')).toMatch(/unwrap/);
    expect(inspectSwap(web3, tx(ixs.slice(0, 5)), check).join(' ')).toMatch(/not the set of steps/);
    expect(inspectSwap(web3, tx(ixs), { ...check, isBuy: false }).join(' ')).toMatch(/not the set of steps|direction/);
  });
  it('refuses a changed direction, amount or floor, and a floor of zero', () => {
    const ixs = buildSwapSteps(web3, PROGRAM, buy);
    const at = poolAt(ixs);
    const run = (edit: (d: DataView, b: Buffer) => void) => inspectSwap(web3, tx(change(ixs, at, (ix) => tamper(ix, { data: (b) => edit(new DataView(b.buffer, b.byteOffset, b.byteLength), b) }))), { ...buy, program: PROGRAM }).join(' ');
    expect(run((_d, b) => (b[8] = 0))).toMatch(/direction/);
    expect(run((d) => d.setBigUint64(9, 1n, true))).toMatch(/amount being traded/);
    expect(run((d) => d.setBigUint64(17, 1n, true))).toMatch(/minimum you receive/);
    const zero = { ...buy, minOut: 0n };
    expect(inspectSwap(web3, tx(buildSwapSteps(web3, PROGRAM, zero)), { ...zero, program: PROGRAM }).join(' ')).toMatch(/no minimum/);
  });
  it('refuses another trader token account, wrapped-SOL account, Aretia fee account, vault or pool', () => {
    const ixs = buildSwapSteps(web3, PROGRAM, buy);
    const at = poolAt(ixs);
    for (const i of [1, 2, 4, 5, 6, 7]) {
      expect(inspectSwap(web3, tx(change(ixs, at, (ix) => tamper(ix, { keys: { [i]: { pubkey: other } } }))), { ...buy, program: PROGRAM }).join(' '), `account ${i}`).toMatch(/unexpected account in position/);
    }
  });
});

describe('claim, lock, set recipient, transfer', () => {
  it('a claim makes the recipient’s wrapped-SOL account and, for the owner, unwraps; for another wallet it leaves the wrapped SOL there', () => {
    const own = buildClaimSteps(web3, PROGRAM, CREATOR, MINT);
    expect(own).toHaveLength(3);
    expect(inspectClaim(web3, tx(own), { program: PROGRAM, owner: CREATOR, mint: MINT })).toEqual([]);
    const away = buildClaimSteps(web3, PROGRAM, CREATOR, MINT, OTHER);
    expect(away).toHaveLength(2);
    expect(inspectClaim(web3, tx(away), { program: PROGRAM, owner: CREATOR, mint: MINT, recipient: OTHER })).toEqual([]);
    // A claim shown as going to the owner but built for someone else, or the reverse, is refused.
    expect(inspectClaim(web3, tx(away), { program: PROGRAM, owner: CREATOR, mint: MINT }).join(' ').length).toBeGreaterThan(0);
    expect(inspectClaim(web3, tx(own), { program: PROGRAM, owner: CREATOR, mint: MINT, recipient: OTHER }).join(' ').length).toBeGreaterThan(0);
  });
  it('a sold position is claimed under its id, by the new owner', () => {
    const pool = poolAddress(web3, PROGRAM, MINT);
    const c = buildClaimSteps(web3, PROGRAM, OTHER, MINT, OTHER, CREATOR);
    expect(c[poolAt(c)]!.keys[3]!.pubkey.toBase58()).toBe(positionAddress(web3, PROGRAM, pool, CREATOR));
    expect(inspectClaim(web3, tx(c, OTHER), { program: PROGRAM, owner: OTHER, mint: MINT, recipient: OTHER, positionId: CREATOR })).toEqual([]);
    expect(inspectClaim(web3, tx(c, OTHER), { program: PROGRAM, owner: OTHER, mint: MINT, recipient: OTHER }).join(' ')).toMatch(/position 4/);
  });
  it('lock, set recipient and transfer are one step each, checked byte for byte', () => {
    const l = buildLock(web3, PROGRAM, CREATOR, MINT, 77n);
    expect(inspectLock(web3, tx([l]), { program: PROGRAM, owner: CREATOR, mint: MINT, amount: 77n })).toEqual([]);
    expect(inspectLock(web3, tx([l]), { program: PROGRAM, owner: CREATOR, mint: MINT, amount: 78n }).join(' ')).toMatch(/amount being locked/);
    const s = buildSetRecipient(web3, PROGRAM, CREATOR, MINT, OTHER);
    expect(inspectSetRecipient(web3, tx([s]), { program: PROGRAM, owner: CREATOR, mint: MINT, recipient: OTHER })).toEqual([]);
    expect(inspectSetRecipient(web3, tx([s]), { program: PROGRAM, owner: CREATOR, mint: MINT, recipient: CREATOR }).join(' ')).toMatch(/would receive the fees/);
    const t = buildTransferPosition(web3, PROGRAM, CREATOR, MINT, OTHER);
    expect(inspectTransferPosition(web3, tx([t]), { program: PROGRAM, owner: CREATOR, mint: MINT, newOwner: OTHER })).toEqual([]);
    expect(inspectTransferPosition(web3, tx([t]), { program: PROGRAM, owner: CREATOR, mint: MINT, newOwner: EXTRA }).join(' ')).toMatch(/would go to/);
    expect(inspectTransferPosition(web3, tx([tamper(t, { keys: { 2: { pubkey: other } } })]), { program: PROGRAM, owner: CREATOR, mint: MINT, newOwner: OTHER }).join(' ')).toMatch(/position 3/);
    const steal = web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(CREATOR), toPubkey: other, lamports: 1 });
    expect(inspectLock(web3, tx([l, steal]), { program: PROGRAM, owner: CREATOR, mint: MINT, amount: 77n }).join(' ')).toMatch(/not the set of steps/);
    expect(DISC.transferPosition).toEqual(Uint8Array.from(createHash('sha256').update('global:transfer_position').digest().subarray(0, 8)));
  });
});

describe('add and remove liquidity', () => {
  const l = { owner: CREATOR, mint: MINT, dl: 2_000_000_000n, tokens: 111n, sol: 222n };
  it('adding wraps the most SOL it will pay and unwraps what is left; removing unwraps what comes back', () => {
    const add = buildAddSteps(web3, PROGRAM, l);
    expect(add).toHaveLength(6);
    expect(inspectAddLiquidity(web3, tx(add), { ...l, program: PROGRAM })).toEqual([]);
    const rem = buildRemoveSteps(web3, PROGRAM, l);
    expect(rem).toHaveLength(4);
    expect(inspectRemoveLiquidity(web3, tx(rem), { ...l, program: PROGRAM })).toEqual([]);
    expect(buildAddLiquidity(web3, PROGRAM, l).keys).toHaveLength(12);
    expect(buildRemoveLiquidity(web3, PROGRAM, l).keys).toHaveLength(11);
  });
  it('are not interchangeable', () => {
    expect(inspectRemoveLiquidity(web3, tx(buildAddSteps(web3, PROGRAM, l)), { ...l, program: PROGRAM }).join(' ').length).toBeGreaterThan(0);
  });
  it('refuse a changed amount, cap or floor, a different wrap, and any swapped account', () => {
    const add = buildAddSteps(web3, PROGRAM, l);
    const at = poolAt(add);
    const edit = (off: number) => inspectAddLiquidity(web3, tx(change(add, at, (ix) => tamper(ix, { data: (d) => new DataView(d.buffer, d.byteOffset).setBigUint64(off, 1n, true) }))), { ...l, program: PROGRAM }).join(' ');
    expect(edit(8)).toMatch(/amount of liquidity/);
    expect(edit(16)).toMatch(/most tokens/);
    expect(edit(24)).toMatch(/most SOL/);
    expect(inspectAddLiquidity(web3, tx(change(add, 2, (ix) => tamper(ix, { data: (d) => d.writeBigUInt64LE(999_999n, 4) }))), { ...l, program: PROGRAM }).join(' ')).toMatch(/Step 3/);
    const rem = buildRemoveSteps(web3, PROGRAM, l);
    for (let i = 0; i < 11; i++) {
      const bad = tx(change(rem, poolAt(rem), (ix) => tamper(ix, { keys: { [i]: { pubkey: other } } })));
      expect(inspectRemoveLiquidity(web3, bad, { ...l, program: PROGRAM }).length, `account ${i}`).toBeGreaterThan(0);
    }
  });
  it('a position under another id must be signed for by that id', () => {
    const lp = { ...l, positionId: EXTRA };
    const add = buildAddSteps(web3, PROGRAM, lp);
    const ix = add[poolAt(add)]!;
    expect(ix.keys[9]).toMatchObject({ isSigner: true, isWritable: false });
    expect(ix.keys[9]!.pubkey.toBase58()).toBe(EXTRA);
    expect(inspectAddLiquidity(web3, tx(add), { ...lp, program: PROGRAM })).toEqual([]);
    expect(inspectAddLiquidity(web3, tx(change(add, poolAt(add), (x) => tamper(x, { keys: { 9: { isSigner: false } } }))), { ...lp, program: PROGRAM }).join(' ')).toMatch(/position 10/);
  });
});
