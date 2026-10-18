/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { SwingsError } from '../swings/core/types.js';
import { createAddress } from './walletCurveEvmCore';
import { evmPoolChain, poolQuoteBuy, type EvmPoolConfig, type EvmPoolMath } from './walletAretiaPoolEvmCore';
import { EvmPoolError, EvmPoolFlow, type EvmPoolFlowDeps } from './walletAretiaPoolEvmFlow';
import { POOL_SEL } from './walletAretiaPoolEvmTx';

const ETH = 10n ** 18n;
const CREATOR = '0x00000000000000000000000000000000000c0de1';
const OTHER = '0x00000000000000000000000000000000000b0b01';
const POOL = '0x2222222222222222222222222222222222222222';
const chain = evmPoolChain('ethereum', { ethereum: POOL })!;
const TOKEN = createAddress(chain.factory, 4n);
const hex = (n: bigint) => '0x' + n.toString(16);
const w32 = (n: bigint) => n.toString(16).padStart(64, '0');
const str = (s: string) => '0x' + w32(32n) + w32(BigInt(s.length)) + Buffer.from(s).toString('hex').padEnd(64, '0');
const base: EvmPoolMath = { feeBps: 25n, x: 10n ** 27n, y: 0n, l: 10n * ETH, acc: 0n, feeReserve: 0n };

const config = (firstBuyWei = 0n): EvmPoolConfig => ({ chain, creator: CREATOR, token: TOKEN, tokenSymbol: 'TST', tokenDecimals: 18, factoryNonce: 4n, x0: 10n ** 27n, l0: 10n * ETH, y0: 0n, feeBps: 25, lock: true, firstBuyWei });

/** A scripted chain: just enough state for the flow's reads, and a wallet that records what it was asked to send. */
function world() {
  const state = {
    chainId: 1n,
    poolCode: '0x6080',
    onChainFactory: chain.factory,
    onChainRecipient: chain.feeAddress,
    onChainFee: chain.creationFee,
    balance: 10n * ETH,
    tokenBalance: 10n ** 27n,
    allowance: 0n,
    pool: null as null | EvmPoolMath,
    position: { open: false, shares: 0n, locked: 0n, checkpoint: 0n, pending: 0n, recipient: 0n },
    other: { open: false, shares: 0n, locked: 0n, checkpoint: 0n, pending: 0n, recipient: 0n },
    factoryNonce: 6n,
    estimateOk: true,
    estimateFailOnce: false,
    wallet: CREATOR,
    walletChain: 1,
    reject: false,
    receiptStatus: '0x1',
    callOk: true,
    sent: [] as any[],
    onSend: undefined as undefined | ((tx: any) => void),
  };
  const poolWords = () => {
    const p = state.pool;
    return p ? [p.feeBps, BigInt(CREATOR), 1_700_000_000n, p.x, p.y, p.l, p.acc, p.feeReserve] : Array<bigint>(8).fill(0n);
  };
  const posWords = (p: typeof state.position) => [p.open ? 1n : 0n, p.shares, p.locked, p.checkpoint, p.pending, p.recipient];
  const read = async (method: string, params: unknown[]): Promise<unknown> => {
    const p = params as any[];
    if (method === 'eth_chainId') return hex(state.chainId);
    if (method === 'eth_getCode') return p[0] === POOL ? state.poolCode : '0x6080';
    if (method === 'eth_getBalance') return hex(state.balance);
    if (method === 'eth_getTransactionCount') return hex(state.factoryNonce);
    if (method === 'eth_gasPrice') return hex(20_000_000_000n);
    if (method === 'eth_estimateGas') {
      if (state.estimateFailOnce) {
        state.estimateFailOnce = false;
        throw new Error('header not found');
      }
      if (!state.estimateOk) throw new Error('execution reverted');
      return hex(60_000n);
    }
    if (method === 'eth_getTransactionReceipt') return { status: state.receiptStatus };
    if (method === 'eth_call') {
      const tx = p[0] as { from?: string; to: string; data: string };
      if (!state.callOk && tx.from) throw new Error('execution reverted: slippage');
      const d = tx.data;
      if (d.startsWith('0x06fdde03')) return str('Test');
      if (d.startsWith('0x95d89b41')) return str('TST');
      if (d.startsWith('0x313ce567')) return '0x' + w32(18n);
      if (d.startsWith('0x18160ddd')) return '0x' + w32(10n ** 27n);
      if (d.startsWith('0x70a08231')) return '0x' + w32(state.tokenBalance);
      if (d.startsWith(POOL_SEL.allowance)) return '0x' + w32(state.allowance);
      if (d.startsWith(POOL_SEL.factory)) return '0x' + w32(BigInt(state.onChainFactory));
      if (d.startsWith(POOL_SEL.feeRecipient)) return '0x' + w32(BigInt(state.onChainRecipient));
      if (d.startsWith(POOL_SEL.creationFee)) return '0x' + w32(state.onChainFee);
      if (d.startsWith(POOL_SEL.pools)) return '0x' + poolWords().map(w32).join('');
      if (d.startsWith(POOL_SEL.positions)) {
        const who = '0x' + d.slice(10 + 64 + 24);
        return '0x' + posWords(who.toLowerCase() === OTHER ? state.other : state.position).map(w32).join('');
      }
      return '0x';
    }
    throw new Error(`unexpected ${method}`);
  };
  const adapter = {
    getAccounts: async () => [state.wallet],
    getChainId: async () => state.walletChain,
    switchChain: async (id: number) => {
      state.walletChain = id;
    },
    sendTransaction: async (tx: any) => {
      if (state.reject) throw new SwingsError('rejected', 'closed');
      state.sent.push(tx);
      state.onSend?.(tx);
      return '0x' + state.sent.length.toString(16).padStart(64, '0');
    },
  };
  let clock = 0;
  const deps = { adapter, read, now: () => (clock += 60_000), nowSeconds: () => 1_700_000_000, sleep: async () => undefined } as unknown as EvmPoolFlowDeps;
  return { state, flow: new EvmPoolFlow(deps) };
}

