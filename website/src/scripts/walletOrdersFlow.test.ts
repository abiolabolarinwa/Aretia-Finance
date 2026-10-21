import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { LaunchError } from './walletLaunchFlow';
import { deriveCurve, startOf } from './walletCurveCore';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ataAddress } from './walletTools';
import { OrdersFlow, type Market, type OrdersFlowDeps } from './walletOrdersFlow';
import { DEFAULT_ORDER_FORM, orderTerms } from './walletOrdersCore';
import { WRAPPED_SOL_MINT, curveAddressOf, orderAddress, ordersAssetAddress, ordersConfigAddress } from './walletOrdersTx';

const PROGRAM = 'Fnb5FELt2BGQLzXdKc1pFTJThdYuZQwaamLVpc8pGPKH';
const CURVE_PROGRAM = 'CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu';
const OWNER = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const FEE = '2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2';
const SOL = 1_000_000_000n;
const keyBytes = (a: string) => new web3.PublicKey(a).toBytes();

// ---- account bytes, built the way the programs lay them out

const mintBytes = (decimals = 6) => {
  const d = new Uint8Array(82);
  d[44] = decimals;
  d[45] = 1;
  return d;
};
function tokenBytes(amount: bigint): Uint8Array {
  const d = new Uint8Array(165);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = 1;
  return d;
}
function curveBytes(status = 0): Uint8Array {
  const dv = deriveCurve(1_000_000_000_000_000n, 85_000_000_000n)!;
  const s = startOf(dv);
  const d = new Uint8Array(189);
  d.set([191, 180, 249, 66, 180, 71, 51, 182], 0);
  d[10] = status;
  d.set(keyBytes(OWNER), 11);
  d.set(keyBytes(MINT), 43);
  const v = new DataView(d.buffer);
  v.setUint16(75, 58, true);
  v.setBigUint64(77, 85_000_000_000n, true);
  v.setBigUint64(85, dv.vSol0, true);
  v.setBigUint64(93, dv.curveTokens, true);
  v.setBigUint64(101, dv.lpTokens, true);
  v.setBigUint64(109, s.vSol, true);
  v.setBigUint64(117, s.vTok, true);
  v.setBigUint64(125, s.realSol, true);
  v.setBigUint64(133, s.realTok, true);
  return d;
}
function assetBytes(min = 100_000_000n, enabled = true): Uint8Array {
  const d = new Uint8Array(50);
  d.set(keyBytes(WRAPPED_SOL_MINT), 8);
  new DataView(d.buffer).setBigUint64(40, min, true);
  d[48] = enabled ? 1 : 0;
  return d;
}
function orderBytes(
  over: {
    owner?: string;
    side?: 0 | 1;
    nonce?: bigint;
    inTotal?: bigint;
    inRemaining?: bigint;
    minOut?: bigint;
    status?: number;
  } = {},
): Uint8Array {
  const d = new Uint8Array(235);
  d.set([134, 173, 223, 185, 77, 86, 28, 51], 0);
  const b = d.subarray(8);
  b.set(keyBytes(over.owner ?? OWNER), 0);
  b.set(keyBytes(MINT), 32);
  b.set(keyBytes(WRAPPED_SOL_MINT), 64);
  b.set(keyBytes(TOKEN_2022_PROGRAM_ID), 96);
  b.set(keyBytes(TOKEN_PROGRAM_ID), 128);
  b[160] = over.side ?? 0;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  v.setBigUint64(161, over.nonce ?? 1n, true);
  v.setBigUint64(169, over.inTotal ?? SOL, true);
  v.setBigUint64(177, over.inRemaining ?? over.inTotal ?? SOL, true);
  v.setBigUint64(185, over.minOut ?? 20_000_000_000n, true);
  v.setUint16(209, 58, true);
  b[217] = over.status ?? 1;
  return b.length ? d : d;
}

// ---- a fake network

