import { describe, expect, it } from 'vitest';
import type { EvmTxRequest } from '../swings/chains/evmWallet.js';
import { SwingsError } from '../swings/core/types.js';
import { keccak256 } from '../swings/core/keccak.js';
import { createAddress } from './walletCurveEvmCore';
import { evmOrdersChain, evmOrderTerms, DEFAULT_EVM_ORDER_FORM } from './walletOrdersEvmCore';
import { EvmOrdersError, EvmOrdersFlow, type EvmMarket } from './walletOrdersEvmFlow';
import { ORDER_CREATED_TOPIC, ORDERS_SEL, decodeCreateOrder, decodeCancelOrder } from './walletOrdersEvmTx';

const ORDERS = '0x1111111111111111111111111111111111111111';
const chain = evmOrdersChain('ethereum', { ethereum: { orders: ORDERS, fromBlock: 5 } })!;
const ME = '0x00000000000000000000000000000000000000aa';
// The token is the one the live Ethereum factory would make with its 5th CREATE, so the flow's local proof search finds it.
const TOKEN = createAddress(chain.factory, 5n);
const USDC = chain.quotes[1]!;
const NATIVE = chain.quotes[0]!;
const PAIR = '0x00000000000000000000000000000000000000e1';

const sel = (sig: string) =>
  '0x' +
  [...keccak256(new TextEncoder().encode(sig))]
    .slice(0, 4)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
