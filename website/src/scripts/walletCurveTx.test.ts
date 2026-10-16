import { createHash } from 'node:crypto';
import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import vectors from './__fixtures__/curveVectors.json';
import { CURVE_ACCOUNT_DISCRIMINATOR, CURVE_FEE_ADDRESS, CURVE_PROGRAM_ID_DEVNET, deriveCurve, type CurveConfig } from './walletCurveCore';
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  assembleCurve,
  buildAbort,
  buildBuy,
  buildCreate,
  buildMigrate,
  buildSell,
  curveAddress,
  inspectAbort,
  inspectBuy,
  inspectCreate,
  inspectMigrate,
  inspectSell,
  meteoraPoolAddress,
  migrateAddresses,
  migratorAddress,
  solVaultAddress,
  tokenVaultAddress,
  type MigrateArgs,
} from './walletCurveTx';

const PROGRAM = CURVE_PROGRAM_ID_DEVNET;
const CREATOR = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const OTHER = '3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg';
const MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const NFT = web3.Keypair.generate().publicKey.toBase58();
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k';
const SOL = 1_000_000_000n;

const config = (over: Partial<CurveConfig> = {}): CurveConfig => ({
  creator: CREATOR,
  mint: MINT,
  decimals: 6,
  totalRaw: 1_000_000_000_000_000n,
  targetLamports: 85n * SOL,
  firstBuyLamports: 0n,
  derived: deriveCurve(1_000_000_000_000_000n, 85n * SOL)!,
  ...over,
});
const MIG: MigrateArgs = { rentBudget: 60_000_000n, liquidity: 123_456_789_012_345_678_901n, sqrtPrice: 98_765_432_109_876_543_210n };

const tx = (ixs: web3.TransactionInstruction[], payer = CREATOR) => {
  // web3's own helper refuses an empty list; the inspector must handle one, so build it by hand.
  const t = new web3.Transaction({ feePayer: new web3.PublicKey(payer), blockhash: BLOCKHASH, lastValidBlockHeight: 1 });
  t.instructions.push(...ixs);
  return t;
};

describe('addresses match the ones the Rust program and Meteora derive', () => {
  it('for every vector', () => {
    for (const a of vectors.addresses) {
      const curve = curveAddress(web3, PROGRAM, a.mint);
      expect(curve).toBe(a.curve);
      expect(solVaultAddress(web3, PROGRAM, curve)).toBe(a.solVault);
      expect(tokenVaultAddress(web3, curve, a.mint)).toBe(a.tokenVault);
      expect(migratorAddress(web3, PROGRAM, curve)).toBe(a.migrator);
      expect(meteoraPoolAddress(web3, a.mint)).toBe(a.pool);
      expect(migrateAddresses(web3, a.mint, a.nft)).toEqual({ pool: a.pool, position: a.position, nftAccount: a.nftAccount, vaultA: a.vaultA, vaultB: a.vaultB });
    }
  });
});

describe('instruction names and the account tag are the Anchor hashes', () => {
  const disc = (s: string) => [...createHash('sha256').update(s).digest().subarray(0, 8)];
  it('matches', () => {
    const data = (ixs: web3.TransactionInstruction[], n: number) => [...ixs[n]!.data.subarray(0, 8)];
    expect(data(buildCreate(web3, PROGRAM, { config: config(), firstBuyMinOut: 0n }), 0)).toEqual(disc('global:create_curve'));
    expect(data(buildBuy(web3, PROGRAM, CREATOR, MINT, SOL, 1n), 1)).toEqual(disc('global:buy'));
    expect(data(buildSell(web3, PROGRAM, CREATOR, MINT, 5n, 1n), 0)).toEqual(disc('global:sell'));
    expect(data(buildMigrate(web3, PROGRAM, CREATOR, MINT, NFT, MIG), 1)).toEqual(disc('global:migrate'));
    expect(data(buildAbort(web3, PROGRAM, CREATOR, MINT), 0)).toEqual(disc('global:abort_migration'));
    expect([...CURVE_ACCOUNT_DISCRIMINATOR]).toEqual(disc('account:Curve'));
  });
});

// Each case: a transaction that must be accepted, how to inspect it, and the signers it needs.
interface Case {
  name: string;
  make(): web3.Transaction;
  inspect(t: web3.Transaction): string[];
}

