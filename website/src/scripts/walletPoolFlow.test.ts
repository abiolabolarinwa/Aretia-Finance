import * as web3 from '@solana/web3.js';
import * as sdk from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { describe, expect, it } from 'vitest';
import mints from './__fixtures__/launchMints.json';
import { LaunchError } from './walletLaunchFlow';
import { DEFAULT_POOL_FORM, validatePool, type PoolConfig } from './walletPoolCore';
import { PoolFlow, type PoolFlowDeps, type PoolProgress } from './walletPoolFlow';
import { METEORA_PROGRAM_ID, type PoolLibs } from './walletPoolTx';
import { TOKEN_2022_PROGRAM_ID, ataAddress } from './walletTools';

const CREATOR = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const libs: PoolLibs = { sdk, BN, cpAmm: new sdk.CpAmm(new web3.Connection('http://127.0.0.1:1')) };

const finalMint = (): Uint8Array => Uint8Array.from(Buffer.from((mints as Record<string, string[]>).final!.join(''), 'hex'));
const tokenAccount = (amount: bigint): Uint8Array => {
  const data = new Uint8Array(170);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = 1;
  return data;
};

interface World {
  deps: PoolFlowDeps;
  accounts: Map<string, { owner: string; data: Uint8Array; lamports?: bigint }>;
  sent: web3.Transaction[];
  script: { simulate?: { ok: boolean; error: string | null; lamportsAfter: bigint | null }; reject?: boolean; confirm?: 'confirmed' | 'failed' | 'pending'; balance?: bigint; poolAppears?: boolean };
}