const S = {
  decimals: sel('decimals()'),
  symbol: sel('symbol()'),
  balanceOf: sel('balanceOf(address)'),
  allowance: sel('allowance(address,address)'),
  getPair: sel('getPair(address,address)'),
  getReserves: sel('getReserves()'),
  approve: sel('approve(address,uint256)'),
};
const w = (n: bigint | string) => (typeof n === 'string' ? n.slice(2).toLowerCase().padStart(64, '0') : n.toString(16).padStart(64, '0'));
const abiString = (s: string) =>
  '0x' +
  w(32n) +
  w(BigInt(s.length)) +
  [...new TextEncoder().encode(s)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .padEnd(64, '0');

interface Order {
  owner: string;
  launch: string;
  quote: string;
  isBuy: boolean;
  inTotal: bigint;
  inRemaining: bigint;
  minOut: bigint;
}

function harness(
  over: {
    coin?: bigint;
    usdc?: bigint;
    tokens?: bigint;
    min?: bigint;
    pair?: boolean;
    revert?: string;
    rejectSend?: boolean;
    allowance?: bigint;
    failReceipt?: boolean;
    account?: string;
    chainId?: number;
    /** The orders contract has already been shown that the factory made the token. Default: yes. */
    proven?: boolean;
    /** The factory's own contract nonce (the next CREATE it would use). */
    factoryNonce?: bigint;
  } = {},
) {
  let proven = over.proven ?? true;
  const balances = new Map<string, bigint>([
    [`${USDC.address}:${ME}`, over.usdc ?? 1_000_000_000n],
    [`${TOKEN}:${ME}`, over.tokens ?? 5000n * 10n ** 18n],
  ]);
  const allowance = new Map<string, bigint>([[`${USDC.address}`, over.allowance ?? 0n]]);
  const orders = new Map<bigint, Order>();
  const logs: { address: string; topics: string[] }[] = [];
  const sent: EvmTxRequest[] = [];
  let next = 1n;
  const receipts = new Map<string, { status: string; logs: { address: string; topics: string[] }[] }>();
  let account = over.account ?? ME;
  const orderWords = (o: Order) =>
    '0x' + [w(o.owner), w(o.launch), w(o.quote), w(o.isBuy ? 1n : 0n), w(58n), w(150n), w(200n), w(2000n), w(o.inTotal), w(o.inRemaining), w(o.minOut), w(0n), w(0n)].join('');

  const read = async (method: string, params: unknown[]): Promise<unknown> => {
    if (method === 'eth_getCode') return '0x6001';
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getTransactionCount') return '0x' + (over.factoryNonce ?? 9n).toString(16);
    if (method === 'eth_getBalance') return '0x' + (over.coin ?? 10n ** 18n).toString(16);
    if (method === 'eth_gasPrice') return '0x' + (10n ** 9n).toString(16);
    if (method === 'eth_estimateGas') {
      if (over.revert) throw new Error(`execution reverted ${over.revert}`);
      return '0x30d40';
    }
    if (method === 'eth_getTransactionReceipt') return receipts.get(params[0] as string) ?? null;
    if (method === 'eth_getLogs') return logs;
    if (method === 'eth_call') {
      const { to, data } = params[0] as { to: string; data: string };
      if (over.revert && !data.startsWith(S.decimals) && !data.startsWith(S.symbol) && !data.startsWith(S.balanceOf) && !data.startsWith(S.allowance)) {
        if (data.startsWith(ORDERS_SEL.cancel) || data.startsWith(ORDERS_SEL.createOrder) || data.startsWith(ORDERS_SEL.createBuyWithNative)) throw new Error(`execution reverted ${over.revert}`);
      }
      const arg = (i: number) => '0x' + data.slice(10 + i * 64 + 24, 10 + (i + 1) * 64);
      if (data.startsWith(S.decimals)) return '0x' + w(to === TOKEN ? 18n : 6n);
      if (data.startsWith(S.symbol)) return abiString('TKN');
      if (data.startsWith(S.balanceOf)) return '0x' + w(balances.get(`${to}:${arg(0)}`) ?? 0n);
      if (data.startsWith(S.allowance)) return '0x' + w(allowance.get(to) ?? 0n);
      if (data.startsWith(ORDERS_SEL.proven)) return '0x' + w(proven ? 1n : 0n);
      if (data.startsWith(ORDERS_SEL.minAmount)) return '0x' + w(over.min ?? 50_000_000n);
      if (data.startsWith(S.getPair)) return '0x' + w(over.pair === false ? '0x' + '0'.repeat(40) : PAIR);
      if (data.startsWith(S.getReserves)) return '0x' + w(10n ** 24n) + w(10n ** 24n) + w(0n);
      // A simulation of one of the transactions the flow is about to send: it succeeds unless the test said the contract refuses.
      if (
        data.startsWith(S.approve) ||
        data.startsWith(ORDERS_SEL.proveLaunchToken) ||
        data.startsWith(ORDERS_SEL.createOrder) ||
        data.startsWith(ORDERS_SEL.createBuyWithNative) ||
        data.startsWith(ORDERS_SEL.cancel)
      )
        return '0x';
      if (data.startsWith(ORDERS_SEL.orders)) {
        const id = BigInt('0x' + data.slice(10));
        const o = orders.get(id);
        return o ? orderWords(o) : '0x' + '0'.repeat(832);
      }
    }
    throw new Error(`unexpected read ${method}`);
  };
  const adapter = {
    getAccounts: async () => [account],
    getChainId: async () => over.chainId ?? 1,
    switchChain: async () => undefined,
    sendTransaction: async (tx: EvmTxRequest) => {
      if (over.rejectSend) throw new SwingsError('rejected', 'User rejected');
      sent.push(tx);
      const hash = '0x' + sent.length.toString(16).padStart(64, '0');
      const out: { address: string; topics: string[] }[] = [];
      if ((tx.data ?? '').startsWith(S.approve)) allowance.set(tx.to, BigInt('0x' + (tx.data ?? '').slice(-64)));
      if ((tx.data ?? '').startsWith(ORDERS_SEL.proveLaunchToken)) proven = true;
      const c = decodeCreateOrder(tx.data ?? '');
      if (c) {
        const id = next++;
        orders.set(id, { owner: tx.from.toLowerCase(), launch: c.launchToken, quote: c.quoteToken, isBuy: c.isBuy, inTotal: c.amountIn, inRemaining: c.amountIn, minOut: c.minOut });
        const log = { address: ORDERS, topics: [ORDER_CREATED_TOPIC, '0x' + w(id), '0x' + w(tx.from), '0x' + w(c.launchToken)] };
        out.push(log);
        logs.push(log);
      }
      const cid = decodeCancelOrder(tx.data ?? '');
      if (cid !== null) orders.delete(cid);
      receipts.set(hash, { status: over.failReceipt ? '0x0' : '0x1', logs: out });
      return hash;
    },
  };
  let t = 0;
  const flow = new EvmOrdersFlow({ adapter, read, now: () => (t += 1000), sleep: async () => undefined });
  return { flow, sent, orders, setAccount: (a: string) => (account = a), logs };
}

async function loaded(h: ReturnType<typeof harness>, quote = USDC): Promise<EvmMarket> {
  const m = await h.flow.loadMarket(chain, ME, TOKEN, quote);
  if ('problem' in m) throw new Error(m.problem);
  return m;
}
const form = { ...DEFAULT_EVM_ORDER_FORM, token: TOKEN, quote: 'USDC', amount: '100', price: '0.05' };
const terms = (side: 'buy' | 'sell' = 'buy', q = USDC) => evmOrderTerms({ ...form, side, amount: side === 'buy' ? '100' : '2000', quote: q.symbol }, 18, q)!;

describe('loadMarket', () => {
  it('reads the token, the balances and the minimum', async () => {
    const m = await loaded(harness());
    expect(m).toMatchObject({ symbol: 'TKN', decimals: 18, minQuote: 50_000_000n, quoteBalance: 1_000_000_000n });
  });
  it('says why not, in plain words', async () => {
    const say = async (o: Parameters<typeof harness>[0], q = USDC) => {
      const r = await harness(o).flow.loadMarket(chain, ME, TOKEN, q);
      return 'problem' in r ? r.problem : '';
    };
    expect(await say({ pair: false })).toContain('no USDC pool');
    expect(await say({ min: 0n })).toContain('not switched on');
  });
  it('a coin-paid market uses the coin balance', async () => {
    const m = await loaded(harness({ coin: 7n * 10n ** 17n }), NATIVE);
    expect(m.quoteBalance).toBe(7n * 10n ** 17n);
  });
});

describe('placing', () => {
  it('a USDC buy asks for an exact approval, then places the order, and reads it back', async () => {
    const h = harness();
    const m = await loaded(h);
    const r = await h.flow.preparePlace(ME, m, terms());
    expect(r.blockers).toEqual([]);
    expect(r.approveTx).not.toBeNull();
    const steps: string[] = [];
    const out = await h.flow.place(r, (p) => steps.push(p));
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]!.to).toBe(USDC.address);
    expect(h.sent[1]!.to).toBe(ORDERS);
    expect(out).toMatchObject({ id: 1n, differences: [] });
    expect(steps).toEqual(expect.arrayContaining(['approving', 'confirming-approve', 'sending', 'confirming', 'verifying', 'done']));
  });

  it('no approval when the contract already has enough', async () => {
    const h = harness({ allowance: 10n ** 12n });
    const r = await h.flow.preparePlace(ME, await loaded(h), terms());
    expect(r.approveTx).toBeNull();
    await h.flow.place(r);
    expect(h.sent).toHaveLength(1);
  });

  it('a coin-paid buy sends the coin with one transaction and no approval', async () => {
    const h = harness();
    const t = evmOrderTerms({ ...form, quote: 'ETH', amount: '0.5', price: '0.00002' }, 18, NATIVE)!;
    const r = await h.flow.preparePlace(ME, await loaded(h, NATIVE), t);
    expect(r.approveTx).toBeNull();
    expect(r.isNative).toBe(true);
    await h.flow.place(r);
    expect(h.sent).toHaveLength(1);
    expect(BigInt(h.sent[0]!.value as string)).toBe(t.amountIn);
  });

  it('a sell approves the launch token, not the payment asset', async () => {
    const h = harness();
    const r = await h.flow.preparePlace(ME, await loaded(h), terms('sell'));
    expect(r.approveTx!.to).toBe(TOKEN);
  });

  it('blocks what the wallet cannot cover, and what the network would refuse', async () => {
    const h = harness({ usdc: 10_000_000n });
    const poor = await h.flow.preparePlace(ME, await loaded(h), terms());
    expect(poor.blockers.join(' ')).toContain('More USDC than your wallet holds');
    const noGas = harness({ coin: 1000n });
    expect((await noGas.flow.preparePlace(ME, await loaded(noGas), terms())).blockers.join(' ')).toContain('You need more ETH');
    const refused = harness({ allowance: 10n ** 12n, revert: sel('Paused()') });
    const r = await refused.flow.preparePlace(ME, await loaded(refused), terms());
    expect(r.blockers.join(' ')).toContain('orders are paused');
    await expect(refused.flow.place(r)).rejects.toThrow(EvmOrdersError);
    expect(refused.sent).toHaveLength(0);
  });

  it('refuses to send when the wallet’s account or review changed, and sends nothing', async () => {
    const h = harness();
    const r = await h.flow.preparePlace(ME, await loaded(h), terms());
    h.setAccount('0x00000000000000000000000000000000000000bb');
    await expect(h.flow.place(r)).rejects.toThrow('account selected in your wallet changed');
    expect(h.sent).toHaveLength(0);
    const tampered = { ...r, tx: { ...r.tx, to: '0x2222222222222222222222222222222222222222' } };
    h.setAccount(ME);
    await expect(h.flow.place(tampered)).rejects.toThrow('Not signing');
    expect(h.sent.length).toBeLessThanOrEqual(1); // the approval may have gone; the order never does
    expect(h.sent.every((s) => s.to !== ORDERS)).toBe(true);
  });

  it('says the approval stands if the order fails after it', async () => {
    const h = harness();
    const r = await h.flow.preparePlace(ME, await loaded(h), terms());
    const bad = { ...r, tx: { ...r.tx, value: '0x5' } };
    await expect(h.flow.place(bad)).rejects.toThrow('Your approval went through');
  });

  it('a closed wallet is reported as such', async () => {
    const h = harness({ rejectSend: true });
    const r = await h.flow.preparePlace(ME, await loaded(h), terms());
    await expect(h.flow.place(r)).rejects.toThrow('closed the wallet');
  });

  it('a failed transaction is reported as one that took no effect', async () => {
    const h = harness({ failReceipt: true });
    const r = await h.flow.preparePlace(ME, await loaded(h), terms());
    await expect(h.flow.place(r)).rejects.toThrow('nothing from it took effect');
  });
});

