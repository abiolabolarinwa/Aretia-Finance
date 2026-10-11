import { describe, expect, it } from 'vitest';
import { buildEvmTransfer, checkEvmRecipient, maxNativeSend, planEvmSend, sendEvmTransfer, waitForEvmReceipt, type EvmSendRequest } from './walletEvmSend';
import { toChecksumAddress } from '../swings/core/keccak.js';
import { SwingsError } from '../swings/core/types.js';
import type { EvmWalletAdapter } from '../swings/chains/evmWallet.js';

const FROM = '0xd366000000000000000000000000000000007ec2';
const TO = '0x1111111111111111111111111111111111111111';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const hexOf = (n: bigint) => '0x' + n.toString(16);

describe('checkEvmRecipient', () => {
  it('accepts a lower-case or correctly checksummed address and returns the checksummed form', () => {
    expect(checkEvmRecipient(TO, FROM).problem).toBeNull();
    const sum = toChecksumAddress('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359');
    expect(checkEvmRecipient(sum, FROM)).toEqual({ address: sum, problem: null });
  });
  it('rejects a bad checksum, the wrong length, a name, zero, and yourself', () => {
    const sum = toChecksumAddress('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359');
    const i = sum.slice(2).search(/[a-zA-Z]/) + 2;
    const bad = sum.slice(0, i) + (sum[i] === sum[i]!.toUpperCase() ? sum[i]!.toLowerCase() : sum[i]!.toUpperCase()) + sum.slice(i + 1);
    expect(checkEvmRecipient(bad, FROM).problem).toMatch(/checksum/);
    expect(checkEvmRecipient(TO.slice(0, -1), FROM).problem).toMatch(/wrong length/);
    expect(checkEvmRecipient('vitalik.eth', FROM).problem).toMatch(/not supported/);
    expect(checkEvmRecipient('0x' + '0'.repeat(40), FROM).problem).toMatch(/zero address/);
    expect(checkEvmRecipient(FROM.toUpperCase().replace('0X', '0x'), FROM).problem).toMatch(/your own address/);
    expect(checkEvmRecipient('', FROM).problem).toMatch(/Enter/);
  });
});

describe('buildEvmTransfer', () => {
  it('sends native value straight to the recipient', () => {
    expect(buildEvmTransfer({ from: FROM, to: TO, token: null, amountRaw: 1000n })).toEqual({ from: FROM, to: TO, value: '0x3e8' });
  });
  it('calls transfer on the token contract, with no value', () => {
    const tx = buildEvmTransfer({ from: FROM, to: TO, token: USDT, amountRaw: 5n });
    expect(tx.to).toBe(USDT);
    expect(tx.value).toBe('0x0');
    expect(tx.data).toBe('0xa9059cbb' + '1'.repeat(40).padStart(64, '0') + '5'.padStart(64, '0'));
  });
  it('refuses a zero amount', () => expect(() => buildEvmTransfer({ from: FROM, to: TO, token: null, amountRaw: 0n })).toThrow());
});

function node(opts: { native?: bigint; token?: bigint; code?: string; gas?: bigint; price?: bigint; estimateFails?: boolean; down?: boolean } = {}) {
  const calls: string[] = [];
  const read = async (method: string, params: unknown[]): Promise<unknown> => {
    calls.push(method);
    if (opts.down) throw new SwingsError('provider-failed', 'down');
    if (method === 'eth_getBalance') return hexOf(opts.native ?? 10n ** 18n);
    if (method === 'eth_call') return hexOf(opts.token ?? 100_000_000n);
    if (method === 'eth_getCode') return opts.code ?? '0x';
    if (method === 'eth_estimateGas') {
      if (opts.estimateFails) throw new SwingsError('provider-failed', 'execution reverted');
      return hexOf(opts.gas ?? 21_000n);
    }
    if (method === 'eth_gasPrice') return hexOf(opts.price ?? 5_000_000_000n);
    throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
  };
  return { read, calls };
}
const nativeReq: EvmSendRequest = { chain: 'bnb', from: FROM, to: TO, token: null, symbol: 'BNB', decimals: 18, amountText: '0.5' };
const tokenReq: EvmSendRequest = { chain: 'bnb', from: FROM, to: TO, token: USDT, symbol: 'USDT', decimals: 6, amountText: '10' };

