import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import fixtures from './__fixtures__/launchTokenCreation.json';
import { LAUNCH_FEE_ADDRESS, LAUNCH_FEE_LAMPORTS, distributionOf, type LaunchConfig } from './walletLaunchCore';
import { ATA_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ataAddress } from './walletTools';
import { SYSTEM_PROGRAM_ID, assemble, buildStep1, buildStep2, decodeInstruction, inspectStep, mintSizes } from './walletLaunchTx';

const PAYER = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const TREASURY = '2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2';
const MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const OTHER = 'GBSXCpRGXLhbmmjUz2cpFYwUzHdxBdDQRxsoTuazW8gP';
const RENT = 2_000_000n;

const config = (over: Partial<LaunchConfig> = {}): LaunchConfig => ({
  creator: PAYER,
  name: 'Aretia Test Token',
  symbol: 'ATEST',
  decimals: 6,
  totalSupplyRaw: 1_000_000_000n * 10n ** 6n,
  creatorBps: 1000,
  treasury: { address: TREASURY, bps: 500 },
  reservedBps: 8500,
  metadataUri: 'https://example.com/m.json',
  metadataMutable: false,
  ...over,
});

const hex = (d: Uint8Array) => Buffer.from(d).toString('hex');
const role = (m: web3.AccountMeta) => (m.isSigner ? (m.isWritable ? 'ws' : 'rs') : m.isWritable ? 'w' : 'r');
const shape = (ix: web3.TransactionInstruction) => ({
  program: ix.programId.toBase58(),
  accounts: ix.keys.map((m) => ({ address: m.pubkey.toBase58(), role: role(m) })),
  data: hex(Uint8Array.from(ix.data)),
});

type Fixture = { sizes: { allocated: number; withMetadata: number }; step1: ReturnType<typeof shape>[]; step2: ReturnType<typeof shape>[]; distribution: { owner: string; amount: string }[] };
const fx = fixtures as unknown as Record<string, Fixture>;

describe('the instructions match what the Aretia Wallet extension builds with the official Token-2022 client', () => {
  const c = config();
  it('mint sizes', () => {
    expect(mintSizes(c)).toEqual(fx.renouncedImmutable!.sizes);
    expect(mintSizes(config({ metadataUri: '', metadataMutable: true }))).toEqual(fx.keepEverything!.sizes);
  });
  it('transaction 1, byte for byte, for a token whose metadata can never change (except how it is made immutable)', () => {
    const ours = buildStep1(web3, { config: c, mint: MINT, mintRentLamports: RENT }).map(shape);
    const theirs = fx.renouncedImmutable!.step1;
    // After the Aretia fee transfer: the account, the pointer and the mint are identical.
    expect(ours.slice(1, 4)).toEqual(theirs.slice(0, 3));
    // The extension writes the metadata with no update authority at all. Token-2022 on mainnet refuses that (InvalidArgument, found by
    // simulating it, see walletLaunch.live.ts), so this page writes it with the creator as update authority and removes that authority in
    // the next instruction. Everything else in the metadata instruction is identical.
    const metadata = ours[4]!;
    expect(metadata.data).toBe(theirs[3]!.data);
    expect(metadata.program).toBe(theirs[3]!.program);
    expect(metadata.accounts.map((a, i) => (i === 1 ? null : a))).toEqual(theirs[3]!.accounts.map((a, i) => (i === 1 ? null : a)));
    expect(metadata.accounts[1]).toEqual({ address: c.creator, role: 'r' });
    expect(theirs[3]!.accounts[1]!.address).toBe(SYSTEM_PROGRAM_ID);
    // And the sixth instruction gives the authority up: the interface's UpdateAuthority with "none".
    expect(ours).toHaveLength(6);
    expect(ours[5]).toEqual({ program: TOKEN_2022_PROGRAM_ID, accounts: [{ address: MINT, role: 'w' }, { address: c.creator, role: 'rs' }], data: 'd7e4a6e45464567b' + '00'.repeat(32) });
  });
  it('transaction 2, byte for byte', () => {
    expect(buildStep2(web3, c, MINT).map(shape)).toEqual(fx.renouncedImmutable!.step2);
  });
  it('splits the supply the same way', () => {
    expect(distributionOf(c).map((d) => ({ owner: d.owner, amount: d.amount.toString() }))).toEqual(fx.renouncedImmutable!.distribution);
  });
  it('matches for a token whose metadata stays changeable (the parts this page supports)', () => {
    const mutable = config({ metadataUri: '', metadataMutable: true });
    const ours = buildStep1(web3, { config: mutable, mint: MINT, mintRentLamports: RENT }).slice(1).map(shape);
    const theirs = fx.keepEverything!.step1;
    expect(ours[0]).toEqual(theirs[0]); // create account
    expect(ours[1]).toEqual(theirs[1]); // metadata pointer
    expect(ours[3]).toEqual(theirs[3]); // metadata, with the creator as update authority
    // The extension can keep a freeze authority; this page never does, and that is the only difference in the mint instruction.
    // Same first 34 bytes (instruction, decimals, mint authority); then the extension adds a freeze option, this page never does.
    expect(ours[2]!.data.slice(0, 68)).toBe(theirs[2]!.data.slice(0, 68));
    expect(ours[2]!.data.slice(68)).toBe('00');
    expect(theirs[2]!.data.slice(68, 70)).toBe('01');
    expect(theirs[2]!.data.length).toBeGreaterThan(ours[2]!.data.length);
    expect(buildStep2(web3, mutable, MINT).map(shape).slice(0, -1)).toEqual(fx.keepEverything!.step2);
  });
});

