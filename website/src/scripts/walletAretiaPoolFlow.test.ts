import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import mints from './__fixtures__/launchMints.json';
import { LaunchError } from './walletLaunchFlow';
import type { PoolConfig } from './walletPoolCore';
import { DEFAULT_ARETIA_POOL_FORM, ARETIA_POOL_PROGRAM_ID_DEVNET, POOL_ACCOUNT_SIZE, POOL_TAG, POSITION_ACCOUNT_SIZE, POSITION_TAG, validateAretiaPool, type CreateParams } from './walletAretiaPoolCore';
import { AretiaPoolFlow, type AretiaPoolFlowDeps, type AretiaPoolProgress } from './walletAretiaPoolFlow';
import { poolAddress, positionAddress } from './walletAretiaPoolTx';
import { TOKEN_2022_PROGRAM_ID, ataAddress } from './walletTools';

const PROGRAM = ARETIA_POOL_PROGRAM_ID_DEVNET;
const CREATOR = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';

const finalMint = (): Uint8Array => Uint8Array.from(Buffer.from((mints as Record<string, string[]>).final!.join(''), 'hex'));
const tokenAccount = (amount: bigint): Uint8Array => {
  const data = new Uint8Array(170);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = 1;
  return data;
};

function poolBytes(p: { x: bigint; y: bigint; l: bigint; feeBps: number; acc?: bigint; feeReserve?: bigint; creator?: string; mint?: string; feeStartBps?: number; decaySecs?: number; vx?: bigint }): Uint8Array {
  const d = new Uint8Array(POOL_ACCOUNT_SIZE);
  d.set(POOL_TAG, 0);
  d.set(new web3.PublicKey(p.mint ?? MINT).toBytes(), 10);
  d.set(new web3.PublicKey(p.creator ?? CREATOR).toBytes(), 42);
  const v = new DataView(d.buffer);
  v.setUint16(74, p.feeBps, true);
  v.setBigUint64(76, p.x, true);
  v.setBigUint64(84, p.y, true);
  v.setBigUint64(92, p.l, true);
  v.setBigUint64(100, (p.acc ?? 0n) & ((1n << 64n) - 1n), true);
  v.setBigUint64(108, (p.acc ?? 0n) >> 64n, true);
  v.setBigUint64(116, p.feeReserve ?? 0n, true);
  v.setUint16(132, p.feeStartBps ?? 0, true);
  v.setUint32(134, p.decaySecs ?? 0, true);
  v.setBigUint64(138, p.vx ?? 0n, true);
  return d;
}
function positionBytes(pool: string, owner: string, shares: bigint, locked: bigint, pending = 0n): Uint8Array {
  const d = new Uint8Array(POSITION_ACCOUNT_SIZE);
  d.set(POSITION_TAG, 0);
  d.set(new web3.PublicKey(pool).toBytes(), 8);
  d.set(new web3.PublicKey(owner).toBytes(), 40);
  const v = new DataView(d.buffer);
  v.setBigUint64(72, shares, true);
  v.setBigUint64(80, locked, true);
  v.setBigUint64(104, pending, true);
  d.set(new web3.PublicKey(owner).toBytes(), 112);
  d.set(new web3.PublicKey(owner).toBytes(), 144);
  return d;
}

interface World {
  deps: AretiaPoolFlowDeps;
  accounts: Map<string, { owner: string; data: Uint8Array; lamports?: bigint }>;
  sent: web3.Transaction[];
  script: { simulate?: { ok: boolean; error: string | null; lamportsAfter: bigint | null }; reject?: boolean; confirm?: 'confirmed' | 'failed' | 'pending'; balance?: bigint; poolAppears?: boolean; wrongAmount?: boolean };
}

