import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import mints from './__fixtures__/launchMints.json';
import {
  CURVE_ABORT_AFTER_SECS,
  CURVE_ACCOUNT_DISCRIMINATOR,
  CURVE_ACCOUNT_SIZE,
  CURVE_PROGRAM_ID_DEVNET,
  DEFAULT_CURVE_FORM,
  deriveCurve,
  quoteBuy,
  startOf,
  validateCurve,
  type CurveConfig,
  type CurveState,
  type CurveStatus,
} from './walletCurveCore';
import { CurveFlow, type CurveFlowDeps, type CurveProgress } from './walletCurveFlow';
import { curveAddress, tokenVaultAddress } from './walletCurveTx';
import { LaunchError } from './walletLaunchFlow';
import { METEORA_PROGRAM_ID } from './walletPoolTx';
import { TOKEN_2022_PROGRAM_ID, ataAddress } from './walletTools';

const PROGRAM = CURVE_PROGRAM_ID_DEVNET;
const CREATOR = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const BUYER = '3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg';
const MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const SOL = 1_000_000_000n;
const TOTAL = 900_000_000_000_000n;

const finalMint = (): Uint8Array => Uint8Array.from(Buffer.from((mints as Record<string, string[]>).final!.join(''), 'hex'));
const tokenAccount = (amount: bigint): Uint8Array => {
  const data = new Uint8Array(170);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = 1;
  return data;
};

const STATUS: Record<CurveStatus, number> = { trading: 0, soldOut: 1, migrated: 2, aborted: 3 };
/** The bytes of a curve account, laid out exactly as the program writes them. */
function curveBytes(c: Pick<CurveState, 'status' | 'vSol' | 'vTok' | 'realSol' | 'realTok' | 'soldOutAt'> & { target: bigint; vSol0: bigint; curveTokens: bigint; lpTokens: bigint; creator?: string; mint?: string; feeBps?: number; pool?: string }): Uint8Array {
  const data = new Uint8Array(CURVE_ACCOUNT_SIZE);
  data.set(CURVE_ACCOUNT_DISCRIMINATOR, 0);
  const v = new DataView(data.buffer);
  let at = 8;
  data[at++] = 255;
  data[at++] = 254;
  data[at++] = STATUS[c.status];
  data.set(new web3.PublicKey(c.creator ?? CREATOR).toBytes(), at);
  at += 32;
  data.set(new web3.PublicKey(c.mint ?? MINT).toBytes(), at);
  at += 32;
  v.setUint16(at, c.feeBps ?? 100, true);
  at += 2;
  for (const x of [c.target, c.vSol0, c.curveTokens, c.lpTokens, c.vSol, c.vTok, c.realSol, c.realTok]) {
    v.setBigUint64(at, x, true);
    at += 8;
  }
  v.setBigInt64(at, 1_700_000_000n, true);
  at += 8;
  v.setBigInt64(at, c.soldOutAt, true);
  at += 8;
  if (c.pool) data.set(new web3.PublicKey(c.pool).toBytes(), at);
  return data;
}

const derived = deriveCurve(TOTAL, 85n * SOL)!;
const fresh = () => ({ ...startOf(derived), status: 'trading' as CurveStatus, target: 85n * SOL, vSol0: derived.vSol0, curveTokens: derived.curveTokens, lpTokens: derived.lpTokens, soldOutAt: 0n });

interface World {
  deps: CurveFlowDeps;
  accounts: Map<string, { owner: string; data: Uint8Array; lamports?: bigint }>;
  sent: web3.Transaction[];
  now: number;
  script: {
    simulate?: { ok: boolean; error: string | null; lamportsAfter: bigint | null };
    reject?: boolean;
    confirm?: 'confirmed' | 'failed' | 'pending';
    balance?: bigint;
    /** What happens to the world when a transaction is sent. */
    onSend?: (tx: web3.Transaction, w: World) => void;
    spent?: bigint;
  };
}