describe('listing and cancelling', () => {
  it('lists only the owner’s open orders, with the token symbol and the price in the asset', async () => {
    const h = harness({ allowance: 10n ** 12n });
    await h.flow.place(await h.flow.preparePlace(ME, await loaded(h), terms()));
    const rows = await h.flow.listOrders(chain, ME);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: 'TKN', decimals: 18, limit: 50_000n });
    expect(rows[0]!.quote?.symbol).toBe('USDC');
  });

  it('cancels, and checks the order is gone', async () => {
    const h = harness({ allowance: 10n ** 12n });
    await h.flow.place(await h.flow.preparePlace(ME, await loaded(h), terms()));
    const [row] = await h.flow.listOrders(chain, ME);
    const review = await h.flow.prepareCancel(chain, ME, row!.record);
    expect(review.blockers).toEqual([]);
    const out = await h.flow.cancel(review);
    expect(out.differences).toEqual([]);
    expect(h.orders.size).toBe(0);
    expect(await h.flow.listOrders(chain, ME)).toEqual([]);
  });

  it('will not prepare a cancel for someone else’s order', async () => {
    const h = harness({ allowance: 10n ** 12n });
    await h.flow.place(await h.flow.preparePlace(ME, await loaded(h), terms()));
    const [row] = await h.flow.listOrders(chain, ME);
    const r = await h.flow.prepareCancel(chain, '0x00000000000000000000000000000000000000bb', row!.record);
    expect(r.blockers.join(' ')).toContain('belongs to a different account');
  });
});