interface Acc {
  owner: string;
  data: Uint8Array;
}
function harness(
  over: {
    sol?: bigint;
    wrapped?: bigint;
    tokens?: bigint;
    reject?: boolean;
    simError?: string | null;
    confirm?: 'confirmed' | 'failed' | 'pending';
    afterSend?: (accounts: Map<string, Acc>, tx: web3.Transaction) => void;
  } = {},
) {
  const accounts = new Map<string, Acc>();
  const put = (addr: string, owner: string, data: Uint8Array) => accounts.set(addr, { owner, data });
  put(MINT, TOKEN_2022_PROGRAM_ID, mintBytes());
  put(curveAddressOf(web3, CURVE_PROGRAM, MINT), CURVE_PROGRAM, curveBytes());
  put(ordersAssetAddress(web3, PROGRAM, WRAPPED_SOL_MINT), PROGRAM, assetBytes());
  const cfg = new Uint8Array(8 + 64 + 8);
  cfg.set(keyBytes(FEE), 8 + 32);
  put(ordersConfigAddress(web3, PROGRAM), PROGRAM, cfg);
  put(ataAddress(web3, OWNER, MINT, TOKEN_2022_PROGRAM_ID), TOKEN_2022_PROGRAM_ID, tokenBytes(over.tokens ?? 0n));
  if (over.wrapped) put(ataAddress(web3, OWNER, WRAPPED_SOL_MINT, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID, tokenBytes(over.wrapped));
  const sent: web3.Transaction[] = [];
  const open: { address: string; data: Uint8Array }[] = [];
  let nonce = 100n;
  const deps: OrdersFlowDeps = {
    web3,
    program: PROGRAM,
    curveProgram: CURVE_PROGRAM,
    balanceOf: async () => over.sol ?? 5n * SOL,
    latestBlockhash: async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 10,
    }),
    fetchAccount: async (a) => accounts.get(a) ?? null,
    ordersOf: async () => open,
    simulate: async () => (over.simError ? { ok: false, error: over.simError } : { ok: true, error: null }),
    signAndSubmit: async (tx) => {
      if (over.reject) throw new Error('User rejected the request');
      sent.push(tx);
      over.afterSend?.(accounts, tx);
      return 'SIG';
    },
    confirm: async () => over.confirm ?? 'confirmed',
    newNonce: () => nonce++,
    sleep: async () => undefined,
  };
  return { flow: new OrdersFlow(deps), accounts, sent, open, put };
}

async function loaded(h: ReturnType<typeof harness>): Promise<Market> {
  const m = await h.flow.loadMarket(OWNER, MINT);
  if ('problem' in m) throw new Error(m.problem);
  return m;
}
const buyForm = {
  ...DEFAULT_ORDER_FORM,
  mint: MINT,
  side: 'buy' as const,
  amount: '1',
  price: '0.00005',
};