function world(): World {
  const accounts: World['accounts'] = new Map();
  accounts.set(MINT, { owner: TOKEN_2022_PROGRAM_ID, data: finalMint() });
  accounts.set(ataAddress(web3, CREATOR, MINT, TOKEN_2022_PROGRAM_ID), { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(TOTAL) });
  const w = { accounts, sent: [], now: 1_700_000_000, script: {} } as unknown as World;
  w.deps = {
    web3,
    program: PROGRAM,
    balanceOf: async () => w.script.balance ?? 1_000n * SOL,
    latestBlockhash: async () => ({ blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k', lastValidBlockHeight: 1 }),
    fetchAccount: async (address) => w.accounts.get(address) ?? null,
    simulate: async () => w.script.simulate ?? { ok: true, error: null, lamportsAfter: (w.script.balance ?? 1_000n * SOL) - (w.script.spent ?? 12_000_000n) },
    signAndSubmit: async (tx, signers) => {
      if (w.script.reject) throw new Error('User rejected the request.');
      for (const s of signers) tx.partialSign(s);
      w.sent.push(tx);
      w.script.onSend?.(tx, w);
      return 'sig1';
    },
    confirm: async () => w.script.confirm ?? 'confirmed',
    nowSecs: () => w.now,
    sleep: async () => undefined,
  };
  return w;
}

async function createSetup(w = world(), form: Partial<typeof DEFAULT_CURVE_FORM> = {}) {
  const flow = new CurveFlow(w.deps);
  const token = (await flow.loadToken(CREATOR, MINT))!;
  const v = validateCurve({ ...DEFAULT_CURVE_FORM, mint: MINT, tokenAmount: '900,000,000', target: '85', ...form }, CREATOR, token);
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  return { w, flow, token, config: v.config as CurveConfig };
}

/** What the chain shows after a successful create: the curve, and the vault holding the tokens less the creator's first buy. */
function afterCreate(w: World, config: CurveConfig, bought = 0n): void {
  const curve = curveAddress(web3, PROGRAM, config.mint);
  const start = startOf(config.derived);
  const q = bought > 0n ? quoteBuy(start, config.firstBuyLamports, 100)! : null;
  const s = q ? q.next : start;
  w.accounts.set(curve, { owner: PROGRAM, data: curveBytes({ ...fresh(), ...s, status: 'trading' }) });
  w.accounts.set(tokenVaultAddress(web3, curve, config.mint), { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(config.totalRaw - bought) });
}

describe('loadToken and loadCurve', () => {
  it('reads a fixed-supply token and the holder’s balance of it', async () => {
    const { token } = await createSetup();
    expect(token).toMatchObject({ mint: MINT, mintAuthority: null, freezeAuthority: null, held: TOTAL });
  });
  it('returns null for something that is not a token, or not a curve', async () => {
    const w = world();
    const flow = new CurveFlow(w.deps);
    expect(await flow.loadToken(CREATOR, BUYER)).toBeNull();
    expect(await flow.loadCurve(MINT)).toBeNull();
    w.accounts.set(curveAddress(web3, PROGRAM, MINT), { owner: PROGRAM, data: new Uint8Array(10) });
    expect(await flow.loadCurve(MINT)).toBeNull();
    // A curve account that names a different token is not this token's curve.
    w.accounts.set(curveAddress(web3, PROGRAM, MINT), { owner: PROGRAM, data: curveBytes({ ...fresh(), mint: BUYER }) });
    expect(await flow.loadCurve(MINT)).toBeNull();
  });
});

describe('create', () => {
  it('builds, checks, signs, sends and reads the curve back', async () => {
    const { w, flow, config } = await createSetup();
    const review = await flow.prepareCreate(config, (await flow.loadToken(CREATOR, MINT))!);
    expect(review.blockers).toEqual([]);
    expect(review.network).toBe(12_000_000n);
    w.script.onSend = () => afterCreate(w, config);
    const seen: CurveProgress[] = [];
    const out = await flow.create(review, (p) => seen.push(p));
    expect(out.differences).toEqual([]);
    expect(out.curve).toBe(curveAddress(web3, PROGRAM, MINT));
    expect(seen).toEqual(['checking', 'signing', 'confirming', 'verifying', 'done']);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.instructions).toHaveLength(1);
  });

  it('puts the creator’s own first buy in the same transaction and counts it as the trade, not a cost', async () => {
    const { w, flow, config, token } = await createSetup(world(), { firstBuy: '2' });
    w.script.spent = 2n * SOL + 13_000_000n;
    const review = await flow.prepareCreate(config, token);
    expect(review.blockers).toEqual([]);
    expect(review.firstBuy!.gross).toBe(2n * SOL);
    expect(review.network).toBe(13_000_000n + (2n * SOL - review.firstBuy!.gross));
    expect(review.instructions).toHaveLength(2);
    w.script.onSend = () => afterCreate(w, config, review.firstBuy!.tokensOut);
    const out = await flow.create(review);
    expect(out.differences).toEqual([]);
  });

  it('says what differs when the network shows something other than what was approved', async () => {
    const { w, flow, config, token } = await createSetup();
    const review = await flow.prepareCreate(config, token);
    w.script.onSend = () => {
      afterCreate(w, config);
      const curve = curveAddress(web3, PROGRAM, MINT);
      w.accounts.set(tokenVaultAddress(web3, curve, MINT), { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(config.totalRaw - 1n) });
      w.accounts.set(curve, { owner: PROGRAM, data: curveBytes({ ...fresh(), creator: BUYER, target: 1n }) });
    };
    const out = await flow.create(review);
    expect(out.differences.join(' ')).toMatch(/different creator/);
    expect(out.differences.join(' ')).toMatch(/raise target/);
    expect(out.differences.join(' ')).toMatch(/token vault/);
  });

  it('blocks a token someone can still add to, a token that already has a curve, and a wallet that is too poor', async () => {
    const { w, flow, config, token } = await createSetup();
    expect((await flow.prepareCreate(config, { ...token, mintAuthority: BUYER })).blockers.join(' ')).toMatch(/create more/);
    w.script.balance = 5_000_000n;
    w.script.simulate = { ok: true, error: null, lamportsAfter: 0n };
    expect((await flow.prepareCreate(config, token)).blockers.join(' ')).toMatch(/does not hold enough SOL/);
    const w2 = world();
    w2.accounts.set(curveAddress(web3, PROGRAM, MINT), { owner: PROGRAM, data: curveBytes(fresh()) });
    const f2 = new CurveFlow(w2.deps);
    expect((await f2.prepareCreate(config, token)).blockers.join(' ')).toMatch(/already exists/);
  });

  it('blocks when the trial run fails, and says why in words', async () => {
    const { w, flow, config, token } = await createSetup();
    w.script.simulate = { ok: false, error: 'InstructionError [0,{"Custom":6000}]', lamportsAfter: null };
    const review = await flow.prepareCreate(config, token);
    expect(review.blockers.join(' ')).toMatch(/not one a curve accepts/);
    await expect(flow.create(review)).rejects.toBeInstanceOf(LaunchError);
    expect(w.sent).toHaveLength(0);
  });

  it('will not sign a transaction that is not the one reviewed', async () => {
    const { w, flow, config, token } = await createSetup();
    const review = await flow.prepareCreate(config, token);
    // Someone swaps the fee-less create for one that also sends SOL away.
    review.instructions.push(web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(CREATOR), toPubkey: new web3.PublicKey(BUYER), lamports: 1_000_000_000n }));
    await expect(flow.create(review)).rejects.toThrow(/Not signing/);
    expect(w.sent).toHaveLength(0);
  });

  it('turns a closed wallet, a failed send and a slow confirmation into plain messages', async () => {
    const { w, flow, config, token } = await createSetup();
    const review = await flow.prepareCreate(config, token);
    w.script.reject = true;
    await expect(flow.create(review)).rejects.toMatchObject({ nothingSent: true, message: expect.stringMatching(/closed the wallet/) });
    w.script.reject = false;
    w.script.confirm = 'failed';
    await expect(flow.create(review)).rejects.toThrow(/Nothing from it took effect/);
    w.script.confirm = 'pending';
    await expect(flow.create(review)).rejects.toThrow(/has not confirmed yet/);
  });

  it('refuses a review that already has blockers', async () => {
    const { flow, config, token } = await createSetup();
    const review = await flow.prepareCreate(config, { ...token, freezeAuthority: BUYER });
    await expect(flow.create(review)).rejects.toMatchObject({ nothingSent: true });
  });
});