describe('the first order for a token: the one-time proof', () => {
  it('finds the factory nonce locally and says why a token the factory did not make is refused', async () => {
    const h = harness({ proven: false });
    const m = await loaded(h);
    expect(m).toMatchObject({ proven: false, proofNonce: 5n });
    const other = await harness({ proven: false, factoryNonce: 4n }).flow.loadMarket(chain, ME, TOKEN, USDC); // the factory has only made 3 tokens: nonce 5 is not one of them
    expect('problem' in other && other.problem).toContain('not made by Aretia’s token factory');
  });

  it('sends the proof, then the approval, then the order, and the contract is shown the right nonce', async () => {
    const h = harness({ proven: false });
    const r = await h.flow.preparePlace(ME, await loaded(h), terms());
    expect(r.blockers).toEqual([]);
    expect(r.proveTx).not.toBeNull();
    const steps: string[] = [];
    const out = await h.flow.place(r, (p) => steps.push(p));
    expect(h.sent).toHaveLength(3);
    expect(h.sent[0]!.to).toBe(ORDERS);
    expect(h.sent[0]!.data!.startsWith(ORDERS_SEL.proveLaunchToken)).toBe(true);
    expect(h.sent[1]!.to).toBe(USDC.address);
    expect(h.sent[2]!.to).toBe(ORDERS);
    expect(steps).toEqual(expect.arrayContaining(['proving', 'confirming-proof']));
    expect(out.differences).toEqual([]);
  });

  it('a proven token goes straight to the approval and the order', async () => {
    const h = harness();
    const r = await h.flow.preparePlace(ME, await loaded(h), terms());
    expect(r.proveTx).toBeNull();
  });

  it('refuses a proof that was changed after the review, and sends nothing', async () => {
    const h = harness({ proven: false });
    const r = await h.flow.preparePlace(ME, await loaded(h), terms());
    const bad = { ...r, proveTx: { ...r.proveTx!, data: r.proveTx!.data!.slice(0, -1) + '9' } };
    await expect(h.flow.place(bad)).rejects.toThrow('Not signing');
    expect(h.sent).toHaveLength(0);
  });
});