const cases: Case[] = [
  {
    name: 'create',
    make: () => tx(buildCreate(web3, PROGRAM, { config: config(), firstBuyMinOut: 0n })),
    inspect: (t) => inspectCreate(web3, t, { program: PROGRAM, config: config(), firstBuyMinOut: 0n }),
  },
  {
    name: 'create with a first buy',
    make: () => tx(buildCreate(web3, PROGRAM, { config: config({ firstBuyLamports: 2n * SOL }), firstBuyMinOut: 777n })),
    inspect: (t) => inspectCreate(web3, t, { program: PROGRAM, config: config({ firstBuyLamports: 2n * SOL }), firstBuyMinOut: 777n }),
  },
  {
    name: 'buy',
    make: () => tx(buildBuy(web3, PROGRAM, CREATOR, MINT, 3n * SOL, 123_456n)),
    inspect: (t) => inspectBuy(web3, t, { program: PROGRAM, trader: CREATOR, mint: MINT, amount: 3n * SOL, minOut: 123_456n }),
  },
  {
    name: 'sell',
    make: () => tx(buildSell(web3, PROGRAM, CREATOR, MINT, 5_000_000n, 42n)),
    inspect: (t) => inspectSell(web3, t, { program: PROGRAM, trader: CREATOR, mint: MINT, amount: 5_000_000n, minOut: 42n }),
  },
  {
    name: 'migrate',
    make: () => tx(buildMigrate(web3, PROGRAM, CREATOR, MINT, NFT, MIG)),
    inspect: (t) => inspectMigrate(web3, t, { program: PROGRAM, payer: CREATOR, mint: MINT, nft: NFT, args: MIG }),
  },
  {
    name: 'abort',
    make: () => tx(buildAbort(web3, PROGRAM, CREATOR, MINT)),
    inspect: (t) => inspectAbort(web3, t, { program: PROGRAM, caller: CREATOR, mint: MINT }),
  },
];

const clone = (ix: web3.TransactionInstruction, edit: { keys?: (k: web3.AccountMeta[]) => void; data?: (d: Buffer) => void; programId?: string }) => {
  const keys = ix.keys.map((k) => ({ ...k }));
  const data = Buffer.from(ix.data);
  edit.keys?.(keys);
  edit.data?.(data);
  return new web3.TransactionInstruction({ programId: edit.programId ? new web3.PublicKey(edit.programId) : ix.programId, keys, data });
};
const replaceAt = (t: web3.Transaction, n: number, ix: web3.TransactionInstruction) => {
  return tx(t.instructions.map((x, i) => (i === n ? ix : x)));
};

describe.each(cases)('the $name transaction', (c) => {
  it('is accepted by the inspector', () => {
    expect(c.inspect(c.make())).toEqual([]);
  });

  it('is refused when any account in any instruction is swapped for another', () => {
    const base = c.make();
    let tried = 0;
    base.instructions.forEach((ix, n) => {
      ix.keys.forEach((_, k) => {
        const swapped = clone(ix, { keys: (keys) => (keys[k] = { ...keys[k]!, pubkey: new web3.PublicKey(OTHER) }) });
        // Swapping the payer account changes the fee payer too, which the inspector also refuses.
        const blockers = c.inspect(replaceAt(base, n, swapped));
        tried++;
        expect(blockers.length, `instruction ${n} account ${k}`).toBeGreaterThan(0);
      });
    });
    expect(tried).toBeGreaterThan(0);
  });

  it('is refused when a signer or writable flag is flipped on any account', () => {
    const base = c.make();
    base.instructions.forEach((ix, n) => {
      if (ix.keys.length === 0) return;
      ix.keys.forEach((_, k) => {
        for (const flag of ['isSigner', 'isWritable'] as const) {
          const flipped = clone(ix, { keys: (keys) => (keys[k] = { ...keys[k]!, [flag]: !keys[k]![flag] }) });
          expect(c.inspect(replaceAt(base, n, flipped)).length, `instruction ${n} account ${k} ${flag}`).toBeGreaterThan(0);
        }
      });
    });
  });

  it('is refused when any byte of any instruction’s data changes', () => {
    const base = c.make();
    base.instructions.forEach((ix, n) => {
      for (let b = 0; b < ix.data.length; b++) {
        const mutated = clone(ix, { data: (d) => (d[b] = d[b]! ^ 0x01) });
        expect(c.inspect(replaceAt(base, n, mutated)).length, `instruction ${n} byte ${b}`).toBeGreaterThan(0);
      }
    });
  });

  it('is refused when any instruction is run by another program', () => {
    const base = c.make();
    base.instructions.forEach((ix, n) => {
      const other = clone(ix, { programId: OTHER });
      expect(c.inspect(replaceAt(base, n, other)).length, `instruction ${n}`).toBeGreaterThan(0);
    });
  });

  it('is refused with an extra instruction, a removed one, or another fee payer', () => {
    const base = c.make();
    const withExtra = tx([...base.instructions, web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(CREATOR), toPubkey: new web3.PublicKey(OTHER), lamports: 1n })]);
    expect(c.inspect(withExtra).length).toBeGreaterThan(0);
    const withFirst = tx([web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(CREATOR), toPubkey: new web3.PublicKey(OTHER), lamports: 1n }), ...base.instructions]);
    expect(c.inspect(withFirst).length).toBeGreaterThan(0);
    if (base.instructions.length > 1) expect(c.inspect(tx(base.instructions.slice(1))).length).toBeGreaterThan(0);
    expect(c.inspect(tx([], CREATOR)).length).toBeGreaterThan(0);
    const otherPayer = tx(base.instructions, OTHER);
    expect(c.inspect(otherPayer).length).toBeGreaterThan(0);
  });
});

