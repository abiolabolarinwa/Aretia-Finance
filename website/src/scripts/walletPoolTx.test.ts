import * as web3 from '@solana/web3.js';
import * as sdk from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { describe, expect, it } from 'vitest';
import { LAUNCH_FEE_ADDRESS } from './walletLaunchCore';
import { LAUNCH_PROTECTION_MINUTES, LAUNCH_PROTECTION_START_BPS, POOL_TRADING_FEES_BPS, poolDisclosures, protectionSchedule, POOL_FEE_ADDRESS, POOL_FEE_LAMPORTS, WSOL_MINT, type PoolConfig } from './walletPoolCore';
import { assemblePool, buildPool, expectedBaseFee, expectedSqrtPrice, impliedTokenAmount, inspectPool, isqrt, poolMath, tokenBadge, type PoolLibs } from './walletPoolTx';

const CREATOR = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const OTHER = '3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg';
const MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const NFT = web3.Keypair.generate().publicKey.toBase58();
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k';
const other = new web3.PublicKey(OTHER);

const libs: PoolLibs = { sdk, BN, cpAmm: new sdk.CpAmm(new web3.Connection('http://127.0.0.1:1')) };
const config = (over: Partial<PoolConfig> = {}): PoolConfig => ({
  creator: CREATOR,
  mint: MINT,
  decimals: 6,
  tokenAmountRaw: 900_000_000n * 10n ** 6n,
  price: '0.000001',
  tradingFeeBps: 25,
  lockLiquidity: true,
  ...over,
});

async function built(c = config()) {
  const b = await buildPool(web3, libs, c, NFT);
  const tx = assemblePool(web3, b.instructions, c.creator, BLOCKHASH, 1);
  return { b, tx, input: { config: c, nft: NFT, pool: b.pool, math: b.math } };
}
type Built = Awaited<ReturnType<typeof built>>;

/** Applies a change to the built transaction and returns what the inspector says about it. */
async function after(change: (tx: web3.Transaction, x: Built) => void, c = config()): Promise<string> {
  const x = await built(c);
  change(x.tx, x);
  return inspectPool(web3, x.tx, x.input).join(' ');
}
const withKey = (ix: web3.TransactionInstruction, i: number, pubkey: web3.PublicKey) => {
  const keys = ix.keys.slice();
  keys[i] = { ...keys[i]!, pubkey };
  return new web3.TransactionInstruction({ programId: ix.programId, keys, data: ix.data });
};
const withData = (ix: web3.TransactionInstruction, edit: (d: Buffer) => void) => {
  const d = Buffer.from(ix.data);
  edit(d);
  return new web3.TransactionInstruction({ programId: ix.programId, keys: ix.keys, data: d });
};

describe('the pool transaction', () => {
  it('is the Aretia fee, the creator’s accounts, the pool and the lock, and the inspector accepts it', async () => {
    for (const c of [config(), config({ lockLiquidity: false }), config({ tradingFeeBps: 100, price: '0.5' })]) {
      const { b, tx, input } = await built(c);
      expect(b.instructions).toHaveLength(c.lockLiquidity ? 7 : 6);
      expect(inspectPool(web3, tx, input)).toEqual([]);
    }
  });
  it('charges 0.05 SOL to the management-fee wallet, first', async () => {
    const { b } = await built();
    expect(b.instructions[0]!.keys.map((k) => k.pubkey.toBase58())).toEqual([CREATOR, POOL_FEE_ADDRESS]);
    expect(POOL_FEE_ADDRESS).toBe(LAUNCH_FEE_ADDRESS);
    expect(POOL_FEE_LAMPORTS).toBe(50_000_000n);
  });
  it('needs the position key and the wallet to sign, and nothing else', async () => {
    const { tx } = await built();
    const signers = new Set(tx.instructions.flatMap((i) => i.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())));
    expect([...signers].sort()).toEqual([CREATOR, NFT].sort());
  });
  it('derives the token badges the same way the SDK does', async () => {
    const { b } = await built();
    expect(b.instructions[5]!.keys[19]!.pubkey.toBase58()).toBe(tokenBadge(web3, MINT));
    expect(b.instructions[5]!.keys[20]!.pubkey.toBase58()).toBe(tokenBadge(web3, WSOL_MINT));
  });
  it('sizes the pool from the price: the same tokens at a higher start price are more liquidity', () => {
    const low = poolMath(web3, libs, config({ price: '0.000001' }));
    const high = poolMath(web3, libs, config({ price: '0.001' }));
    expect(high.liquidity.gt(low.liquidity)).toBe(true);
    expect(low.liquidity.gtn(0)).toBe(true);
    expect(low.baseFee).toHaveLength(27);
  });
});