/** Wires the scripted chain so that a successful approval and creation change what the next reads show. */
function liveCreate(state: ReturnType<typeof world>['state'], firstBuy = 0n) {
  state.onSend = (tx) => {
    if (tx.to === TOKEN) state.allowance = 10n ** 27n;
    else {
      const q = firstBuy > 0n ? poolQuoteBuy(base, firstBuy) : null;
      state.pool = q ? q.next : base;
      state.position = { open: true, shares: base.l, locked: base.l, checkpoint: 0n, pending: 0n, recipient: 0n };
      state.tokenBalance = q?.tokensOut ?? 0n;
      // the pool contract now holds the tokens
      (state as any).poolHeld = base.x - (q?.tokensOut ?? 0n);
    }
  };
}

describe('loading a token and proving the factory made it', () => {
  it('reads the token and finds the factory nonce from the factory’s own account nonce', async () => {
    const { flow } = world();
    expect(await flow.loadToken(chain, CREATOR, TOKEN)).toMatchObject({ symbol: 'TST', decimals: 18, supply: 10n ** 27n, held: 10n ** 27n, factoryNonce: 4n });
  });
  it('says no nonce for an address the factory did not make, and nothing for no code', async () => {
    const { flow, state } = world();
    expect((await flow.loadToken(chain, CREATOR, '0x3333333333333333333333333333333333333333'))!.factoryNonce).toBeNull();
    state.factoryNonce = 3n;
    expect((await flow.loadToken(chain, CREATOR, TOKEN))!.factoryNonce).toBeNull();
  });
});