describe('loadMarket', () => {
  it('reads a token with a trading curve and a switched-on program', async () => {
    const h = harness({ tokens: 7n });
    const m = await loaded(h);
    expect(m).toMatchObject({
      mint: MINT,
      decimals: 6,
      minLamports: 100_000_000n,
      tokens: 7n,
      wrapped: 0n,
      sol: 5n * SOL,
    });
    expect(m.curve.status).toBe('trading');
  });

  it('says why not, in plain words', async () => {
    const bad = async (mut: (h: ReturnType<typeof harness>) => void) => {
      const h = harness();
      mut(h);
      const r = await h.flow.loadMarket(OWNER, MINT);
      return 'problem' in r ? r.problem : '';
    };
    expect(await bad((h) => void h.accounts.delete(MINT))).toContain('not a token this page can read');
    expect(await bad((h) => void h.accounts.delete(curveAddressOf(web3, CURVE_PROGRAM, MINT)))).toContain('no Aretia bonding curve');
    expect(await bad((h) => h.put(curveAddressOf(web3, CURVE_PROGRAM, MINT), CURVE_PROGRAM, curveBytes(1)))).toContain('not trading');
    expect(await bad((h) => h.put(curveAddressOf(web3, CURVE_PROGRAM, MINT), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', curveBytes()))).toContain('no Aretia bonding curve');
    expect(await bad((h) => void h.accounts.delete(ordersAssetAddress(web3, PROGRAM, WRAPPED_SOL_MINT)))).toContain('not switched on');
    expect(await bad((h) => h.put(ordersAssetAddress(web3, PROGRAM, WRAPPED_SOL_MINT), PROGRAM, assetBytes(1n, false)))).toContain('not switched on');
    const h = harness();
    expect(await h.flow.loadMarket(OWNER, 'nope')).toEqual({
      problem: 'That is not a token address.',
    });
  });
});

describe('placing an order', () => {
  it('a buy wraps the SOL it needs, then creates the order, in one transaction the wallet signs once', async () => {
    const h = harness({
      afterSend: (accounts) =>
        accounts.set(orderAddress(web3, PROGRAM, OWNER, 100n), {
          owner: PROGRAM,
          data: orderBytes({ nonce: 100n }),
        }),
    });
    const m = await loaded(h);
    const { issues, terms } = h.flow.prepareForm(buyForm, m);
    expect(issues).toEqual([]);
    const review = await h.flow.preparePlace(OWNER, m, terms!);
    expect(review.blockers).toEqual([]);
    expect(review.instructions).toHaveLength(4); // create the wrapped-SOL account, transfer, sync, create the order
    expect(review.preview).toMatchObject({
      escrowed: '1 SOL',
      atLeast: '20,000 tokens',
    });
    const steps: string[] = [];
    const out = await h.flow.place(review, (p) => steps.push(p));
    expect(out.differences).toEqual([]);
    expect(h.sent).toHaveLength(1);
    expect(steps).toEqual(['checking', 'signing', 'confirming', 'verifying', 'done']);
  });

  it('uses SOL that is already wrapped before wrapping more', async () => {
    const h = harness({ wrapped: 3n * SOL });
    const m = await loaded(h);
    const r = await h.flow.preparePlace(OWNER, m, orderTerms(buyForm, 6)!);
    expect(r.instructions).toHaveLength(2); // only make sure the account exists, then create
  });

  it('a sell holds the tokens and needs no wrapping', async () => {
    const h = harness({ tokens: 30_000_000_000n });
    const m = await loaded(h);
    const form = { ...buyForm, side: 'sell' as const, amount: '20000' };
    expect(h.flow.prepareForm(form, m).issues).toEqual([]);
    const r = await h.flow.preparePlace(OWNER, m, orderTerms(form, 6)!);
    expect(r.instructions).toHaveLength(1);
  });

  it('refuses a form the person cannot afford or that is too small', async () => {
    const h = harness({ sol: 500_000_000n });
    const m = await loaded(h);
    expect(h.flow.prepareForm(buyForm, m).issues.map((i) => i.field)).toEqual(['amount']);
    const small = { ...buyForm, amount: '0.01' };
    expect(h.flow.prepareForm(small, { ...m, sol: 5n * SOL }).issues[0]!.message).toContain('smallest order');
  });

  it('does not send when something blocks it', async () => {
    const h = harness({ simError: 'custom program error: 0x1790 LimitNotMet' });
    const m = await loaded(h);
    const r = await h.flow.preparePlace(OWNER, m, orderTerms(buyForm, 6)!);
    expect(r.blockers[0]).toContain('trial run');
    await expect(h.flow.place(r)).rejects.toThrow(LaunchError);
    expect(h.sent).toHaveLength(0);
  });

  it('blocks a buy the wallet cannot cover with SOL left for fees', async () => {
    const h = harness({ sol: 1_005_000_000n });
    const m = await loaded(h);
    const r = await h.flow.preparePlace(OWNER, m, orderTerms(buyForm, 6)!);
    expect(r.blockers.join(' ')).toContain('does not hold enough SOL');
  });

  it('reports a rejected signature as nothing sent', async () => {
    const h = harness({ reject: true });
    const m = await loaded(h);
    const r = await h.flow.preparePlace(OWNER, m, orderTerms(buyForm, 6)!);
    const err = await h.flow.place(r).catch((e) => e as LaunchError);
    expect(err).toBeInstanceOf(LaunchError);
    expect((err as LaunchError).nothingSent).toBe(true);
    expect((err as LaunchError).message).toContain('closed the wallet');
  });

  it('flags an order that reads back differently from what was approved', async () => {
    const h = harness({
      afterSend: (accounts) =>
        accounts.set(orderAddress(web3, PROGRAM, OWNER, 100n), {
          owner: PROGRAM,
          data: orderBytes({ nonce: 100n, minOut: 1n }),
        }),
    });
    const m = await loaded(h);
    const r = await h.flow.preparePlace(OWNER, m, orderTerms(buyForm, 6)!);
    const out = await h.flow.place(r);
    expect(out.differences).toEqual(['The order’s price is not the one you approved.']);
  });

  it('says so when the order cannot be read back, and when a transaction fails or is still pending', async () => {
    const h = harness();
    const m = await loaded(h);
    const r = await h.flow.preparePlace(OWNER, m, orderTerms(buyForm, 6)!);
    expect((await h.flow.place(r)).differences).toEqual(['The new order could not be read back from the network.']);
    const failing = harness({ confirm: 'failed' });
    const r2 = await failing.flow.preparePlace(OWNER, await loaded(failing), orderTerms(buyForm, 6)!);
    await expect(failing.flow.place(r2)).rejects.toThrow('failed on the network');
    const pending = harness({ confirm: 'pending' });
    const r3 = await pending.flow.preparePlace(OWNER, await loaded(pending), orderTerms(buyForm, 6)!);
    await expect(pending.flow.place(r3)).rejects.toThrow('has not confirmed yet');
  });
});

describe('listing and cancelling', () => {
  it('lists only well-formed orders that belong to the owner, with the price each is waiting for', async () => {
    const h = harness();
    h.open.push(
      { address: 'A', data: orderBytes({ nonce: 1n }) },
      { address: 'B', data: orderBytes({ nonce: 2n, owner: MINT }) }, // someone else's
      { address: 'C', data: new Uint8Array(10) }, // not an order
      {
        address: 'D',
        data: orderBytes({
          nonce: 3n,
          side: 1,
          inTotal: 20_000_000_000n,
          minOut: SOL,
        }),
      },
    );
    const rows = await h.flow.listOrders(OWNER);
    expect(rows.map((r) => r.address)).toEqual(['A', 'D']);
    expect(rows[0]).toMatchObject({ decimals: 6, limit: 50_000n });
    expect(rows[1]).toMatchObject({ limit: 50_000n });
  });

  it('cancels an order, names the fee, and checks the order is gone', async () => {
    const addr = orderAddress(web3, PROGRAM, OWNER, 1n);
    const h = harness({ afterSend: (accounts) => void accounts.delete(addr) });
    h.accounts.set(addr, { owner: PROGRAM, data: orderBytes({ nonce: 1n }) });
    h.open.push({ address: addr, data: orderBytes({ nonce: 1n }) });
    const [r] = await h.flow.listOrders(OWNER);
    const review = await h.flow.prepareCancel(OWNER, r!);
    expect(review.blockers).toEqual([]);
    expect(review.fee).toBe(5_800_000n); // 0.58% of 1 SOL, rounded up
    const out = await h.flow.cancel(review);
    expect(out.differences).toEqual([]);
    expect(h.sent).toHaveLength(1);
  });

  it('reports an order that is still there after the cancel', async () => {
    const addr = orderAddress(web3, PROGRAM, OWNER, 1n);
    const h = harness();
    h.accounts.set(addr, { owner: PROGRAM, data: orderBytes({ nonce: 1n }) });
    h.open.push({ address: addr, data: orderBytes({ nonce: 1n }) });
    const [r] = await h.flow.listOrders(OWNER);
    const out = await h.flow.cancel(await h.flow.prepareCancel(OWNER, r!));
    expect(out.differences).toEqual(['The order is still there after the cancel confirmed.']);
  });

  it('will not build a cancel when the program’s settings cannot be read, or while the order is being filled', async () => {
    const addr = orderAddress(web3, PROGRAM, OWNER, 1n);
    const h = harness();
    h.open.push({ address: addr, data: orderBytes({ nonce: 1n }) });
    const [r] = await h.flow.listOrders(OWNER);
    h.accounts.delete(ordersConfigAddress(web3, PROGRAM));
    expect((await h.flow.prepareCancel(OWNER, r!)).blockers[0]).toContain('settings could not be read');

    const busy = harness();
    busy.open.push({
      address: addr,
      data: orderBytes({ nonce: 1n, status: 2 }),
    });
    const [br] = await busy.flow.listOrders(OWNER);
    expect((await busy.flow.prepareCancel(OWNER, br!)).blockers[0]).toContain('being filled');
  });
});

describe('unwrapping', () => {
  it('closes the wrapped-SOL account and checks it is empty', async () => {
    const ata = ataAddress(web3, OWNER, WRAPPED_SOL_MINT, TOKEN_PROGRAM_ID);
    const h = harness({
      wrapped: 2n * SOL,
      afterSend: (accounts) => void accounts.delete(ata),
    });
    expect(await h.flow.wrappedBalance(OWNER)).toBe(2n * SOL);
    const out = await h.flow.unwrap(OWNER);
    expect(out.differences).toEqual([]);
    expect(await h.flow.wrappedBalance(OWNER)).toBe(0n);
  });
});