function world(): World {
  const accounts: World['accounts'] = new Map();
  accounts.set(MINT, { owner: TOKEN_2022_PROGRAM_ID, data: finalMint() });
  accounts.set(ataAddress(web3, CREATOR, MINT, TOKEN_2022_PROGRAM_ID), { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(900_000_000_000_000n) });
  const w = { accounts, sent: [], script: {} } as unknown as World;
  w.deps = {
    web3,
    program: PROGRAM,
    balanceOf: async () => w.script.balance ?? 1_000_000_000n,
    latestBlockhash: async () => ({ blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k', lastValidBlockHeight: 1 }),
    fetchAccount: async (address) => w.accounts.get(address) ?? null,
    simulate: async () => w.script.simulate ?? { ok: true, error: null, lamportsAfter: (w.script.balance ?? 1_000_000_000n) - 50_000_000n - 9_000_000n },
    signAndSubmit: async (tx) => {
      if (w.script.reject) throw new Error('User rejected the request.');
      w.sent.push(tx);
      const ix = tx.instructions.find((i) => i.programId.toBase58() === PROGRAM)!;
      if (w.script.poolAppears !== false && ix.data.length === 49) {
        const v = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
        const [x, y, l, fee, lock] = [v.getBigUint64(8, true), v.getBigUint64(16, true), v.getBigUint64(24, true), v.getUint16(32, true), ix.data[34] === 1];
        const [sniper, decay] = [v.getUint16(35, true), v.getUint32(37, true)];
        const vx = v.getBigUint64(41, true);
        const pool = ix.keys[4]!.pubkey.toBase58();
        w.accounts.set(pool, { owner: PROGRAM, data: poolBytes({ x: w.script.wrongAmount ? x - 1n : x, y, l, feeBps: fee, feeStartBps: sniper, decaySecs: decay, vx }) });
        w.accounts.set(ix.keys[7]!.pubkey.toBase58(), { owner: PROGRAM, data: positionBytes(pool, CREATOR, l, lock ? l : 0n) });
      }
      return 'sig1';
    },
    confirm: async () => w.script.confirm ?? 'confirmed',
    sleep: async () => undefined,
  };
  return w;
}

async function setup(w = world()) {
  const flow = new AretiaPoolFlow(w.deps);
  const token = (await flow.loadToken(CREATOR, MINT))!;
  const v = validateAretiaPool({ ...DEFAULT_ARETIA_POOL_FORM, mint: MINT, tokenAmount: '500,000,000', price: '0.000001' }, CREATOR, token);
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  return { w, flow, token, config: v.config as PoolConfig, params: v.params as CreateParams };
}

describe('loadToken', () => {
  it('reads a fixed-supply token and the creator’s balance of it', async () => {
    const { token } = await setup();
    expect(token).toMatchObject({ mint: MINT, mintAuthority: null, freezeAuthority: null, held: 900_000_000_000_000n });
  });
  it('returns null for something that is not a readable Token-2022 token', async () => {
    const w = world();
    w.accounts.delete(MINT);
    expect(await new AretiaPoolFlow(w.deps).loadToken(CREATOR, MINT)).toBeNull();
  });
});

describe('prepare', () => {
  it('prices the pool from the trial run: the fee plus the measured deposits', async () => {
    const { flow, config, params, token } = await setup();
    const r = await flow.prepare(config, params, token);
    expect(r.blockers).toEqual([]);
    expect(r.cost).toEqual({ aretiaFee: 50_000_000n, network: 9_000_000n, total: 59_000_000n });
  });
  it('blocks when the wallet is short, when the network would refuse it, and when the pool exists', async () => {
    const short = await setup();
    short.w.script.balance = 10_000_000n;
    short.w.script.simulate = { ok: true, error: null, lamportsAfter: 0n };
    expect((await short.flow.prepare(short.config, short.params, short.token)).blockers.join(' ')).toMatch(/enough SOL/);

    const refused = await setup();
    refused.w.script.simulate = { ok: false, error: 'custom program error: 0x1', lamportsAfter: null };
    expect((await refused.flow.prepare(refused.config, refused.params, refused.token)).blockers.join(' ')).toMatch(/trial run/);

    const exists = await setup();
    exists.w.accounts.set(poolAddress(web3, PROGRAM, MINT), { owner: PROGRAM, data: new Uint8Array(8) });
    expect((await exists.flow.prepare(exists.config, exists.params, exists.token)).blockers.join(' ')).toMatch(/already exists/);
  });
  it('refuses a token that can still be minted or frozen', async () => {
    const { flow, config, params, token } = await setup();
    expect((await flow.prepare(config, params, { ...token, mintAuthority: CREATOR })).blockers.join(' ')).toMatch(/create more/);
    expect((await flow.prepare(config, params, { ...token, freezeAuthority: CREATOR })).blockers.join(' ')).toMatch(/freeze/);
    expect((await flow.prepare(config, params, { ...token, extensions: [14] })).blockers.join(' ')).toMatch(/transfer hook/);
  });
});

describe('token notes', () => {
  it('warns when the token has no logo link or no name, and says nothing when the link is usable', async () => {
    const { flow, config, params, token } = await setup();
    const r = await flow.prepare(config, params, { ...token, metadata: { name: 'A', symbol: 'A', uri: '' } });
    expect(r.notes.join(' ')).toMatch(/no metadata link/);
    expect((await flow.prepare(config, params, { ...token, metadata: null })).notes.join(' ')).toMatch(/no name or symbol/);
    expect((await flow.prepare(config, params, { ...token, metadata: { name: 'A', symbol: 'A', uri: 'https://example.com/m.json' } })).notes).toEqual([]);
  });
});

describe('create', () => {
  it('goes through the steps in order, sends one transaction and reads the pool back', async () => {
    const { w, flow, config, params, token } = await setup();
    const review = await flow.prepare(config, params, token);
    const seen: AretiaPoolProgress[] = [];
    const out = await flow.create(review, (p) => seen.push(p));
    expect(seen).toEqual(['checking', 'signing', 'confirming', 'verifying', 'done']);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.instructions).toHaveLength(2); // Aretia's wrapped-SOL account if missing, then the pool
    expect(out.differences).toEqual([]);
    expect(out.pool).toBe(poolAddress(web3, PROGRAM, MINT));
    expect(out.position).toBe(positionAddress(web3, PROGRAM, out.pool, CREATOR));
  });
  it('does nothing while there are blockers', async () => {
    const { w, flow, config, params, token } = await setup();
    const review = await flow.prepare(config, params, { ...token, mintAuthority: CREATOR });
    await expect(flow.create(review)).rejects.toThrow(LaunchError);
    expect(w.sent).toHaveLength(0);
  });
  it('will not sign a transaction that differs from the review', async () => {
    const { w, flow, config, params, token } = await setup();
    const review = await flow.prepare(config, params, token);
    review.params = { ...review.params, l0: review.params.l0 + 1n }; // the page changed its mind after the review was built
    await expect(flow.create(review)).rejects.toThrow(/Not signing/);
    expect(w.sent).toHaveLength(0);
  });
  it('does not ask the wallet when the final trial run fails', async () => {
    const { w, flow, config, params, token } = await setup();
    const review = await flow.prepare(config, params, token);
    w.script.simulate = { ok: false, error: 'boom', lamportsAfter: null };
    await expect(flow.create(review)).rejects.toThrow(/would refuse/);
    expect(w.sent).toHaveLength(0);
  });
  it('reports a refused wallet request, a failed transaction and a pending one in plain words', async () => {
    const a = await setup();
    a.w.script.reject = true;
    await expect(a.flow.create(await a.flow.prepare(a.config, a.params, a.token))).rejects.toThrow(LaunchError);
    const b = await setup();
    b.w.script.confirm = 'failed';
    await expect(b.flow.create(await b.flow.prepare(b.config, b.params, b.token))).rejects.toThrow(/Nothing from it took effect/);
    const c = await setup();
    c.w.script.confirm = 'pending';
    await expect(c.flow.create(await c.flow.prepare(c.config, c.params, c.token))).rejects.toThrow(/has not confirmed yet/);
  });
  it('flags a pool that does not hold what was approved, and one that never shows up', async () => {
    const a = await setup();
    a.w.script.wrongAmount = true;
    const out = await a.flow.create(await a.flow.prepare(a.config, a.params, a.token));
    expect(out.differences.join(' ')).toMatch(/different amounts/);
    const b = await setup();
    b.w.script.poolAppears = false;
    const out2 = await b.flow.create(await b.flow.prepare(b.config, b.params, b.token));
    expect(out2.differences.join(' ')).toMatch(/could not be read back/);
  });
});

describe('trading, claiming and locking', () => {
  const live = async () => {
    const s = await setup();
    const review = await s.flow.prepare(s.config, s.params, s.token);
    await s.flow.create(review);
    s.w.sent.length = 0;
    return s;
  };
  it('loads the pool and the position and says what can be claimed', async () => {
    const { w, flow } = await live();
    const pool = poolAddress(web3, PROGRAM, MINT);
    w.accounts.set(pool, { owner: PROGRAM, data: poolBytes({ x: 5n, y: 6n, l: 100n, feeBps: 25, acc: 3n << 64n, feeReserve: 10_000n }) });
    w.accounts.set(positionAddress(web3, PROGRAM, pool, CREATOR), { owner: PROGRAM, data: positionBytes(pool, CREATOR, 100n, 100n, 7n) });
    const v = (await flow.loadPool(MINT, CREATOR))!;
    expect(v.claimable).toBe(307n);
    expect(v.decimals).toBe(6);
    expect((await flow.loadPool(MINT, null))!.position).toBeNull();
    w.accounts.set(pool, { owner: '11111111111111111111111111111111', data: poolBytes({ x: 5n, y: 6n, l: 100n, feeBps: 25 }) });
    expect(await flow.loadPool(MINT, CREATOR)).toBeNull();
  });
  it('quotes a trade with a floor under the amount received', async () => {
    const { flow } = await live();
    const pool = (await flow.loadPool(MINT, CREATOR))!.pool;
    const q = flow.quote(pool, true, 1_000_000_000n, 100)!;
    expect(q.minOut).toBe((q.expectedOut * 9_900n) / 10_000n);
    expect(q.minOut).toBeGreaterThan(0n);
    expect(flow.quote(pool, false, 1_000n, 100)).toBeNull(); // nothing to sell into yet
  });
  it('sends a trade, a claim and a lock, each as one checked transaction', async () => {
    const { w, flow } = await live();
    const pool = (await flow.loadPool(MINT, CREATOR))!.pool;
    const q = flow.quote(pool, true, 1_000_000_000n, 100)!;
    await flow.trade(CREATOR, MINT, q);
    await flow.claim(CREATOR, MINT);
    await flow.lock(CREATOR, MINT, 5n);
    // A buy wraps SOL around the swap (6 steps), a claim makes the wrapped-SOL account and unwraps (3), a lock is one step.
    expect(w.sent.map((t) => t.instructions.length)).toEqual([6, 3, 1]);
    expect(w.sent.every((t) => t.instructions.some((i) => i.programId.toBase58() === PROGRAM))).toBe(true);
  });
  it('will not send a trade without a floor', async () => {
    const { w, flow } = await live();
    await expect(flow.trade(CREATOR, MINT, { isBuy: true, amountIn: 1n, expectedOut: 1n, minOut: 0n, fee: 0n })).rejects.toThrow(/no minimum/);
    expect(w.sent).toHaveLength(0);
  });
  it('quotes and sends adding and removing liquidity with caps and floors', async () => {
    const { w, flow } = await live();
    const pool = (await flow.loadPool(MINT, CREATOR))!.pool;
    const a = flow.quoteAdd(pool, 1_000_000_000n, 100)!;
    expect(a.limitTokens).toBeGreaterThanOrEqual(a.tokens);
    expect(a.limitSol).toBeGreaterThanOrEqual(a.sol);
    const r = flow.quoteRemove(pool, 1_000_000_000n, 100)!;
    expect(r.limitTokens).toBeLessThanOrEqual(r.tokens);
    expect(flow.quoteAdd(pool, 10n, 100)).toBeNull();
    await flow.addLiquidity(CREATOR, MINT, a);
    await flow.removeLiquidity(CREATOR, MINT, r);
    expect(w.sent).toHaveLength(2);
  });
  it('reads a position by its id after it has been sold, and sends the transfer', async () => {
    const { w, flow } = await live();
    const pool = poolAddress(web3, PROGRAM, MINT);
    const NEW_OWNER = '3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg';
    const bytes = positionBytes(pool, CREATOR, 100n, 100n);
    bytes.set(new web3.PublicKey(NEW_OWNER).toBytes(), 40); // owned by someone else now, still under CREATOR's id
    w.accounts.set(positionAddress(web3, PROGRAM, pool, CREATOR), { owner: PROGRAM, data: bytes });
    expect((await flow.loadPool(MINT, NEW_OWNER))!.position).toBeNull(); // not under the new owner's own address
    const v = (await flow.loadPool(MINT, NEW_OWNER, CREATOR))!;
    expect(v.position).toMatchObject({ owner: NEW_OWNER, id: CREATOR });
    await flow.claim(NEW_OWNER, MINT, NEW_OWNER, undefined, CREATOR);
    await flow.transferPosition(NEW_OWNER, MINT, CREATOR, undefined, CREATOR);
    const sent = w.sent.slice(-2);
    expect(sent.map((t) => t.instructions.find((i) => i.programId.toBase58() === PROGRAM)!.keys.some((k) => k.pubkey.toBase58() === positionAddress(web3, PROGRAM, pool, CREATOR)))).toEqual([true, true]);
  });
});