describe('creating a pool', () => {
  it('builds an approval then a creation, checks the contract’s fixed values, and sends nothing while preparing', async () => {
    const { flow, state } = world();
    const r = await flow.prepareCreate(config());
    expect(r.blockers).toEqual([]);
    expect(r.steps.map((s) => s.what)).toEqual(['approval', 'pool creation']);
    expect(r.coinOut).toBe(chain.creationFee);
    expect(r.gasCostWei).not.toBeNull();
    expect(state.sent).toEqual([]);
  });
  it('runs both transactions, checks the allowance, and reads the pool and the locked position back with no differences', async () => {
    const { flow, state } = world();
    liveCreate(state);
    const r = await flow.prepareCreate(config());
    const progress: string[] = [];
    // Make the pool contract appear to hold the tokens: the scripted balance read returns state.tokenBalance for everyone, so give it the right amount at the end.
    const out = await flow.run(r, (p) => progress.push(p));
    expect(state.sent.map((t) => t.to)).toEqual([TOKEN, POOL]);
    expect(state.sent[1].value).toBe(hex(chain.creationFee));
    expect(progress).toEqual(['checking', 'approving', 'confirming-approve', 'sending', 'confirming', 'verifying', 'done']);
    expect(out.hashes).toHaveLength(2);
    // The scripted token balance read is the same for every holder, so the only difference reported is about what the pool holds; none about the pool itself.
    expect(out.differences.filter((d) => !/hold the tokens/.test(d))).toEqual([]);
  });
  it('quotes and passes a first buy as a minimum, and sends the creation fee plus the buy as the value', async () => {
    const { flow, state } = world();
    const r = await flow.prepareCreate(config(ETH));
    expect(r.blockers).toEqual([]);
    expect(r.minOut).toBe(poolQuoteBuy(base, ETH)!.tokensOut);
    expect(r.coinOut).toBe(chain.creationFee + ETH);
    liveCreate(state, ETH);
    await flow.run(r);
    expect(state.sent[1].value).toBe(hex(chain.creationFee + ETH));
  });
  it('is blocked when the token is not the factory’s, a pool exists, the contract is absent or has other fixed values, or funds are short', async () => {
    let w = world();
    expect((await w.flow.prepareCreate({ ...config(), factoryNonce: 5n })).blockers.join(' ')).toMatch(/not made by Aretia/);
    w = world();
    w.state.pool = base;
    expect((await w.flow.prepareCreate(config())).blockers.join(' ')).toMatch(/already exists/);
    w = world();
    w.state.poolCode = '0x';
    expect((await w.flow.prepareCreate(config())).blockers.join(' ')).toMatch(/not on this network/);
    w = world();
    w.state.onChainFee = chain.creationFee - 1n;
    expect((await w.flow.prepareCreate(config())).blockers.join(' ')).toMatch(/different creation fee/);
    w = world();
    w.state.onChainRecipient = '0x4444444444444444444444444444444444444444';
    expect((await w.flow.prepareCreate(config())).blockers.join(' ')).toMatch(/different address/);
    w = world();
    w.state.onChainFactory = '0x4444444444444444444444444444444444444444';
    expect((await w.flow.prepareCreate(config())).blockers.join(' ')).toMatch(/different factory/);
    w = world();
    w.state.chainId = 56n;
    expect((await w.flow.prepareCreate(config())).blockers.join(' ')).toMatch(/right network/);
    w = world();
    w.state.balance = chain.creationFee;
    expect((await w.flow.prepareCreate(config())).blockers.join(' ')).toMatch(/more ETH/);
    w = world();
    w.state.tokenBalance = 5n;
    expect((await w.flow.prepareCreate(config())).blockers.join(' ')).toMatch(/fewer of this token/);
    w = world();
    w.state.estimateOk = false;
    expect((await w.flow.prepareCreate(config())).blockers.join(' ')).toMatch(/would not accept the approval/);
  });
  it('retries one failed estimate before believing it', async () => {
    const { flow, state } = world();
    state.estimateFailOnce = true;
    expect((await flow.prepareCreate(config())).blockers).toEqual([]);
  });
  it('refuses to run a review with blockers and sends nothing', async () => {
    const { flow, state } = world();
    state.pool = base;
    const r = await flow.prepareCreate(config());
    await expect(flow.run(r)).rejects.toMatchObject({ nothingSent: true });
    expect(state.sent).toEqual([]);
  });
  it('does not sign a transaction the inspector refuses, even if the review was tampered with after it was built', async () => {
    const { flow, state } = world();
    const r = await flow.prepareCreate(config());
    r.steps[0]!.tx = { ...r.steps[0]!.tx, data: r.steps[0]!.tx.data!.replace(/[0-9a-f]{64}$/, 'f'.repeat(64)) };
    await expect(flow.run(r)).rejects.toThrow(/Not signing/);
    expect(state.sent).toEqual([]);
    // And a creation whose destination was changed after the approval went through.
    const w2 = world();
    liveCreate(w2.state);
    const r2 = await w2.flow.prepareCreate(config());
    r2.steps[1]!.tx = { ...r2.steps[1]!.tx, to: '0x5555555555555555555555555555555555555555' };
    await expect(w2.flow.run(r2)).rejects.toThrow(/Not signing[\s\S]*approval is in place for exactly the tokens/);
    expect(w2.state.sent).toHaveLength(1);
  });
  it('stops after an approval that left a different allowance, and says nothing moved', async () => {
    const { flow, state } = world();
    state.onSend = () => (state.allowance = 5n);
    const r = await flow.prepareCreate(config());
    await expect(flow.run(r)).rejects.toThrow(/allowance is not exactly/);
    expect(state.sent).toHaveLength(1);
  });
  it('reports a closed wallet, a failed transaction, a refusal by the network, and a changed account', async () => {
    let w = world();
    w.state.reject = true;
    await expect(w.flow.run(await w.flow.prepareCreate(config()))).rejects.toThrow(/closed the wallet/);
    w = world();
    w.state.receiptStatus = '0x0';
    await expect(w.flow.run(await w.flow.prepareCreate(config()))).rejects.toThrow(/failed on the network/);
    w = world();
    const r = await w.flow.prepareCreate(config());
    w.state.callOk = false;
    await expect(w.flow.run(r)).rejects.toThrow(/would refuse the approval[\s\S]*price moved/);
    expect(w.state.sent).toEqual([]);
    w = world();
    const r3 = await w.flow.prepareCreate(config());
    w.state.wallet = OTHER;
    await expect(w.flow.run(r3)).rejects.toThrow(/account selected in your wallet changed/);
  });
  it('switches the wallet to the right network first', async () => {
    const { flow, state } = world();
    state.walletChain = 56;
    liveCreate(state);
    await flow.run(await flow.prepareCreate(config()));
    expect(state.walletChain).toBe(1);
  });
});

