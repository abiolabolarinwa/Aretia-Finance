import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as web3 from '@solana/web3.js';
import { handleSubmit, type SubmitInput } from './_swingsSubmit';
import { resetRateLimit } from './_rpcProxy';
import { JITO_SEND_URL, JITO_TIP_ACCOUNTS } from '../src/swings/solana/jito';

const ORIGIN = 'https://aretiafinance.org';
const payer = web3.Keypair.generate();
const SIG = '5'.repeat(88);

function signed(opts: { tip?: number | null; tipTo?: string; tipFrom?: web3.PublicKey; sign?: boolean } = {}): string {
  const ixs: web3.TransactionInstruction[] = [web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: web3.Keypair.generate().publicKey, lamports: 1 })];
  const tip = opts.tip === undefined ? 10_000 : opts.tip;
  if (tip !== null) ixs.push(web3.SystemProgram.transfer({ fromPubkey: opts.tipFrom ?? payer.publicKey, toPubkey: new web3.PublicKey(opts.tipTo ?? JITO_TIP_ACCOUNTS[0]!), lamports: tip }));
  const t = new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: web3.PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message());
  if (opts.sign !== false) t.sign([payer]);
  return Buffer.from(t.serialize()).toString('base64');
}

const input = (over: Partial<SubmitInput> & { tx?: string } = {}): SubmitInput => {
  const { tx, ...rest } = over;
  return {
    method: 'POST',
    origin: ORIGIN,
    ip: '1.2.3.4',
    contentType: 'application/json',
    body: JSON.stringify({ transaction: tx ?? signed() }),
    env: { SWINGS_PROTECTED_SUBMIT: 'on' } as never,
    fetchImpl: vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: SIG }), { status: 200 })) as unknown as typeof fetch,
    now: 1_000,
    ...rest,
  };
};
const calls = (i: SubmitInput): number => (i.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

describe('protected submission relay', () => {
  beforeEach(() => resetRateLimit());

  it('forwards a signed, tipped transaction to Jito, bundle-only, and returns the signature', async () => {
    const i = input();
    const out = await handleSubmit(i);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ signature: SIG });
    const [url, init] = (i.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(JITO_SEND_URL);
    expect(url).toContain('bundleOnly=true');
    expect(JSON.parse(init.body as string)).toMatchObject({ method: 'sendTransaction', params: [expect.any(String), { encoding: 'base64' }] });
  });

  it('is off unless switched on, and only answers the Aretia origin', async () => {
    const off = input({ env: {} as never });
    expect((await handleSubmit(off)).status).toBe(503);
    expect(calls(off)).toBe(0);
    expect((await handleSubmit(input({ origin: 'https://evil.example' }))).status).toBe(403);
    expect((await handleSubmit(input({ method: 'GET' }))).status).toBe(405);
    expect((await handleSubmit(input({ method: 'OPTIONS' }))).status).toBe(204);
  });

  it('refuses anything that is not a signed, correctly tipped swap, and sends nothing', async () => {
    const cases: [string, Partial<SubmitInput> & { tx?: string }, string][] = [
      ['unsigned', { tx: signed({ sign: false }) }, 'unsigned'],
      ['no tip at all (a free relay)', { tx: signed({ tip: null }) }, 'no-tip'],
      ['tip below the floor', { tx: signed({ tip: 10 }) }, 'tip-range'],
      ['tip above the cap', { tx: signed({ tip: 5_000_000 }) }, 'tip-range'],
      ['tip paid by someone else', { tx: signed({ tipFrom: web3.Keypair.generate().publicKey, sign: false }) }, 'unsigned'],
      ['not base64', { body: JSON.stringify({ transaction: 'not base64 !!' }) }, 'shape'],
      ['not json', { body: 'nope' }, 'json'],
      ['garbage bytes', { tx: Buffer.from('hello world').toString('base64') }, 'transaction'],
      ['wrong content type', { contentType: 'text/html' }, 'content-type'],
    ];
    for (const [label, over, error] of cases) {
      const i = input(over);
      const out = await handleSubmit(i);
      expect(JSON.parse(out.body).error, label).toBe(error);
      expect(calls(i), label).toBe(0);
    }
  });

  it('refuses a tip paid by an account other than the signer (a signed transaction that makes someone else pay)', async () => {
    const stranger = web3.Keypair.generate();
    const ixs = [web3.SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: new web3.PublicKey(JITO_TIP_ACCOUNTS[0]!), lamports: 10_000 })];
    const t = new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: web3.PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message());
    t.sign([payer, stranger]);
    const i = input({ tx: Buffer.from(t.serialize()).toString('base64') });
    expect(JSON.parse((await handleSubmit(i)).body).error).toBe('tip-payer');
    expect(calls(i)).toBe(0);
  });

  it('reports a relay that fails or answers nonsense as 502, never as success', async () => {
    const down = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    const nonsense = (async () => new Response(JSON.stringify({ result: 'not a signature' }), { status: 200 })) as unknown as typeof fetch;
    const throws = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    for (const f of [down, nonsense, throws]) expect((await handleSubmit(input({ fetchImpl: f }))).status).toBe(502);
  });

  it('is rate limited per caller and size limited', async () => {
    let last = 0;
    for (let i = 0; i < 125; i++) last = (await handleSubmit(input())).status;
    expect(last).toBe(429);
    expect((await handleSubmit(input({ ip: '8.8.8.8', body: 'x'.repeat(5000) }))).status).toBe(413);
  });
});