function tradingWorld(state = fresh()) {
  const w = world();
  w.accounts.set(curveAddress(web3, PROGRAM, MINT), { owner: PROGRAM, data: curveBytes(state) });
  w.accounts.set(ataAddress(web3, BUYER, MINT, TOKEN_2022_PROGRAM_ID), { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(0n) });
  return w;
}

describe('buy', () => {
  it('quotes from the chain’s state, asks for the least it would accept, and checks the wallet afterwards', async () => {
    const w = tradingWorld();
    const flow = new CurveFlow(w.deps);
    const curve = (await flow.loadCurve(MINT))!;
    w.script.spent = 5n * SOL + 3_000_000n;
    const review = await flow.prepareBuy(BUYER, curve, 5n * SOL, 100);
    expect(review.blockers).toEqual([]);
    expect(review.quote!.fee).toBe(50_000_000n);
    expect(review.minOut).toBe((review.quote!.tokensOut * 9_900n) / 10_000n);
    expect(review.network).toBe(3_000_000n);
    w.script.onSend = () => w.accounts.set(ataAddress(web3, BUYER, MINT, TOKEN_2022_PROGRAM_ID), { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(review.quote!.tokensOut) });
    const out = await flow.buy(review);
    expect(out.differences).toEqual([]);
    expect(out.tokensAfter).toBe(review.quote!.tokensOut);
    expect(w.sent[0]!.instructions).toHaveLength(2);
  });

  it('reports a wallet that holds less than the least it accepted', async () => {
    const w = tradingWorld();
    const flow = new CurveFlow(w.deps);
    const review = await flow.prepareBuy(BUYER, (await flow.loadCurve(MINT))!, SOL);
    const out = await flow.buy(review);
    expect(out.differences.join(' ')).toMatch(/fewer tokens/);
  });

  it('blocks dust, a closed curve, a curve whose books do not add up, and one that charges another fee', async () => {
    const w = tradingWorld();
    const flow = new CurveFlow(w.deps);
    const curve = (await flow.loadCurve(MINT))!;
    expect((await flow.prepareBuy(BUYER, curve, 1n)).blockers.join(' ')).toMatch(/too small/);
    expect((await flow.prepareBuy(BUYER, { ...curve, status: 'soldOut' }, SOL)).blockers.join(' ')).toMatch(/not open for buying/);
    expect((await flow.prepareBuy(BUYER, { ...curve, vSol: curve.vSol + 1n }, SOL)).blockers.join(' ')).toMatch(/reserves/);
    expect((await flow.prepareBuy(BUYER, { ...curve, feeBps: 900 }, SOL)).blockers.join(' ')).toMatch(/charges 9%/);
    w.script.balance = SOL / 2n;
    w.script.simulate = { ok: true, error: null, lamportsAfter: 0n };
    expect((await flow.prepareBuy(BUYER, curve, SOL)).blockers.join(' ')).toMatch(/does not hold enough SOL/);
  });

  it('will not sign when the reviewed amount and the built one differ', async () => {
    const w = tradingWorld();
    const flow = new CurveFlow(w.deps);
    const review = await flow.prepareBuy(BUYER, (await flow.loadCurve(MINT))!, SOL);
    review.offered = 2n * SOL;
    await expect(flow.buy(review)).rejects.toThrow(/Not signing/);
  });
});

