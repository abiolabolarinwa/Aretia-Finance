/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { SwingsError } from '../swings/core/types.js';
import { createAddress, evmCurveChain, evmDerive, type EvmCurveConfig } from './walletCurveEvmCore';
import { EvmCurveFlow, type EvmCurveFlowDeps } from './walletCurveEvmFlow';
import { CURVE_SEL } from './walletCurveEvmTx';

const ETH = 10n ** 18n;
const CREATOR = '0x00000000000000000000000000000000000c0de1';
const OTHER = '0x00000000000000000000000000000000000b0b01';
const CURVE = '0x2222222222222222222222222222222222222222';
const chain = evmCurveChain('ethereum', { ethereum: CURVE })!;
const TOKEN = createAddress(chain.factory, 4n);
const hex = (n: bigint) => '0x' + n.toString(16);
const w32 = (n: bigint) => n.toString(16).padStart(64, '0');
const str = (s: string) => '0x' + w32(32n) + w32(BigInt(s.length)) + Buffer.from(s).toString('hex').padEnd(64, '0');

const config = (firstBuyWei = 0n, over: Partial<EvmCurveConfig> = {}): EvmCurveConfig => ({
  chain,
  creator: CREATOR,
  token: TOKEN,
  tokenSymbol: 'TST',
  tokenDecimals: 18,
  tokenSupply: 10n ** 27n,
  factoryNonce: 4n,
  totalRaw: 10n ** 27n,
  targetWei: 3n * ETH,
  firstBuyWei,
  derived: evmDerive(10n ** 27n, 3n * ETH)!,
  ...over,
});

