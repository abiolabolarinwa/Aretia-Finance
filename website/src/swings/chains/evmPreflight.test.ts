import { describe, expect, it, vi } from 'vitest';
import { EvmChainAdapter } from './evm.js';
import type { EvmTxRequest, EvmWalletAdapter } from './evmWallet.js';
import { type PreparedSwap } from '../core/types.js';

// F-21: on a wallet that cannot batch, the Aretia fee is its own transaction sent BEFORE the swap. Both the swap and the fee
// transfer must be simulated first, so a swap that would revert never follows a fee that was already paid.

const USER = '0x' + '1'.repeat(40);
const TOKEN = '0x' + '2'.repeat(40);
const ROUTER = '0x' + '3'.repeat(40);
const FEE_TO = '0x' + '9'.repeat(40);
const HASH = '0x' + 'ab'.repeat(32);
const sim = { ok: true, blockers: [], warnings: [] };
const FEE_TX: EvmTxRequest = { from: USER, to: TOKEN, data: '0xfee' };
const SWAP_TX: EvmTxRequest = { from: USER, to: ROUTER, data: '0xswap', value: '0x0' };

const prepared = (opts: { approval?: boolean; fee?: boolean; quoteId?: string } = {}): PreparedSwap => ({
  quoteId: opts.quoteId ?? 'q',
  chain: 'ethereum',
  simulation: sim,
  preparedAt: 0,
  payload: {
    chainId: 1,
    taker: USER,
    approval: opts.approval === false ? null : { tx: { from: USER, to: TOKEN, data: '0xapprove' }, token: TOKEN, spender: ROUTER, amount: 1n },
    fee: opts.fee === false ? null : { tx: FEE_TX, token: TOKEN, amount: 29n, recipient: FEE_TO },
    swap: SWAP_TX,
  },
});

type CallFn = (tx: EvmTxRequest) => string | Promise<string>;

/** A wallet that cannot batch. `events` records the order of sends and eth_calls. */
function setup(callImpl: CallFn = () => '0x') {
  const events: string[] = [];
  const w: EvmWalletAdapter & { sends: EvmTxRequest[] } = {
    sends: [],
    connect: async () => [USER],
    disconnect: async () => {},
    getAccounts: async () => [USER],
    getChainId: async () => 1,
    switchChain: vi.fn(async () => {}),
    signTransaction: async () => '0x',
    sendTransaction: async (tx: EvmTxRequest) => {
      w.sends.push(tx);
      events.push(`send:${tx.data}`);
      return HASH;
    },
    signMessage: async () => '0x',
    request: async (m: string, params: unknown[] = []) => {
      if (m === 'eth_getTransactionReceipt') return { status: '0x1' };
      if (m === 'eth_call') {
        const tx = params[0] as EvmTxRequest;
        events.push(`call:${tx.data}`);
        return callImpl(tx);
      }
      return '0x';
    },
  };
  return { w, events };
}

describe('simulating before the fee is sent (wallets that cannot batch)', () => {
  it('simulates the swap and the fee transfer, from the taker, before the fee is sent', async () => {
    const { w, events } = setup();
    await new EvmChainAdapter('ethereum', w, { pollMs: 1 }).signAndSubmit(prepared());
    expect(events.indexOf('call:0xswap')).toBeGreaterThan(events.indexOf('send:0xapprove'));
    expect(events.indexOf('call:0xswap')).toBeLessThan(events.indexOf('send:0xfee'));
    expect(events.indexOf('call:0xfee')).toBeLessThan(events.indexOf('send:0xfee'));
    expect(events.filter((e) => e.startsWith('send:'))).toEqual(['send:0xapprove', 'send:0xfee', 'send:0xswap']);
  });

  it('sends nothing but the approval when the swap would revert, and says no fee was taken', async () => {
    const { w } = setup((tx) => {
      if (tx.data === '0xswap') throw new Error('execution reverted: TRANSFER_FAILED');
      return '0x';
    });
    const a = new EvmChainAdapter('ethereum', w, { pollMs: 1 });
    await expect(a.signAndSubmit(prepared())).rejects.toMatchObject({ code: 'simulation-failed', message: expect.stringMatching(/swap.*no Aretia fee was taken/s) });
    expect(w.sends.map((t) => t.data)).toEqual(['0xapprove']);
  });

  it('sends nothing but the approval when the token refuses the fee transfer', async () => {
    const { w } = setup((tx) => {
      if (tx.data === '0xfee') throw new Error('execution reverted: blacklisted');
      return '0x';
    });
    await expect(new EvmChainAdapter('ethereum', w, { pollMs: 1 }).signAndSubmit(prepared())).rejects.toMatchObject({ code: 'simulation-failed', message: expect.stringMatching(/fee transfer/) });
    expect(w.sends.map((t) => t.data)).toEqual(['0xapprove']);
  });

  it('simulates before the fee even when no approval is needed, so nothing at all is sent', async () => {
    const { w } = setup((tx) => {
      if (tx.data === '0xswap') throw new Error('execution reverted');
      return '0x';
    });
    await expect(new EvmChainAdapter('ethereum', w, { pollMs: 1 }).signAndSubmit(prepared({ approval: false }))).rejects.toMatchObject({ code: 'simulation-failed' });
    expect(w.sends).toHaveLength(0);
  });

  it('fails closed when no node can answer the simulation: nothing is sent', async () => {
    const { w } = setup(() => {
      throw new Error('network down');
    });
    await expect(new EvmChainAdapter('ethereum', w, { pollMs: 1 }).signAndSubmit(prepared({ approval: false }))).rejects.toMatchObject({ code: 'simulation-failed' });
    expect(w.sends).toHaveLength(0);
  });

  it('allows the same quote to be tried again after a failed simulation, and never pays the fee twice', async () => {
    let broken = true;
    const { w } = setup((tx) => {
      if (broken && tx.data === '0xswap') throw new Error('execution reverted');
      return '0x';
    });
    const a = new EvmChainAdapter('ethereum', w, { pollMs: 1 });
    await expect(a.signAndSubmit(prepared({ approval: false }))).rejects.toMatchObject({ code: 'simulation-failed' });
    broken = false;
    await a.signAndSubmit(prepared({ approval: false }));
    expect(w.sends.map((t) => t.data)).toEqual(['0xfee', '0xswap']);
  });

  it('reads through the chain read node first when one is given', async () => {
    const read = vi.fn(async (...args: unknown[]) => (args[0] === 'eth_getTransactionReceipt' ? { status: '0x1' } : '0x'));
    const { w } = setup(() => {
      throw new Error('the wallet node must not be needed');
    });
    await new EvmChainAdapter('ethereum', w, { pollMs: 1, read }).signAndSubmit(prepared({ approval: false }));
    const calls = read.mock.calls.filter((c) => c[0] === 'eth_call').map((c) => ((c as unknown[])[1] as [EvmTxRequest, string])[0].data);
    expect(calls).toEqual(expect.arrayContaining(['0xswap', '0xfee']));
    expect(w.sends.map((t) => t.data)).toEqual(['0xfee', '0xswap']);
  });

  it('does not add a simulation step to a swap that carries no fee', async () => {
    const { w, events } = setup();
    await new EvmChainAdapter('ethereum', w, { pollMs: 1 }).signAndSubmit(prepared({ approval: false, fee: false }));
    expect(events.filter((e) => e.startsWith('call:'))).toHaveLength(0);
    expect(w.sends.map((t) => t.data)).toEqual(['0xswap']);
  });
});
