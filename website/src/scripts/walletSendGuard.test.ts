import * as web3 from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendConfirmDisabled, sendRecipientGuard } from './walletSendGuard.js';
import { planSend, sendPlanChanged, U64_MAX, type SendPlan } from './walletSend.js';
import { TOKEN_PROGRAM_ID, transferCheckedInstruction } from './walletTools.js';
import { AddressBook } from '../swings/shield/addressBook.js';

const ME = '0x' + '1'.repeat(40);
const FRIEND = '0xabc1' + '2'.repeat(32) + 'de9f';
const POISON = '0xabc1' + '7'.repeat(32) + 'de9f'; // same ends, different middle

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe('L-24: EVM Send runs Shield\'s guard and remembers where it sent', () => {
  it('a copy-cat of an address sent to before needs the acknowledgement, and Confirm stays disabled until it is ticked', () => {
    const book = new AddressBook(memory(), ME);
    book.rememberSent(FRIEND.toUpperCase().replace('0X', '0x')); // checksummed or not, it is the same address
    const guard = sendRecipientGuard(POISON, book.list(), ME);
    expect(guard.needsAck).toBe(true);
    expect(guard.findings[0]!.id).toBe('lookalike');
    const base = { canGo: true, busy: false, needsAck: false, ack: false, guard };
    expect(sendConfirmDisabled({ ...base, guardAck: false })).toBe(true);
    expect(sendConfirmDisabled({ ...base, guardAck: true })).toBe(false);
  });

  it('an address sent to before is recognised whatever its letter case; a new one is a first time with no box', () => {
    const book = new AddressBook(memory(), ME);
    book.rememberSent(FRIEND);
    expect(sendRecipientGuard(FRIEND.toUpperCase().replace('0X', '0x'), book.list(), ME).findings[0]!.id).toBe('sent-before');
    const first = sendRecipientGuard('0x' + '9'.repeat(40), book.list(), ME);
    expect(first.findings[0]!.id).toBe('first-time');
    expect(first.needsAck).toBe(false);
    expect(sendRecipientGuard(ME.toUpperCase().replace('0X', '0x'), book.list(), ME).findings[0]!.id).toBe('own');
  });

  it('the other gates still apply', () => {
    const ok = { canGo: true, busy: false, needsAck: false, ack: false, guard: null, guardAck: false };
    expect(sendConfirmDisabled(ok)).toBe(false);
    expect(sendConfirmDisabled({ ...ok, canGo: false })).toBe(true);
    expect(sendConfirmDisabled({ ...ok, busy: true })).toBe(true);
    expect(sendConfirmDisabled({ ...ok, needsAck: true })).toBe(true);
  });
});

describe('I-26: Solana Send', () => {
  it('u64 encoding wraps silently above 2^64 - 1, which is why planSend refuses such an amount', () => {
    const a = web3.Keypair.generate().publicKey.toBase58();
    const wrapped = transferCheckedInstruction(web3, TOKEN_PROGRAM_ID, a, a, a, a, U64_MAX + 2n, 6);
    expect(new DataView(Uint8Array.from(wrapped.data).buffer).getBigUint64(1, true)).toBe(1n);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('planSend refuses an amount above 2^64 - 1 before any transaction is built, even if the balance looked large enough', async () => {
    const from = web3.Keypair.generate().publicKey.toBase58();
    const to = web3.Keypair.generate().publicKey.toBase58();
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const { method } = JSON.parse(String(init.body)) as { method: string };
      const result = method === 'getAccountInfo' ? { value: { lamports: Number.MAX_SAFE_INTEGER, owner: '11111111111111111111111111111111', executable: false, data: ['', 'base64'] } } : { value: { blockhash: from, lastValidBlockHeight: 1 } };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
    const p = await planSend({ from, to, mint: null, symbol: 'SOL', amountText: '18446744073.709551617' });
    expect(p.blockers).toContainEqual(expect.stringMatching(/larger than a Solana transfer can carry/));
    expect(p.transaction).toBeNull();
  });

  const plan = (over: Partial<SendPlan> = {}): SendPlan => ({ from: 'A', to: 'B', symbol: 'X', mint: 'M', decimals: 6, amountRaw: 5n, amountText: '0.000005', tokenProgram: 'T', destAta: 'D', createsDestAta: false, mayCharge: false, feeLamports: 5000n, rentLamports: 0n, recipient: {} as never, blockers: [], needsAck: false, transaction: null, ...over });

  it('a re-plan that now opens the recipient\'s token account (rent) is reported, so the review is shown again', () => {
    expect(sendPlanChanged(plan(), plan())).toEqual([]);
    expect(sendPlanChanged(plan(), plan({ createsDestAta: true, rentLamports: 2_039_280n }))).toEqual([expect.stringMatching(/opens the recipient's token account/)]);
    expect(sendPlanChanged(plan(), plan({ amountRaw: 6n }))).toEqual(['the amount']);
    expect(sendPlanChanged(plan(), plan({ needsAck: true }))).toEqual(['what you need to acknowledge']);
    expect(sendPlanChanged(plan(), plan({ destAta: 'E' }))).toEqual(['the destination']);
  });
});