/** A scripted chain: just enough state for the flow's reads, and a wallet that records what it was asked to send. */
function world() {
  const state = {
    chainId: 1n,
    curveCode: '0x6080',
    balance: 10n * ETH,
    tokenBalance: 10n ** 27n,
    allowance: 0n,
    curveExists: false,
    factoryNonce: 6n,
    estimateOk: true,
    wallet: CREATOR,
    walletChain: 1,
    reject: false,
    receiptStatus: '0x1',
    wrapped: null as null | { to: string; type: string },
    callOk: true,
    sent: [] as any[],
    onSend: undefined as undefined | ((tx: any) => void),
  };
  const read = async (method: string, params: unknown[]): Promise<unknown> => {
    const p = params as any[];
    if (method === 'eth_chainId') return hex(state.chainId);
    if (method === 'eth_getCode') return p[0] === CURVE ? state.curveCode : '0x6080';
    if (method === 'eth_getBalance') return hex(state.balance);
    if (method === 'eth_getTransactionCount') return hex(state.factoryNonce);
    if (method === 'eth_gasPrice') return hex(20_000_000_000n);
    if (method === 'eth_estimateGas') {
      if (!state.estimateOk) throw new Error('execution reverted');
      return hex(60_000n);
    }
    if (method === 'eth_getTransactionReceipt') return { status: state.receiptStatus };
    if (method === 'eth_getTransactionByHash') return state.wrapped;
    if (method === 'eth_call') {
      const tx = p[0] as { from?: string; to: string; data: string };
      if (!state.callOk && tx.from) throw new Error('execution reverted: slippage');
      if (tx.data.startsWith('0x06fdde03')) return str('Test');
      if (tx.data.startsWith('0x95d89b41')) return str('TST');
      if (tx.data.startsWith('0x313ce567')) return '0x' + w32(18n);
      if (tx.data.startsWith('0x18160ddd')) return '0x' + w32(10n ** 27n);
      if (tx.data.startsWith('0x70a08231')) return '0x' + w32(state.tokenBalance);
      if (tx.data.startsWith(CURVE_SEL.allowance)) return '0x' + w32(state.allowance);
      if (tx.data.startsWith(CURVE_SEL.curves)) {
        const d = evmDerive(10n ** 27n, 3n * ETH)!;
        const words = state.curveExists ? [1n, BigInt(CREATOR), 1_700_000_000n, 0n, 58n, 3n * ETH, d.vSol0, d.curveTokens, d.lpTokens, d.vSol0, d.vTok0, 0n, d.curveTokens] : Array<bigint>(13).fill(0n);
        return '0x' + words.map(w32).join('');
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
  const deps = { adapter, read, now: () => (clock += 60_000), nowSeconds: () => 1_700_000_000, sleep: async () => undefined } as unknown as EvmCurveFlowDeps;
  return { state, flow: new EvmCurveFlow(deps) };
}

describe('loading a token and proving the factory made it', () => {
  it('reads the token and finds the factory nonce from the factory’s own account nonce', async () => {
    const { flow } = world();
    expect(await flow.loadToken(chain, CREATOR, TOKEN)).toMatchObject({ symbol: 'TST', decimals: 18, supply: 10n ** 27n, held: 10n ** 27n, factoryNonce: 4n });
  });
  it('says no nonce for an address the factory did not make, and nothing for no code', async () => {
    const { flow, state } = world();
    expect((await flow.loadToken(chain, CREATOR, '0x3333333333333333333333333333333333333333'))!.factoryNonce).toBeNull();
    state.factoryNonce = 3n; // the factory has not reached nonce 4 yet
    expect((await flow.loadToken(chain, CREATOR, TOKEN))!.factoryNonce).toBeNull();
  });
});

describe('preparing a creation', () => {
  it('has no blockers for a good one, prices the gas, and quotes the first buy exactly', async () => {
    const { flow } = world();
    const r = await flow.prepareCreate(config(ETH));
    expect(r.blockers).toEqual([]);
    expect(r.firstBuy!.gross).toBe(ETH);
    expect(r.minFirstBuyOut).toBe(r.firstBuy!.tokensOut);
    expect(r.gasCostWei).toBe((72_000n + 450_000n) * 20_000_000_000n);
  });
  it('blocks a token the factory did not make, a curve that exists, too few tokens, too little coin, the wrong network, and a missing contract', async () => {
    const { flow, state } = world();
    expect((await flow.prepareCreate(config(0n, { factoryNonce: 5n }))).blockers.join(' ')).toMatch(/not made by Aretia/);
    state.curveExists = true;
    expect((await flow.prepareCreate(config())).blockers.join(' ')).toMatch(/already exists/);
    state.curveExists = false;
    state.tokenBalance = 1n;
    expect((await flow.prepareCreate(config())).blockers.join(' ')).toMatch(/hold fewer TST/);
    state.tokenBalance = 10n ** 27n;
    state.balance = 1_000n;
    expect((await flow.prepareCreate(config())).blockers.join(' ')).toMatch(/need more ETH/);
    state.balance = 10n * ETH;
    state.chainId = 56n;
    expect((await flow.prepareCreate(config())).blockers.join(' ')).toMatch(/right network/);
    state.chainId = 1n;
    state.curveCode = '0x';
    expect((await flow.prepareCreate(config())).blockers.join(' ')).toMatch(/not on this network/);
    state.curveCode = '0x6080';
    state.estimateOk = false;
    expect((await flow.prepareCreate(config())).blockers.join(' ')).toMatch(/would not accept the approval/);
  });
});

describe('sending a creation', () => {
  it('asks the wallet for exactly two transactions, the approval first, and reads the curve back', async () => {
    const { flow, state } = world();
    const review = await flow.prepareCreate(config(ETH));
    state.onSend = (tx) => {
      if (tx.to === TOKEN) state.allowance = 10n ** 27n;
      else state.curveExists = true;
    };
    const steps: string[] = [];
    const out = await flow.create(review, (p) => steps.push(p));
    expect(state.sent.map((t) => t.to)).toEqual([TOKEN, CURVE]);
    expect(state.sent[1].value).toBe(hex(ETH));
    expect(out.hashes).toHaveLength(2);
    expect(steps).toEqual(['checking', 'approving', 'confirming-approve', 'sending', 'confirming', 'verifying', 'done']);
    // The scripted chain shows a curve with the approved numbers, so nothing differs.
    expect(out.differences).toEqual([]);
  });

  it('will not sign anything that is not what was reviewed, and sends nothing', async () => {
    const { flow, state } = world();
    const review = await flow.prepareCreate(config());
    await expect(flow.create({ ...review, approveTx: { ...review.approveTx, to: OTHER } })).rejects.toThrow(/Not signing/);
    await expect(flow.create({ ...review, approveTx: { ...review.approveTx, data: review.approveTx.data!.slice(0, -1) + '1' } })).rejects.toThrow(/Not signing/);
    expect(state.sent).toHaveLength(0);
  });

  it('stops when the approval did not set exactly the allowance, and says the tokens did not move', async () => {
    const { flow, state } = world();
    const review = await flow.prepareCreate(config());
    state.onSend = () => (state.allowance = 5n);
    await expect(flow.create(review)).rejects.toThrow(/allowance is not exactly what you approved/);
    expect(state.sent).toHaveLength(1);
  });

  it('tells the person when the second transaction fails that the approval stays and nothing else happened', async () => {
    const { flow, state } = world();
    const review = await flow.prepareCreate(config());
    state.onSend = (tx) => {
      if (tx.to === TOKEN) state.allowance = 10n ** 27n;
      else state.receiptStatus = '0x0';
    };
    // The receipt of the first transaction must be a success and the second a failure.
    let n = 0;
    const orig = state.sent.push.bind(state.sent);
    state.sent.push = ((...a: any[]) => {
      n++;
      state.receiptStatus = n === 2 ? '0x0' : '0x1';
      return orig(...a);
    }) as typeof state.sent.push;
    await expect(flow.create(review)).rejects.toThrow(/approval is in place for exactly the tokens you chose/);
  });

  it('says so when the wallet wrapped the transaction in its smart-account feature and that failed', async () => {
    const { flow, state } = world();
    const review = await flow.prepareCreate(config());
    state.onSend = (tx) => {
      if (tx.to === TOKEN) state.allowance = 10n ** 27n;
    };
    let n = 0;
    const orig = state.sent.push.bind(state.sent);
    state.sent.push = ((...a: any[]) => {
      n++;
      state.receiptStatus = n === 2 ? '0x0' : '0x1';
      state.wrapped = n === 2 ? { to: '0xdb9b1e94b5b69df7e401ddbede43491141047db3', type: '0x4' } : null;
      return orig(...a);
    }) as typeof state.sent.push;
    await expect(flow.create(review)).rejects.toThrow(/did not send this as the plain transaction[\s\S]*trying again usually works[\s\S]*approval is in place/);
  });

  it('turns a closed wallet into a plain message, a changed account into a refusal, and refuses a review with blockers', async () => {
    const { flow, state } = world();
    const review = await flow.prepareCreate(config());
    state.reject = true;
    await expect(flow.create(review)).rejects.toThrow(/closed the wallet/);
    state.reject = false;
    state.wallet = OTHER;
    await expect(flow.create(review)).rejects.toThrow(/account selected in your wallet changed/);
    state.wallet = CREATOR;
    await expect(flow.create({ ...review, blockers: ['x'] })).rejects.toMatchObject({ nothingSent: true });
    expect(state.sent).toHaveLength(0);
  });

  it('switches the wallet to the right network before sending', async () => {
    const { flow, state } = world();
    const review = await flow.prepareCreate(config());
    state.walletChain = 56;
    state.onSend = (tx) => {
      if (tx.to === TOKEN) state.allowance = 10n ** 27n;
    };
    await flow.create(review).catch(() => undefined);
    expect(state.walletChain).toBe(1);
  });

  it('refuses before sending when the network would refuse, and explains in words', async () => {
    const { flow, state } = world();
    const review = await flow.prepareCreate(config());
    state.callOk = false;
    await expect(flow.create(review)).rejects.toThrow(/would refuse the approval, so nothing was sent: the price moved past the limit/);
    expect(state.sent).toHaveLength(0);
  });
});