describe('planEvmSend', () => {
  it('plans a native send with a gas limit that has a 20% margin and a fee cap', async () => {
    const plan = await planEvmSend(nativeReq, node().read);
    expect(plan.blockers).toEqual([]);
    expect(plan.amountRaw).toBe(5n * 10n ** 17n);
    expect(plan.tx?.gas).toBe(hexOf(25_200n));
    expect(plan.feeWei).toBe(25_200n * 5_000_000_000n);
    expect(plan.recipientIsContract).toBe(false);
  });
  it('plans a token send', async () => {
    const plan = await planEvmSend(tokenReq, node().read);
    expect(plan.blockers).toEqual([]);
    expect(plan.tx?.to).toBe(USDT);
  });
  it('blocks more than the balance, and more than the balance after the fee for the native coin', async () => {
    expect((await planEvmSend({ ...tokenReq, amountText: '101' }, node().read)).blockers[0]).toMatch(/less than 101/);
    const edge = await planEvmSend({ ...nativeReq, amountText: '1' }, node().read); // all 1 BNB, nothing left for the fee
    expect(edge.blockers.join(' ')).toMatch(/more BNB to pay the network fee/);
  });
  it('blocks a token send when there is no native coin for the fee', async () => {
    const plan = await planEvmSend(tokenReq, node({ native: 0n }).read);
    expect(plan.blockers.join(' ')).toMatch(/more BNB/);
    expect(plan.tx).toBeNull();
  });
  it('blocks a transfer the network would reject, with no transaction to send', async () => {
    const plan = await planEvmSend(tokenReq, node({ estimateFails: true }).read);
    expect(plan.blockers[0]).toMatch(/would not accept this transfer: execution reverted/);
    expect(plan.tx).toBeNull();
  });
  it('blocks, rather than passes, when the network cannot be reached', async () => {
    const plan = await planEvmSend(nativeReq, node({ down: true }).read);
    expect(plan.blockers[0]).toMatch(/could not be reached/);
    expect(plan.tx).toBeNull();
  });
  it('asks for an acknowledgement when the recipient is a contract, and blocks sending a token to its own contract', async () => {
    const plan = await planEvmSend(nativeReq, node({ code: '0x6080' }).read);
    expect(plan.recipientIsContract).toBe(true);
    expect(plan.needsAck).toBe(true);
    expect((await planEvmSend({ ...tokenReq, to: USDT }, node().read)).blockers.join(' ')).toMatch(/contract itself/);
  });
  it('rejects bad amounts without touching the network', async () => {
    const n = node();
    expect((await planEvmSend({ ...tokenReq, amountText: '0.0000001' }, n.read)).blockers[0]).toMatch(/at most 6 decimal/);
    expect((await planEvmSend({ ...tokenReq, amountText: '0' }, n.read)).blockers[0]).toMatch(/more than zero/);
  });
});

describe('maxNativeSend', () => {
  it('leaves room for the fee and never goes negative', () => {
    expect(maxNativeSend(100n, 30n)).toBe(70n);
    expect(maxNativeSend(20n, 30n)).toBe(0n);
  });
});

describe('waitForEvmReceipt', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };
  it('reports confirmed, failed, and pending (never failed for an unanswered node)', async () => {
    let n = 0;
    expect(await waitForEvmReceipt(async () => (++n < 3 ? null : { status: '0x1' }), '0xh', clock())).toBe('confirmed');
    expect(await waitForEvmReceipt(async () => ({ status: '0x0' }), '0xh', clock())).toBe('failed');
    expect(await waitForEvmReceipt(async () => { throw new Error('403'); }, '0xh', { ...clock(), timeoutMs: 10_000 })).toBe('pending');
  });
});

describe('sendEvmTransfer', () => {
  const adapter = (over: Partial<EvmWalletAdapter> = {}) => {
    const log: string[] = [];
    const a = {
      getAccounts: async () => [FROM],
      getChainId: async () => 1,
      switchChain: async (id: number) => void log.push(`switch ${id}`),
      sendTransaction: async () => (log.push('send'), '0x' + 'a'.repeat(64)),
      ...over,
    } as unknown as EvmWalletAdapter;
    return { a, log };
  };
  it('switches to the right network, then sends', async () => {
    const plan = await planEvmSend(nativeReq, node().read);
    const { a, log } = adapter();
    expect(await sendEvmTransfer(plan, a)).toMatch(/^0xa+$/);
    expect(log).toEqual(['switch 56', 'send']);
  });
  it('does not switch when already on the network, and refuses when the account changed or the plan is blocked', async () => {
    const plan = await planEvmSend(nativeReq, node().read);
    const same = adapter({ getChainId: async () => 56 });
    await sendEvmTransfer(plan, same.a);
    expect(same.log).toEqual(['send']);
    await expect(sendEvmTransfer(plan, adapter({ getAccounts: async () => ['0x' + '2'.repeat(40)] }).a)).rejects.toThrow(/account selected in your wallet changed/);
    const blocked = await planEvmSend({ ...nativeReq, amountText: '5' }, node().read);
    await expect(sendEvmTransfer(blocked, adapter().a)).rejects.toThrow(/did not pass its checks/);
  });
});

describe('the build flag', () => {
  it('shows the network box only on builds with PUBLIC_PAY_EVM_SEND=1', async () => {
    const { readFileSync } = await import('node:fs');
    const page = readFileSync(new URL('../pages/wallet/index.astro', import.meta.url), 'utf8');
    const at = page.indexOf('data-send-network');
    expect(at).toBeGreaterThan(-1);
    expect(page.slice(page.lastIndexOf('{evmSendOn', at), at)).toContain('{evmSendOn && (');
    expect(page).toContain("import.meta.env.PUBLIC_PAY_EVM_SEND === '1'");
  });
});