describe('details worth their own test', () => {
  it('only ever pays the fee to the management-fee wallet', () => {
    const buy = buildBuy(web3, PROGRAM, CREATOR, MINT, SOL, 1n)[1]!;
    const sell = buildSell(web3, PROGRAM, CREATOR, MINT, 5n, 1n)[0]!;
    for (const i of [buy, sell]) expect(i.keys[6]!.pubkey.toBase58()).toBe(CURVE_FEE_ADDRESS);
  });

  it('needs only the wallet to sign for a buy, a sell and a create; the wallet and the position key for a migration', () => {
    const signers = (t: web3.Transaction) => [...new Set(t.instructions.flatMap((i) => i.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())))].sort();
    expect(signers(cases[0]!.make())).toEqual([CREATOR]);
    expect(signers(cases[2]!.make())).toEqual([CREATOR]);
    expect(signers(cases[3]!.make())).toEqual([CREATOR]);
    expect(signers(cases[4]!.make())).toEqual([CREATOR, NFT].sort());
  });

  it('refuses a migration whose rent budget, size or price differs from what was worked out', () => {
    const t = cases[4]!.make();
    for (const args of [{ ...MIG, rentBudget: 1n }, { ...MIG, liquidity: MIG.liquidity + 1n }, { ...MIG, sqrtPrice: MIG.sqrtPrice - 1n }]) {
      expect(inspectMigrate(web3, t, { program: PROGRAM, payer: CREATOR, mint: MINT, nft: NFT, args }).length).toBeGreaterThan(0);
    }
  });

  it('refuses a migration whose position key is not the one that signs', () => {
    const t = cases[4]!.make();
    expect(inspectMigrate(web3, t, { program: PROGRAM, payer: CREATOR, mint: MINT, nft: OTHER, args: MIG }).length).toBeGreaterThan(0);
  });

  it('refuses a migration whose compute limit is not the one asked for, or is not a compute limit at all', () => {
    const base = cases[4]!.make();
    const high = Buffer.alloc(5);
    high[0] = 2;
    high.writeUInt32LE(1_400_001, 1);
    const bad = replaceAt(base, 0, new web3.TransactionInstruction({ programId: new web3.PublicKey(COMPUTE_BUDGET_PROGRAM_ID), keys: [], data: high }));
    expect(inspectMigrate(web3, bad, { program: PROGRAM, payer: CREATOR, mint: MINT, nft: NFT, args: MIG }).join(' ')).toMatch(/compute limit/);
    const price = Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]);
    const bad2 = replaceAt(base, 0, new web3.TransactionInstruction({ programId: new web3.PublicKey(COMPUTE_BUDGET_PROGRAM_ID), keys: [], data: price }));
    expect(inspectMigrate(web3, bad2, { program: PROGRAM, payer: CREATOR, mint: MINT, nft: NFT, args: MIG }).join(' ')).toMatch(/compute limit/);
  });

  it('fits in one transaction packet when signed', () => {
    for (const c of cases) {
      const t = assembleCurve(web3, c.make().instructions, CREATOR, BLOCKHASH, 1);
      // Serialised size is what counts, signatures included (two for a migration).
      const size = t.serialize({ requireAllSignatures: false, verifySignatures: false }).length + 64 * (c.name === 'migrate' ? 2 : 1);
      expect(size, c.name).toBeLessThanOrEqual(1232);
    }
  });

  it('refuses to build with a number that does not fit', () => {
    expect(() => buildBuy(web3, PROGRAM, CREATOR, MINT, 1n << 64n, 0n)).toThrow(/64 bits/);
    expect(() => buildMigrate(web3, PROGRAM, CREATOR, MINT, NFT, { ...MIG, liquidity: 1n << 128n })).toThrow(/128 bits/);
  });
});
