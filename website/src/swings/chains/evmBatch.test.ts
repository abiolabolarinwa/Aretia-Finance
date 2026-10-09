import { describe, expect, it, vi } from 'vitest';
import { EvmChainAdapter } from './evm.js';
import { Eip1193WalletAdapter, type EvmTxRequest, type EvmWalletAdapter } from './evmWallet.js';
import { SwingsError, type PreparedSwap } from '../core/types.js';

const USER = '0x' + '1'.repeat(40);
const TOKEN = '0x' + '2'.repeat(40);
const ROUTER = '0x' + '3'.repeat(40);
const FEE_TO = '0x' + '9'.repeat(40);
const HASH = '0x' + 'ab'.repeat(32);
const sim = { ok: true, blockers: [], warnings: [] };

const prepared = (quoteId = 'q'): PreparedSwap => ({
  quoteId,
  chain: 'ethereum',
  simulation: sim,
  preparedAt: 0,
  payload: {
    chainId: 1,
    taker: USER,
    approval: { tx: { from: USER, to: TOKEN, data: '0xapprove' }, token: TOKEN, spender: ROUTER, amount: 1n },
    fee: { tx: { from: USER, to: TOKEN, data: '0xfee' }, token: TOKEN, amount: 29n, recipient: FEE_TO },
    swap: { from: USER, to: ROUTER, data: '0xswap', value: '0x0' },
  },
});

function wallet(over: Partial<EvmWalletAdapter> = {}) {
  const w = {
    singles: [] as EvmTxRequest[],
    batches: [] as EvmTxRequest[][],
    connect: async () => [USER],
    disconnect: async () => {},
    getAccounts: async () => [USER],
    getChainId: async () => 1,
    switchChain: vi.fn(async () => {}),
    signTransaction: async () => '0x',
    sendTransaction: async (tx: EvmTxRequest) => {
      w.singles.push(tx);
      return HASH;
    },
    signMessage: async () => '0x',
    request: async (m: string) => (m === 'eth_getTransactionReceipt' ? { status: '0x1' } : '0x'),
    ...over,
  };
  return w;
}

describe('one confirmation for approval, fee and swap', () => {
  it('sends the three as one batch, in order, when the wallet can batch', async () => {
    const w = wallet({
      supportsBatch: async () => true,
      sendBatch: async (_c: number, _a: string, calls: EvmTxRequest[]) => {
        w.batches.push(calls);
        return HASH;
      },
    });
    const out = await new EvmChainAdapter('ethereum', w, { pollMs: 1 }).signAndSubmit(prepared());
    expect(out).toBe(HASH);
    expect(w.singles).toHaveLength(0);
    expect(w.batches).toHaveLength(1);
    expect(w.batches[0]!.map((c) => c.data)).toEqual(['0xapprove', '0xfee', '0xswap']);
  });

  it('goes one at a time when the wallet cannot batch, and when it says it can but then cannot', async () => {
    const plain = wallet();
    await new EvmChainAdapter('ethereum', plain, { pollMs: 1 }).signAndSubmit(prepared());
    expect(plain.singles.map((c) => c.data)).toEqual(['0xapprove', '0xfee', '0xswap']);
    const liar = wallet({
      supportsBatch: async () => true,
      sendBatch: async () => {
        throw new SwingsError('not-enabled', 'no');
      },
    });
    await new EvmChainAdapter('ethereum', liar, { pollMs: 1 }).signAndSubmit(prepared());
    expect(liar.singles.map((c) => c.data)).toEqual(['0xapprove', '0xfee', '0xswap']);
  });

  it('does not ask again when the person declines the batch, and lets them try again', async () => {
    let n = 0;
    const w = wallet({
      supportsBatch: async () => true,
      sendBatch: async () => {
        if (n++ === 0) throw new SwingsError('rejected', 'declined');
        return HASH;
      },
    });
    const a = new EvmChainAdapter('ethereum', w, { pollMs: 1 });
    await expect(a.signAndSubmit(prepared())).rejects.toMatchObject({ code: 'rejected' });
    expect(w.singles).toHaveLength(0);
    await expect(a.signAndSubmit(prepared())).resolves.toBe(HASH);
  });

  it('never repeats a batch that failed after it was sent', async () => {
    const w = wallet({
      supportsBatch: async () => true,
      sendBatch: async () => {
        throw new SwingsError('failed', 'reverted');
      },
    });
    await expect(new EvmChainAdapter('ethereum', w, { pollMs: 1 }).signAndSubmit(prepared())).rejects.toMatchObject({ code: 'failed' });
    expect(w.singles).toHaveLength(0);
  });
});

describe('EIP-5792 over a plain provider', () => {
  const provider = (answers: Record<string, unknown>) => ({
    calls: [] as { method: string; params?: unknown[] }[],
    async request(a: { method: string; params?: unknown[] }): Promise<unknown> {
      this.calls.push(a);
      const r = answers[a.method];
      if (r instanceof Error) throw r;
      return typeof r === 'function' ? (r as (p?: unknown[]) => unknown)(a.params) : r;
    },
  });

  it('reads the wallet\'s capability and only trusts "supported" or "ready"', async () => {
    const yes = new Eip1193WalletAdapter(provider({ wallet_getCapabilities: { '0x1': { atomic: { status: 'ready' } } } }));
    const no = new Eip1193WalletAdapter(provider({ wallet_getCapabilities: { '0x1': { atomic: { status: 'unsupported' } } } }));
    const none = new Eip1193WalletAdapter(provider({ wallet_getCapabilities: new Error('method not found') }));
    expect(await yes.supportsBatch(1, USER)).toBe(true);
    expect(await no.supportsBatch(1, USER)).toBe(false);
    expect(await none.supportsBatch(1, USER)).toBe(false);
  });

  it('asks for an all-or-nothing batch and returns the last transaction once confirmed', async () => {
    const p = provider({ wallet_sendCalls: { id: 'abc' }, wallet_getCallsStatus: { status: 200, receipts: [{ transactionHash: '0x' + '11'.repeat(32), status: '0x1' }, { transactionHash: HASH, status: '0x1' }] } });
    const hash = await new Eip1193WalletAdapter(p).sendBatch(1, USER, [{ from: USER, to: TOKEN, data: '0xaa' }, { from: USER, to: ROUTER, data: '0xbb', value: '0x5' }]);
    expect(hash).toBe(HASH);
    const sent = p.calls.find((c) => c.method === 'wallet_sendCalls')!.params![0] as { atomicRequired: boolean; chainId: string; calls: { to: string; value: string }[] };
    expect(sent).toMatchObject({ atomicRequired: true, chainId: '0x1' });
    expect(sent.calls.map((c) => c.value)).toEqual(['0x0', '0x5']);
  });

  it('maps a declined prompt to "rejected", a missing method to "not-enabled", and a failed batch to "failed"', async () => {
    const declined = Object.assign(new Error('no'), { code: 4001 });
    await expect(new Eip1193WalletAdapter(provider({ wallet_sendCalls: declined })).sendBatch(1, USER, [])).rejects.toMatchObject({ code: 'rejected' });
    await expect(new Eip1193WalletAdapter(provider({ wallet_sendCalls: new Error('nope') })).sendBatch(1, USER, [])).rejects.toMatchObject({ code: 'not-enabled' });
    await expect(new Eip1193WalletAdapter(provider({ wallet_sendCalls: 'id1', wallet_getCallsStatus: { status: 500 } })).sendBatch(1, USER, [])).rejects.toMatchObject({ code: 'failed' });
  });
});