describe('trading and managing a pool', () => {
  const live = (state: ReturnType<typeof world>['state']) => {
    state.pool = poolQuoteBuy(base, 3n * ETH)!.next;
    state.position = { open: true, shares: base.l, locked: 0n, checkpoint: 0n, pending: 0n, recipient: 0n };
  };
  it('buys: quotes from the pool as read, sets the minimum from the slippage, sends exactly the amount', async () => {
    const { flow, state } = world();
    live(state);
    const pool = (await flow.loadPool(chain, TOKEN))!;
    const r = await flow.prepareBuy(chain, CREATOR, pool, TOKEN, ETH, 100);
    expect(r.blockers).toEqual([]);
    expect(r.minOut).toBe((r.buyQuote!.tokensOut * 9900n) / 10_000n);
    state.tokenBalance = 10n ** 27n;
    const before = state.tokenBalance;
    state.onSend = () => (state.tokenBalance = before + r.buyQuote!.tokensOut);
    const out = await flow.run(r);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].value).toBe(hex(ETH));
    expect(out.differences).toEqual([]);
    expect((await flow.prepareBuy(chain, CREATOR, pool, TOKEN, 0n)).blockers.join(' ')).toMatch(/too small/);
  });
  it('sells in two steps and refuses a sale the pool cannot pay', async () => {
    const { flow, state } = world();
    live(state);
    const pool = (await flow.loadPool(chain, TOKEN))!;
    const r = await flow.prepareSell(chain, CREATOR, pool, TOKEN, 10n ** 24n);
    expect(r.blockers).toEqual([]);
    expect(r.steps.map((s) => s.what)).toEqual(['approval', 'sale']);
    state.onSend = (tx) => {
      if (tx.to === TOKEN) state.allowance = 10n ** 24n;
      else state.tokenBalance = 10n ** 27n - 10n ** 24n;
    };
    const out = await flow.run(r);
    expect(out.differences).toEqual([]);
    const huge = await flow.prepareSell(chain, CREATOR, pool, TOKEN, 5n * 10n ** 26n);
    expect(huge.blockers.join(' ')).toMatch(/more coin than buyers have paid in/);
  });
  it('adds liquidity with caps on both sides, removes only unlocked liquidity, and claims', async () => {
    const { flow, state } = world();
    live(state);
    const pool = (await flow.loadPool(chain, TOKEN))!;
    const pos = (await flow.loadPosition(chain, TOKEN, CREATOR))!;
    const add = await flow.prepareAdd(chain, CREATOR, pool, TOKEN, 10n ** 15n, 100);
    expect(add.blockers).toEqual([]);
    expect(add.steps.map((s) => s.what)).toEqual(['approval', 'deposit']);
    const rem = await flow.prepareRemove(chain, CREATOR, pool, pos, TOKEN, 10n ** 15n, 100);
    expect(rem.blockers).toEqual([]);
    const locked = await flow.prepareRemove(chain, CREATOR, pool, { ...pos, locked: pos.shares }, TOKEN, 1n);
    expect(locked.blockers.join(' ')).toMatch(/not locked/);
    const empty = await flow.prepareClaim(chain, CREATOR, { ...pool, acc: 0n }, pos, TOKEN);
    expect(empty.blockers.join(' ')).toMatch(/nothing to claim/);
    const claimPool = { ...pool, acc: 1n << 70n };
    const claim = await flow.prepareClaim(chain, CREATOR, claimPool, { ...pos, locked: pos.shares }, TOKEN);
    expect(claim.blockers).toEqual([]);
    state.pool = claimPool;
    state.onSend = () => (state.position = { ...state.position, checkpoint: claimPool.acc, pending: 0n });
    expect((await flow.run(claim)).differences).toEqual([]);
  });
  it('locks, changes the fee recipient, and transfers, then reads each back', async () => {
    const { flow, state } = world();
    live(state);
    const pos = (await flow.loadPosition(chain, TOKEN, CREATOR))!;
    const lock = await flow.prepareLock(chain, CREATOR, pos, TOKEN, 1000n);
    state.onSend = () => (state.position = { ...state.position, locked: 1000n });
    expect((await flow.run(lock)).differences).toEqual([]);
    expect((await flow.prepareLock(chain, CREATOR, pos, TOKEN, pos.shares + 1n)).blockers.join(' ')).toMatch(/not locked yet/);

    const rec = await flow.prepareRecipient(chain, CREATOR, pos, TOKEN, OTHER);
    state.onSend = () => (state.position = { ...state.position, recipient: BigInt(OTHER) });
    expect((await flow.run(rec)).differences).toEqual([]);
    expect((await flow.prepareRecipient(chain, CREATOR, pos, TOKEN, '0x' + '0'.repeat(40))).blockers.join(' ')).toMatch(/wallet address/);

    const tr = await flow.prepareTransfer(chain, CREATOR, pos, TOKEN, OTHER);
    expect(tr.blockers).toEqual([]);
    state.onSend = () => {
      state.other = { ...state.position };
      state.position = { ...state.position, open: false, shares: 0n };
    };
    expect((await flow.run(tr)).differences).toEqual([]);
    state.other = { open: true, shares: 1n, locked: 0n, checkpoint: 0n, pending: 0n, recipient: 0n };
    expect((await flow.prepareTransfer(chain, CREATOR, pos, TOKEN, OTHER)).blockers.join(' ')).toMatch(/already has a position/);
    expect((await flow.prepareTransfer(chain, CREATOR, pos, TOKEN, CREATOR)).blockers.join(' ')).toMatch(/different wallet/);
  });
  it('reports a read-back that does not match what was approved', async () => {
    const { flow, state } = world();
    live(state);
    const pos = (await flow.loadPosition(chain, TOKEN, CREATOR))!;
    const lock = await flow.prepareLock(chain, CREATOR, pos, TOKEN, 1000n);
    state.onSend = () => undefined; // the chain did not change
    expect((await flow.run(lock)).differences.join(' ')).toMatch(/not show the liquidity as locked/);
  });
  it('shows a plain error type', () => {
    expect(new EvmPoolError('x', true).nothingSent).toBe(true);
  });
});