describe('inspectPool refuses anything else', () => {
  it('a different fee amount or recipient', async () => {
    const fee = (to: web3.PublicKey, lamports: bigint) => (t: web3.Transaction) => {
      t.instructions[0] = web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(CREATOR), toPubkey: to, lamports });
    };
    expect(await after(fee(new web3.PublicKey(POOL_FEE_ADDRESS), POOL_FEE_LAMPORTS + 1n))).toMatch(/fee is not the amount/);
    expect(await after(fee(other, POOL_FEE_LAMPORTS))).toMatch(/fee would go to an account/);
  });
  it('an extra transfer, or a missing step', async () => {
    const theft = web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(CREATOR), toPubkey: other, lamports: 1_000_000_000 });
    expect(await after((t) => void t.add(theft))).toMatch(/not the expected set of steps/);
    expect(await after((t) => void t.instructions.shift())).toMatch(/not the expected set of steps/);
  });
  it('a different fee payer, or an unexpected signer', async () => {
    expect(await after((t) => void (t.feePayer = other))).toMatch(/fee would be paid/);
    expect(await after((t) => void t.instructions[0]!.keys.push({ pubkey: other, isSigner: true, isWritable: false }))).toMatch(/unexpected account would have to sign/);
  });
  it('tokens or SOL taken from an account that is not the creator’s', async () => {
    expect(await after((t) => void (t.instructions[5] = withKey(t.instructions[5]!, 11, other)))).toMatch(/source of the tokens/);
    expect(await after((t) => void (t.instructions[3] = withKey(t.instructions[3]!, 1, other)))).toMatch(/wrapped-SOL step would send/);
  });
  it('a different pool address, token, or program', async () => {
    expect(await after((t) => void (t.instructions[5] = withKey(t.instructions[5]!, 5, other)))).toMatch(/for the pool/);
    expect(await after((t) => void (t.instructions[5] = withKey(t.instructions[5]!, 7, other)))).toMatch(/for the token/);
    expect(await after((t) => void (t.instructions[5] = new web3.TransactionInstruction({ programId: other, keys: t.instructions[5]!.keys, data: t.instructions[5]!.data })))).toMatch(/not made by the pool program/);
  });
  it('a different price, amount, fee, alpha vault or opening time', async () => {
    const edit = (f: (d: Buffer) => void) => (t: web3.Transaction) => void (t.instructions[5] = withData(t.instructions[5]!, f));
    expect(await after(edit((d) => void (d[39]! ^= 1)))).toMatch(/starting price/);
    expect(await after(edit((d) => void (d[72]! ^= 1)))).toMatch(/amount going into the pool/);
    expect(await after(edit((d) => void (d[8]! ^= 1)))).toMatch(/trading fee/);
    expect(await after(edit((d) => void (d[71] = 1)))).toMatch(/alpha vault/);
    expect(await after(edit((d) => void (d[106] = 1)))).toMatch(/set time/);
  });
  it('a lock of a different amount, or about a different position', async () => {
    expect(await after((t) => void (t.instructions[6] = withData(t.instructions[6]!, (d) => void (d[8]! ^= 1))))).toMatch(/amount being locked/);
    expect(await after((t) => void (t.instructions[6] = withKey(t.instructions[6]!, 1, other)))).toMatch(/different pool or position/);
  });
  it('a lock that is missing when it was asked for, or present when it was not', async () => {
    expect(await after((t) => void t.instructions.pop())).toMatch(/not the expected set of steps/);
    const x = await built(config({ lockLiquidity: false }));
    x.tx.add((await built()).tx.instructions[6]!);
    expect(inspectPool(web3, x.tx, x.input).join(' ')).toMatch(/not the expected set of steps/);
  });
});