describe('sell', () => {
  it('quotes, sends, and checks the wallet’s tokens afterwards', async () => {
    const w = tradingWorld({ ...fresh(), ...quoteBuy(startOf(derived), 20n * SOL, 100)!.next });
    w.accounts.set(ataAddress(web3, BUYER, MINT, TOKEN_2022_PROGRAM_ID), { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(1_000_000_000n) });
    const flow = new CurveFlow(w.deps);
    const curve = (await flow.loadCurve(MINT))!;
    w.script.spent = 5_000n;
    const review = await flow.prepareSell(BUYER, curve, 1_000_000_000n);
    expect(review.blockers).toEqual([]);
    expect(review.quote!.net).toBeGreaterThan(0n);
    expect(review.minOut).toBe((review.quote!.net * 9_900n) / 10_000n);
    w.script.onSend = () => w.accounts.set(ataAddress(web3, BUYER, MINT, TOKEN_2022_PROGRAM_ID), { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(0n) });
    const out = await flow.sell(review);
    expect(out.differences).toEqual([]);
    expect(out.tokensAfter).toBe(0n);
  });

  it('blocks selling more than is held, selling to a curve that is closed, and selling more than was ever sold', async () => {
    const w = tradingWorld({ ...fresh(), ...quoteBuy(startOf(derived), 20n * SOL, 100)!.next });
    w.accounts.set(ataAddress(web3, BUYER, MINT, TOKEN_2022_PROGRAM_ID), { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(1_000n) });
    const flow = new CurveFlow(w.deps);
    const curve = (await flow.loadCurve(MINT))!;
    expect((await flow.prepareSell(BUYER, curve, 2_000n)).blockers.join(' ')).toMatch(/More than your wallet holds/);
    expect((await flow.prepareSell(BUYER, { ...curve, status: 'soldOut' }, 500n)).blockers.join(' ')).toMatch(/not open for selling/);
    expect((await flow.prepareSell(BUYER, { ...curve, status: 'migrated' }, 500n)).blockers.join(' ')).toMatch(/not open for selling/);
    const wide = tradingWorld(fresh());
    wide.accounts.set(ataAddress(web3, BUYER, MINT, TOKEN_2022_PROGRAM_ID), { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(1_000_000n) });
    const f2 = new CurveFlow(wide.deps);
    expect((await f2.prepareSell(BUYER, (await f2.loadCurve(MINT))!, 1_000n)).blockers.join(' ')).toMatch(/cannot be sold back/);
  });

  it('allows selling to an unwound curve', async () => {
    const sold = quoteBuy(startOf(derived), 1_000n * SOL, 100)!.next;
    const w = tradingWorld({ ...fresh(), ...sold, status: 'aborted', soldOutAt: 1_000n });
    w.accounts.set(ataAddress(web3, BUYER, MINT, TOKEN_2022_PROGRAM_ID), { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(1_000_000_000n) });
    const flow = new CurveFlow(w.deps);
    const r = await flow.prepareSell(BUYER, (await flow.loadCurve(MINT))!, 1_000_000_000n);
    expect(r.blockers).toEqual([]);
  });
});