function world(): World {
  const accounts: World['accounts'] = new Map();
  accounts.set(MINT, { owner: TOKEN_2022_PROGRAM_ID, data: finalMint() });
  accounts.set(ataAddress(web3, CREATOR, MINT, TOKEN_2022_PROGRAM_ID), { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(900_000_000_000_000n) });
  const w = { accounts, sent: [], script: {} } as unknown as World;
  w.deps = {
    web3,
    libs,
    balanceOf: async () => w.script.balance ?? 1_000_000_000n,
    latestBlockhash: async () => ({ blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k', lastValidBlockHeight: 1 }),
    fetchAccount: async (address) => w.accounts.get(address) ?? null,
    simulate: async () => w.script.simulate ?? { ok: true, error: null, lamportsAfter: (w.script.balance ?? 1_000_000_000n) - 50_000_000n - 17_000_000n },
    signAndSubmit: async (tx, signers) => {
      if (w.script.reject) throw new Error('User rejected the request.');
      for (const s of signers) tx.partialSign(s);
      w.sent.push(tx);
      if (w.script.poolAppears !== false) {
        const init = tx.instructions.find((i) => i.programId.toBase58() === METEORA_PROGRAM_ID && i.keys.length === 21)!;
        w.accounts.set(init.keys[5]!.pubkey.toBase58(), { owner: METEORA_PROGRAM_ID, data: new Uint8Array(8) });
      }
      return 'sig1';
    },
    confirm: async () => w.script.confirm ?? 'confirmed',
    sleep: async () => undefined,
  };
  return w;
}

async function setup(w = world()) {
  const flow = new PoolFlow(w.deps);
  const token = (await flow.loadToken(CREATOR, MINT))!;
  const v = validatePool({ ...DEFAULT_POOL_FORM, mint: MINT, tokenAmount: '500,000,000', price: '0.000001' }, CREATOR, token);
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  return { w, flow, token, config: v.config as PoolConfig };
}

describe('loadToken', () => {
  it('reads a fixed-supply token and the creator’s balance of it', async () => {
    const { token } = await setup();
    expect(token).toMatchObject({ mint: MINT, mintAuthority: null, freezeAuthority: null, held: 900_000_000_000_000n });
  });
  it('returns null for something that is not a readable Token-2022 token', async () => {
    const w = world();
    w.accounts.delete(MINT);
    expect(await new PoolFlow(w.deps).loadToken(CREATOR, MINT)).toBeNull();
  });
});

describe('prepare', () => {
  it('prices the pool from the trial run: the fee plus the measured deposits', async () => {
    const { flow, config, token } = await setup();
    const r = await flow.prepare(config, token);
    expect(r.blockers).toEqual([]);
    expect(r.cost.aretiaFee).toBe(50_000_000n);
    expect(r.cost.network).toBe(17_000_000n);
    expect(r.cost.total).toBe(67_000_000n);
  });
  it('blocks when the wallet is short, when the network would refuse it, and when the pool exists', async () => {
    const short = await setup(Object.assign(world(), {}));
    short.w.script.balance = 10_000_000n;
    short.w.script.simulate = { ok: true, error: null, lamportsAfter: 0n };
    expect((await short.flow.prepare(short.config, short.token)).blockers.join(' ')).toMatch(/enough SOL/);

    const refused = await setup();
    refused.w.script.simulate = { ok: false, error: 'custom program error: 0x1', lamportsAfter: null };
    expect((await refused.flow.prepare(refused.config, refused.token)).blockers.join(' ')).toMatch(/trial run/);

    const exists = await setup();
    const review = await exists.flow.prepare(exists.config, exists.token);
    exists.w.accounts.set(review.built.pool, { owner: METEORA_PROGRAM_ID, data: new Uint8Array(8) });
    expect((await exists.flow.prepare(exists.config, exists.token)).blockers.join(' ')).toMatch(/already exists/);
  });
  it('refuses a token that can still be minted or frozen', async () => {
    const { flow, config, token } = await setup();
    const r = await flow.prepare(config, { ...token, mintAuthority: CREATOR });
    expect(r.blockers.join(' ')).toMatch(/create more/);
  });
});

describe('create', () => {
  it('checks, has the wallet sign with the position key, sends once, and reads the pool back', async () => {
    const { w, flow, config, token } = await setup();
    const review = await flow.prepare(config, token);
    const steps: PoolProgress[] = [];
    const out = await flow.create(review, (p) => steps.push(p));
    expect(steps).toEqual(['checking', 'signing', 'confirming', 'verifying', 'done']);
    expect(w.sent).toHaveLength(1);
    expect(out).toMatchObject({ pool: review.built.pool, signature: 'sig1', differences: [] });
  });
  it('sends nothing when the wallet is closed', async () => {
    const { w, flow, config, token } = await setup();
    const review = await flow.prepare(config, token);
    w.script.reject = true;
    await expect(flow.create(review)).rejects.toThrow(/closed the wallet/);
    expect(w.sent).toHaveLength(0);
  });
  it('does not sign when the trial run now fails', async () => {
    const { w, flow, config, token } = await setup();
    const review = await flow.prepare(config, token);
    w.script.simulate = { ok: false, error: 'boom', lamportsAfter: null };
    const err = await flow.create(review).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LaunchError);
    expect((err as LaunchError).message).toMatch(/would refuse/);
    expect(w.sent).toHaveLength(0);
  });
  it('refuses to run a review that has blockers', async () => {
    const { flow, config, token } = await setup();
    const review = await flow.prepare(config, { ...token, freezeAuthority: CREATOR });
    await expect(flow.create(review)).rejects.toThrow(/freeze/);
  });
  it('reports a failed or still-pending transaction, and a pool that cannot be read back', async () => {
    const a = await setup();
    a.w.script.confirm = 'failed';
    await expect(a.flow.create(await a.flow.prepare(a.config, a.token))).rejects.toThrow(/failed on the network/);
    const b = await setup();
    b.w.script.confirm = 'pending';
    await expect(b.flow.create(await b.flow.prepare(b.config, b.token))).rejects.toThrow(/not confirmed yet/);
    const c = await setup();
    c.w.script.poolAppears = false;
    const out = await c.flow.create(await c.flow.prepare(c.config, c.token));
    expect(out.differences.join(' ')).toMatch(/could not be read back/);
  });
});

describe('validatePool', () => {
  it('rejects more tokens than the wallet holds, a bad price and an unknown fee', async () => {
    const { token } = await setup();
    const bad = validatePool({ ...DEFAULT_POOL_FORM, mint: MINT, tokenAmount: '9,999,999,999', price: '0', tradingFeeBps: '7' }, CREATOR, token);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.map((i) => i.field).sort()).toEqual(['price', 'tokenAmount', 'tradingFeeBps']);
  });
});

describe('launch protection in the form', () => {
  it('is on by default with a 30-minute window, and can be turned off', () => {
    expect(DEFAULT_POOL_FORM.protection).toBe(true);
    expect(DEFAULT_POOL_FORM.protectionMinutes).toBe('30');
    const base = { ...DEFAULT_POOL_FORM, mint: MINT, tokenAmount: '1,000', price: '0.000001' };
    const token = { mint: MINT, decimals: 6, supply: 10n ** 15n, mintAuthority: null, freezeAuthority: null, extensions: [], held: 10n ** 15n };
    const on = validatePool(base, CREATOR, token);
    expect(on.ok && on.config.launchProtection).toEqual({ startBps: 500, minutes: 30 });
    const off = validatePool({ ...base, protection: false }, CREATOR, token);
    expect(off.ok && off.config.launchProtection).toBe(null);
    const bad = validatePool({ ...base, protectionMinutes: '7' }, CREATOR, token);
    expect(bad.ok).toBe(false);
  });
});