describe('launch protection', () => {
  const protectedConfig = (minutes: number, tradingFeeBps: number) => config({ tradingFeeBps, launchProtection: { startBps: LAUNCH_PROTECTION_START_BPS, minutes } });

  it('writes the same 27 bytes as the real SDK, for every fee and window, and the by-hand encoder agrees', () => {
    for (const fee of POOL_TRADING_FEES_BPS) {
      for (const minutes of LAUNCH_PROTECTION_MINUTES) {
        const c = protectedConfig(minutes, fee);
        const sdkBytes = poolMath(web3, libs, c).baseFee;
        expect(sdkBytes).toHaveLength(27);
        expect(Array.from(expectedBaseFee(c))).toEqual(Array.from(sdkBytes));
        // And it differs from the flat block.
        expect(Array.from(sdkBytes)).not.toEqual(Array.from(poolMath(web3, libs, config({ tradingFeeBps: fee })).baseFee));
      }
    }
    // The flat block is still what it was.
    expect(Array.from(expectedBaseFee(config()))).toEqual(Array.from(poolMath(web3, libs, config()).baseFee));
  });
  it('starts at 5%, falls in a straight line, and ends exactly on the creator’s fee', () => {
    for (const fee of POOL_TRADING_FEES_BPS) {
      for (const minutes of LAUNCH_PROTECTION_MINUTES) {
        const s = protectionSchedule(fee, { startBps: LAUNCH_PROTECTION_START_BPS, minutes });
        expect(s.cliff).toBe(50_000_000n);
        expect(s.frequency * BigInt(s.periods)).toBe(BigInt(minutes * 60));
        expect(s.cliff - s.reduction * BigInt(s.periods)).toBe(BigInt(fee) * 100_000n);
        // Read through the SDK's own fee-over-time function.
        const at = (period: number) => sdk.getFeeTimeBaseFeeNumeratorByPeriod(new BN(s.cliff.toString()), s.periods, new BN(period), new BN(s.reduction.toString()), sdk.BaseFeeMode.FeeTimeSchedulerLinear).toString();
        expect(at(0)).toBe('50000000');
        expect(at(s.periods)).toBe((BigInt(fee) * 100_000n).toString());
        expect(BigInt(at(s.periods / 2))).toBe((s.cliff + BigInt(fee) * 100_000n) / 2n);
        expect(sdk.validateFeeTimeScheduler(s.periods, new BN(s.frequency.toString()), new BN(s.reduction.toString()), new BN(s.cliff.toString()), sdk.BaseFeeMode.FeeTimeSchedulerLinear, 1)).toBe(true);
      }
    }
    expect(LAUNCH_PROTECTION_START_BPS).toBeLessThanOrEqual(sdk.MAX_FEE_BPS_V1);
  });
  it('the inspector accepts the scheduled pool and refuses a flat block, a different window or a different start', async () => {
    for (const minutes of LAUNCH_PROTECTION_MINUTES) {
      const c = protectedConfig(minutes, 25);
      const { tx, input } = await built(c);
      expect(inspectPool(web3, tx, input)).toEqual([]);
    }
    const c = protectedConfig(30, 25);
    const edit = (f: (d: Buffer) => void) => (t: web3.Transaction) => void (t.instructions[5] = withData(t.instructions[5]!, f));
    expect(await after(edit((d) => void d.set(Buffer.from(poolMath(web3, libs, config()).baseFee), 8)), c)).toMatch(/launch-protection schedule/);
    expect(await after(edit((d) => void (d[10]! ^= 1)), c)).toMatch(/launch-protection schedule/);
    expect(await after(edit((d) => void (d[0 + 8]! ^= 1)), c)).toMatch(/launch-protection schedule/);
    // A pool built flat is refused when protection was shown.
    const x = await built(config());
    expect(inspectPool(web3, x.tx, { ...x.input, config: c }).join(' ')).toMatch(/launch-protection schedule/);
  });
  it('says plainly what it does and what it costs the first buyers', () => {
    const on = poolDisclosures(protectedConfig(30, 25)).map((d) => d.text).join(' ');
    expect(on).toMatch(/starts at 5% and falls in a straight line to 0.25%/);
    expect(on).toMatch(/first buyers pay more/);
    expect(poolDisclosures(config()).map((d) => d.text).join(' ')).toMatch(/Launch protection is off/);
  });
});