const tx1 = (c = config()) => assemble(web3, buildStep1(web3, { config: c, mint: MINT, mintRentLamports: RENT }), c.creator, 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k', 1);
const tx2 = (c = config()) => assemble(web3, buildStep2(web3, c, MINT), c.creator, 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k', 1);
const input = (c = config()) => ({ config: c, mint: MINT, mintRentLamports: RENT });

describe('inspectStep accepts exactly what was shown', () => {
  it('for both transactions, with and without a treasury, and with changeable metadata', () => {
    for (const c of [config(), config({ treasury: null, reservedBps: 9000 }), config({ metadataMutable: true }), config({ treasury: { address: PAYER, bps: 500 } })]) {
      expect(inspectStep(web3, tx1(c), 1, input(c)), 'tx1').toEqual([]);
      expect(inspectStep(web3, tx2(c), 2, input(c)), 'tx2').toEqual([]);
    }
  });
});

describe('the Aretia fee', () => {
  const withFee = (lamports: bigint, to: string, from = PAYER) => {
    const t = tx1();
    t.instructions[0] = web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(from), toPubkey: new web3.PublicKey(to), lamports });
    return t;
  };
  it('is the first instruction: 0.05 SOL to the management-fee wallet', () => {
    const first = decodeInstruction(web3, buildStep1(web3, input())[0]!);
    expect(first).toEqual({ kind: 'transfer', from: PAYER, to: LAUNCH_FEE_ADDRESS, lamports: LAUNCH_FEE_LAMPORTS });
    expect(LAUNCH_FEE_LAMPORTS).toBe(50_000_000n);
  });
  it('is accepted only when the amount and recipient are exactly the ones shown', () => {
    expect(inspectStep(web3, withFee(LAUNCH_FEE_LAMPORTS, LAUNCH_FEE_ADDRESS), 1, input())).toEqual([]);
    expect(inspectStep(web3, withFee(LAUNCH_FEE_LAMPORTS + 1n, LAUNCH_FEE_ADDRESS), 1, input()).join(' ')).toMatch(/fee is not the amount/);
    expect(inspectStep(web3, withFee(LAUNCH_FEE_LAMPORTS, OTHER), 1, input()).join(' ')).toMatch(/fee would go to an account/);
  });
  it('is refused when it is missing, taken from another account, or paid twice', () => {
    const missing = tx1();
    missing.instructions.shift();
    expect(inspectStep(web3, missing, 1, input()).join(' ')).toMatch(/not the expected/);
    expect(inspectStep(web3, withFee(LAUNCH_FEE_LAMPORTS, LAUNCH_FEE_ADDRESS, OTHER), 1, input()).length).toBeGreaterThan(0);
    const twice = tx1();
    twice.instructions.unshift(twice.instructions[0]!);
    expect(inspectStep(web3, twice, 1, input()).join(' ')).toMatch(/not the expected/);
  });
  it('is never part of the second transaction', () => {
    const t = tx2();
    t.instructions.unshift(buildStep1(web3, input())[0]!);
    expect(inspectStep(web3, t, 2, input()).join(' ')).toMatch(/not the expected/);
  });
});