describe('graduation', () => {
  const soldOutState = () => {
    const q = quoteBuy(startOf(derived), 1_000n * SOL, 100)!;
    return { ...fresh(), ...q.next, status: 'soldOut' as CurveStatus, soldOutAt: 1_700_000_100n };
  };

  it('works out the pool from the curve, signs with the wallet and the position key, and reads the pool back', async () => {
    const w = tradingWorld(soldOutState());
    const flow = new CurveFlow(w.deps);
    const curve = (await flow.loadCurve(MINT))!;
    const review = await flow.prepareMigrate(BUYER, curve);
    expect(review.blockers).toEqual([]);
    expect(review.args.liquidity > 0n && review.args.sqrtPrice > 0n).toBe(true);
    w.script.onSend = (tx) => {
      w.accounts.set(curveAddress(web3, PROGRAM, MINT), { owner: PROGRAM, data: curveBytes({ ...soldOutState(), status: 'migrated', realSol: 0n, pool: review.pool }) });
      w.accounts.set(review.pool, { owner: METEORA_PROGRAM_ID, data: new Uint8Array(8) });
      expect(tx.signatures.filter((s) => s.signature !== null).map((s) => s.publicKey.toBase58())).toContain(review.signer.publicKey.toBase58());
    };
    const out = await flow.migrate(review);
    expect(out.differences).toEqual([]);
    expect(out.pool).toBe(review.pool);
  });

  it('flags a curve that does not show as migrated, and a pool that is not Meteora’s', async () => {
    const w = tradingWorld(soldOutState());
    const flow = new CurveFlow(w.deps);
    const review = await flow.prepareMigrate(BUYER, (await flow.loadCurve(MINT))!);
    w.script.onSend = () => w.accounts.set(review.pool, { owner: BUYER, data: new Uint8Array(8) });
    const out = await flow.migrate(review);
    expect(out.differences.join(' ')).toMatch(/does not show as moved/);
    expect(out.differences.join(' ')).toMatch(/not owned by the pool program/);
  });

  it('blocks a curve that has not sold out, and a token whose pool already exists', async () => {
    const w = tradingWorld(fresh());
    const flow = new CurveFlow(w.deps);
    expect((await flow.prepareMigrate(BUYER, (await flow.loadCurve(MINT))!)).blockers.join(' ')).toMatch(/has not sold out/);
    const w2 = tradingWorld(soldOutState());
    const f2 = new CurveFlow(w2.deps);
    const curve = (await f2.loadCurve(MINT))!;
    const probe = await f2.prepareMigrate(BUYER, curve);
    w2.accounts.set(probe.pool, { owner: METEORA_PROGRAM_ID, data: new Uint8Array(8) });
    const review = await f2.prepareMigrate(BUYER, curve);
    // The pool address depends only on the two mints, so a second look finds the same pool.
    expect(review.pool).toBe(probe.pool);
    expect(review.blockers.join(' ')).toMatch(/already exists/);
  });

  it('allows an unwind only after the wait, then reads the new state back', async () => {
    const w = tradingWorld(soldOutState());
    const flow = new CurveFlow(w.deps);
    const curve = (await flow.loadCurve(MINT))!;
    w.now = Number(curve.soldOutAt) + CURVE_ABORT_AFTER_SECS - 1;
    expect((await flow.prepareAbort(BUYER, curve)).blockers.join(' ')).toMatch(/seven days/);
    w.now = Number(curve.soldOutAt) + CURVE_ABORT_AFTER_SECS;
    const review = await flow.prepareAbort(BUYER, curve);
    expect(review.blockers).toEqual([]);
    w.script.onSend = () => w.accounts.set(curveAddress(web3, PROGRAM, MINT), { owner: PROGRAM, data: curveBytes({ ...soldOutState(), status: 'aborted' }) });
    expect((await flow.abort(review)).differences).toEqual([]);
    w.accounts.set(curveAddress(web3, PROGRAM, MINT), { owner: PROGRAM, data: curveBytes(soldOutState()) });
    w.script.onSend = () => undefined;
    expect((await flow.abort(review)).differences.join(' ')).toMatch(/does not show as unwound/);
  });
});