describe('L-25: the inspector does not take the SDK\'s word for price, liquidity or pool address', () => {
  /** A copy of the SDK with one helper replaced, as a faulty or tampered release would behave. */
  const faulty = (over: Partial<typeof sdk>): PoolLibs => ({ ...libs, sdk: { ...sdk, ...over } as typeof sdk });

  it('the integer price maths agrees with the SDK to within rounding, across decimals and prices', () => {
    for (const [price, decimals] of [['0.000001', 6], ['0.5', 9], ['123456789.123456789012', 0], ['0.000000000001', 12]] as const) {
      const mine = expectedSqrtPrice(price, decimals)!;
      const theirs = BigInt(sdk.getSqrtPriceFromPrice(price, decimals, 9).toString());
      expect(mine > theirs ? mine - theirs : theirs - mine).toBeLessThanOrEqual(2n + mine / 10n ** 12n);
    }
    expect(isqrt(10n ** 40n)).toBe(10n ** 20n);
    expect(isqrt(2n ** 128n - 1n)).toBe(2n ** 64n - 1n);
    expect(expectedSqrtPrice('1e-6', 6)).toBeNull();
    expect(impliedTokenAmount(1n, 0n, 1n)).toBeNull();
  });

  it('an SDK that computes the wrong starting price (both in the transaction and in its own maths) is caught', async () => {
    const bad = faulty({ getSqrtPriceFromPrice: ((p: string, a: number, b: number) => sdk.getSqrtPriceFromPrice(p, a, b).muln(2)) as typeof sdk.getSqrtPriceFromPrice });
    const c = config();
    const b = await buildPool(web3, bad, c, NFT);
    const tx = assemblePool(web3, b.instructions, c.creator, BLOCKHASH, 1);
    expect(inspectPool(web3, tx, { config: c, nft: NFT, pool: b.pool, math: b.math }).join(' ')).toMatch(/does not work out to the price you entered/);
  });

  it('liquidity that would take more tokens than shown, or far fewer, is caught even when the builder\'s maths agrees', async () => {
    for (const scale of [(x: BN) => x.muln(2), (x: BN) => x.divn(2)]) {
      const x = await built();
      const more = scale(x.b.math.liquidity);
      const bytes = more.toArrayLike(Buffer, 'le', 16);
      x.tx.instructions[5] = withData(x.tx.instructions[5]!, (d) => bytes.copy(d, 72));
      x.tx.instructions[6] = withData(x.tx.instructions[6]!, (d) => bytes.copy(d, 8));
      expect(inspectPool(web3, x.tx, { ...x.input, math: { ...x.input.math, liquidity: more } }).join(' ')).toMatch(/liquidity does not match the amount of tokens/);
    }
  });

  it('a pool address that is not the one derived from the two tokens is caught, even if the screen was shown the same one', async () => {
    const x = await built();
    x.tx.instructions[5] = withKey(x.tx.instructions[5]!, 5, other);
    expect(inspectPool(web3, x.tx, { ...x.input, pool: OTHER }).join(' ')).toMatch(/not the one fixed by the two tokens/);
  });
});