describe('inspectStep refuses anything else', () => {
  const add = (tx: web3.Transaction, ix: web3.TransactionInstruction) => {
    tx.add(ix);
    return tx;
  };
  const theft = web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(PAYER), toPubkey: new web3.PublicKey(OTHER), lamports: 1_000_000_000 });

  it('an extra SOL transfer', () => {
    expect(inspectStep(web3, add(tx1(), theft), 1, input()).join(' ')).toMatch(/not the expected/);
    expect(inspectStep(web3, add(tx2(), theft), 2, input()).join(' ')).toMatch(/not the expected/);
  });
  it('a different fee payer', () => {
    const t = tx1();
    t.feePayer = new web3.PublicKey(OTHER);
    expect(inspectStep(web3, t, 1, input()).join(' ')).toMatch(/fee would be paid/);
  });
  it('an unexpected signer', () => {
    const t = tx1();
    t.add(new web3.TransactionInstruction({ programId: new web3.PublicKey(TOKEN_2022_PROGRAM_ID), keys: [{ pubkey: new web3.PublicKey(OTHER), isSigner: true, isWritable: false }], data: Buffer.from([99]) }));
    expect(inspectStep(web3, t, 1, input()).length).toBeGreaterThan(0);
    // The new token's key may sign the first transaction, but not the second.
    const t2 = tx2();
    t2.instructions[0]!.keys[1]!.isSigner = true;
    expect(inspectStep(web3, t2, 2, input()).join(' ')).toMatch(/unexpected account/);
  });
  it('a larger deposit than was shown', () => {
    const c = config();
    const t = assemble(web3, buildStep1(web3, { config: c, mint: MINT, mintRentLamports: RENT * 50n }), PAYER, 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k', 1);
    expect(inspectStep(web3, t, 1, input(c)).join(' ')).toMatch(/deposit/);
  });
  it('a freeze authority, a different mint authority or different decimals', () => {
    const c = config();
    const t = tx1(c);
    const d = Uint8Array.from(t.instructions[3]!.data);
    const withFreeze = new Uint8Array(67);
    withFreeze.set(d, 0);
    withFreeze[34] = 1;
    withFreeze.set(new web3.PublicKey(OTHER).toBytes(), 35);
    t.instructions[3] = new web3.TransactionInstruction({ programId: t.instructions[3]!.programId, keys: t.instructions[3]!.keys, data: withFreeze as unknown as Buffer });
    expect(inspectStep(web3, t, 1, input(c)).join(' ')).toMatch(/freeze authority/);

    const t2 = tx1(c);
    const dd = Uint8Array.from(t2.instructions[3]!.data);
    dd[1] = 9;
    t2.instructions[3] = new web3.TransactionInstruction({ programId: t2.instructions[3]!.programId, keys: t2.instructions[3]!.keys, data: dd as unknown as Buffer });
    expect(inspectStep(web3, t2, 1, input(c)).join(' ')).toMatch(/settings are not the ones shown/);
  });
  it('a changed name, symbol, link or update authority', () => {
    expect(inspectStep(web3, tx1(config({ name: 'Other name' })), 1, input()).join(' ')).toMatch(/differ from what was shown/);
    // A creation whose authority handling differs from what was shown is refused: not given up when it must be, or given up when it must not.
    expect(inspectStep(web3, tx1(config({ metadataMutable: true })), 1, input()).join(' ')).toMatch(/expected six steps/);
    expect(inspectStep(web3, tx1(), 1, input(config({ metadataMutable: true }))).join(' ')).toMatch(/expected five steps/);
    const noLock = tx1();
    noLock.instructions.pop();
    expect(inspectStep(web3, noLock, 1, input()).join(' ')).toMatch(/expected six steps/);
    // The last step handing the authority to someone else instead of removing it.
    const toSomeone = tx1();
    const last = toSomeone.instructions[5]!;
    const data = Buffer.from(last.data);
    new web3.PublicKey(OTHER).toBytes().forEach((b, i) => (data[8 + i] = b));
    toSomeone.instructions[5] = new web3.TransactionInstruction({ programId: last.programId, keys: last.keys, data });
    expect(inspectStep(web3, toSomeone, 1, input()).join(' ')).toMatch(/Who can change/);
  });
  it('tokens minted to another wallet, in another amount, or too much in total', () => {
    const c = config();
    const swapped = tx2(c);
    // point the first mint at the treasury's account instead of the creator's
    const treasuryAta = ataAddress(web3, TREASURY, MINT, TOKEN_2022_PROGRAM_ID);
    swapped.instructions[1]!.keys[1] = { pubkey: new web3.PublicKey(treasuryAta), isSigner: false, isWritable: true };
    expect(inspectStep(web3, swapped, 2, input(c)).join(' ')).toMatch(/unexpected account/);

    const bigger = tx2(c);
    const data = Uint8Array.from(bigger.instructions[1]!.data);
    new DataView(data.buffer).setBigUint64(1, 10n ** 18n, true);
    bigger.instructions[1] = new web3.TransactionInstruction({ programId: bigger.instructions[1]!.programId, keys: bigger.instructions[1]!.keys, data: data as unknown as Buffer });
    expect(inspectStep(web3, bigger, 2, input(c)).join(' ')).toMatch(/not the one shown/);
  });
  it('a mint authority that is kept, or given to someone', () => {
    const c = config();
    const kept = tx2(c);
    kept.instructions.pop();
    expect(inspectStep(web3, kept, 2, input(c)).length).toBeGreaterThan(0);

    const given = tx2(c);
    const last = given.instructions[given.instructions.length - 1]!;
    const d = new Uint8Array(35);
    d.set([6, 0, 1]);
    d.set(new web3.PublicKey(OTHER).toBytes(), 3);
    given.instructions[given.instructions.length - 1] = new web3.TransactionInstruction({ programId: last.programId, keys: last.keys, data: d as unknown as Buffer });
    expect(inspectStep(web3, given, 2, input(c)).join(' ')).toMatch(/would not be given up/);
  });
  it('an instruction from a program this page does not use', () => {
    const t = tx2();
    t.add(new web3.TransactionInstruction({ programId: new web3.PublicKey(OTHER), keys: [], data: Buffer.from([1]) }));
    expect(inspectStep(web3, t, 2, input()).join(' ')).toMatch(/did not expect/);
  });
});

describe('decodeInstruction', () => {
  it('names what each instruction does, and calls the rest unknown', () => {
    const kinds = [...buildStep1(web3, input()), ...buildStep2(web3, config(), MINT)].map((i) => decodeInstruction(web3, i).kind);
    expect(kinds).toEqual(['transfer', 'create-account', 'metadata-pointer', 'initialize-mint', 'initialize-metadata', 'update-metadata-authority', 'create-token-account', 'mint-to', 'create-token-account', 'mint-to', 'set-authority']);
    const noise = new web3.TransactionInstruction({ programId: new web3.PublicKey(ATA_PROGRAM_ID), keys: [], data: Buffer.from([0]) });
    expect(decodeInstruction(web3, noise).kind).toBe('unknown');
    const sys = web3.SystemProgram.allocate({ accountPubkey: new web3.PublicKey(PAYER), space: 1 });
    expect(decodeInstruction(web3, sys)).toMatchObject({ kind: 'unknown', program: SYSTEM_PROGRAM_ID });
  });
});
