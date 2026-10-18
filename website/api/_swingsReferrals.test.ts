import { beforeEach, describe, expect, it } from 'vitest';
import { PUBLIC_EVM_RPC } from '../src/swings/chains/evmSession.js';
import { SWAP_FEE_WALLET } from '../src/scripts/walletTools.js';
import { resetRateLimit } from './_rpcProxy.js';
import { issueSession } from './_swingsAuth.js';
import { handleReferrals, type ReferralsInput } from './_swingsReferrals.js';
import { DEFAULT_EVM_FEE_ADDRESS, EVM_READ_RPC } from './_referralVerify.js';

const NOW = 1_800_000_000_000;
const KEY = 'service-key-for-tests';
const ORIGIN = 'https://aretiafinance.org';
const FEE = DEFAULT_EVM_FEE_ADDRESS;
const TRADER = '0x' + '1'.repeat(40);
const REFERRER = '0x' + '2'.repeat(40);
const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const HASH = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const pad = (a: string) => '0x' + a.replace('0x', '').padStart(64, '0');
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SOL_TRADER = '3'.repeat(1) + 'Bq9yNGK5WbGpkT1DnBL8nPSCsEdXPC9aVzYcMGzTvEeU';
const SOL_REF = '4Nd1mBQtrMJVYVfKGkqmKMo8WhEKUuf3fEdSm7X1E6SG';
const SIG = '5' + 'j'.repeat(86);

/** An in-memory stand-in for the three referral tables, answering just the PostgREST calls the handler makes. */
function fakeWorld(opts: { evmTx?: Record<string, { from: string; to: string; value?: string; logs?: unknown[]; status?: string; blockTime?: number; pending?: boolean }>; solTx?: Record<string, unknown> } = {}) {
  const bindings: Record<string, string | number>[] = [];
  const credits: Record<string, string | number>[] = [];
  const revocations: Record<string, string | number>[] = [];
  const calls: string[] = [];
  const table = (name: string) => (name === 'referral_bindings' ? bindings : name === 'referral_credits' ? credits : revocations);
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('/rest/v1/')) {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      const [path, query = ''] = url.split('/rest/v1/')[1]!.split('?');
      const rows = table(path!);
      const params = new URLSearchParams(query);
      if (init?.method === 'POST') {
        const row = JSON.parse(String(init.body)) as Record<string, string | number>;
        const keyOf = path === 'referral_credits' ? ['chain', 'tx', 'asset'] : ['trader'];
        const dup = rows.some((r) => keyOf.every((k) => r[k] === row[k]));
        if (!dup) rows.push(row);
        return ok(dup ? [] : [row], 201);
      }
      let out = rows.filter((r) =>
        [...params.entries()].every(([k, v]) => {
          if (v.startsWith('eq.')) return String(r[k]) === v.slice(3);
          if (v.startsWith('gte.')) return Number(r[k]) >= Number(v.slice(4));
          if (k === 'or') {
            const m = /^\(referrer\.eq\.(.+),trader\.eq\.(.+)\)$/.exec(v)!;
            return r.referrer === m[1] || r.trader === m[2];
          }
          return true;
        }),
      );
      out = out.slice(0, 5000);
      return ok(out);
    }
    // chain nodes
    const req = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const reply = (result: unknown) => ok({ jsonrpc: '2.0', id: 1, result });
    if (req.method === 'getTransaction') return reply(opts.solTx?.[String(req.params[0])] ?? null);
    const hash = String(req.params[0]);
    const t = opts.evmTx?.[hash];
    if (req.method === 'eth_getTransactionByHash') return reply(t && !t.pending ? { from: t.from, to: t.to, value: t.value ?? '0x0' } : null);
    if (req.method === 'eth_getTransactionReceipt') return reply(t && !t.pending ? { status: t.status ?? '0x1', blockNumber: '0x10', logs: t.logs ?? [] } : null);
    if (req.method === 'eth_getBlockByNumber') return reply({ timestamp: '0x' + Math.floor(((Object.values(opts.evmTx ?? {})[0]?.blockTime ?? NOW) as number) / 1000).toString(16) });
    return reply(null);
  }) as unknown as typeof fetch;
  return { bindings, credits, revocations, calls, fetchImpl };
}

interface Reply {
  credited?: number;
  reason?: string;
  results: { tx: string; result: string }[];
  revoked?: boolean;
  traders?: number;
  notCounted: { capped: number };
  totals: unknown[];
}

const session = (owner: string, now = NOW) => `Bearer ${issueSession(KEY, owner, now).token}`;
const feeLog = (token: string, from: string, amount: bigint) => ({ address: token, topics: [TRANSFER, pad(from), pad(FEE)], data: '0x' + amount.toString(16).padStart(64, '0') });

function call(world: ReturnType<typeof fakeWorld>, body: unknown, over: Partial<ReferralsInput> & { as?: string } = {}) {
  return handleReferrals({ method: 'POST', origin: ORIGIN, authorization: session(over.as ?? `evm:${TRADER}`), ip: '1.1.1.1', body, env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: KEY }, fetchImpl: world.fetchImpl, now: NOW, ...over }).then((r) => ({ status: r.status, data: JSON.parse(r.body || '{}') as Reply }));
}

beforeEach(() => resetRateLimit());

describe('the api door', () => {
  it('refuses other origins, wrong methods, a missing database and a missing or forged session', async () => {
    const w = fakeWorld();
    expect((await call(w, { op: 'mine' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call(w, { op: 'mine' }, { method: 'GET' })).status).toBe(405);
    expect((await call(w, { op: 'mine' }, { env: {} })).status).toBe(503);
    expect((await call(w, { op: 'mine' }, { authorization: null })).status).toBe(401);
    expect((await call(w, { op: 'mine' }, { authorization: 'Bearer v1.abc.def' })).status).toBe(401);
    expect((await call(w, { op: 'nope' })).status).toBe(400);
  });
  it('uses the same node addresses as the page', () => {
    expect(EVM_READ_RPC).toEqual(PUBLIC_EVM_RPC);
  });
});

describe('recording a swap on an EVM chain', () => {
  const swap = (over: Record<string, unknown> = {}) => ({ from: TRADER, to: USDC_ETH, logs: [feeLog(USDC_ETH, TRADER, 5_800_000n)], blockTime: NOW - 60_000, ...over });

  it('credits the referrer with 20% of the fee it read from the chain, not what the browser said', async () => {
    const w = fakeWorld({ evmTx: { [HASH(1)]: swap() } });
    const r = await call(w, { op: 'record', ref: REFERRER, chain: 'ethereum', txs: [HASH(1)], fee: '999999999999' });
    expect(r.status).toBe(200);
    expect(r.data.credited).toBe(1);
    expect(w.credits).toHaveLength(1);
    expect(w.credits[0]).toMatchObject({ chain: 'ethereum', asset: USDC_ETH, trader: `evm:${TRADER}`, referrer: `evm:${REFERRER}`, fee_raw: '5800000', share_raw: '1160000', status: 'credited' });
    expect(w.bindings[0]).toMatchObject({ trader: `evm:${TRADER}`, referrer: `evm:${REFERRER}` });
  });

  it('credits a native-coin fee paid straight to the fee address', async () => {
    const w = fakeWorld({ evmTx: { [HASH(2)]: { from: TRADER, to: FEE, value: '0x' + (5n * 10n ** 15n).toString(16), blockTime: NOW - 1000 } } });
    await call(w, { op: 'record', ref: REFERRER, chain: 'bnb', txs: [HASH(2)] });
    expect(w.credits[0]).toMatchObject({ asset: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', fee_raw: '5000000000000000', share_raw: '1000000000000000' });
  });

  it('credits the same payment only once', async () => {
    const w = fakeWorld({ evmTx: { [HASH(1)]: swap() } });
    await call(w, { op: 'record', ref: REFERRER, chain: 'ethereum', txs: [HASH(1)] });
    const again = await call(w, { op: 'record', chain: 'ethereum', txs: [HASH(1)] });
    expect(again.data.credited).toBe(0);
    expect(again.data.results[0].result).toBe('already-recorded');
    expect(w.credits).toHaveLength(1);
  });

  it('keeps the first referrer, whatever a later request names', async () => {
    const w = fakeWorld({ evmTx: { [HASH(1)]: swap(), [HASH(3)]: swap({ logs: [feeLog(USDC_ETH, TRADER, 1_000_000n)] }) } });
    await call(w, { op: 'record', ref: REFERRER, chain: 'ethereum', txs: [HASH(1)] });
    await call(w, { op: 'record', ref: '0x' + '9'.repeat(40), chain: 'ethereum', txs: [HASH(3)] });
    expect(w.bindings).toHaveLength(1);
    expect(w.credits.map((c) => c.referrer)).toEqual([`evm:${REFERRER}`, `evm:${REFERRER}`]);
  });

  it('refuses a payment that did not come from the signed-in trader', async () => {
    const w = fakeWorld({ evmTx: { [HASH(1)]: swap({ from: REFERRER, logs: [feeLog(USDC_ETH, '0x' + '7'.repeat(40), 5_800_000n)] }) } });
    const r = await call(w, { op: 'record', ref: REFERRER, chain: 'ethereum', txs: [HASH(1)] });
    expect(r.data.credited).toBe(0);
    expect(r.data.results[0].result).toBe('no-fee');
    expect(w.credits).toHaveLength(0);
  });

  it('ignores a transfer to anyone but the fee address, and an unlisted token', async () => {
    const other = { address: USDC_ETH, topics: [TRANSFER, pad(TRADER), pad('0x' + '5'.repeat(40))], data: '0x' + (5_800_000).toString(16).padStart(64, '0') };
    const junk = feeLog('0x' + 'c'.repeat(40), TRADER, 5_800_000n);
    const w = fakeWorld({ evmTx: { [HASH(1)]: swap({ logs: [other, junk] }) } });
    const r = await call(w, { op: 'record', ref: REFERRER, chain: 'ethereum', txs: [HASH(1)] });
    expect(r.data.results[0].result).toBe('no-fee');
  });

  it('does not credit a failed or still-pending transaction, or one that is too old', async () => {
    const w = fakeWorld({ evmTx: { [HASH(1)]: swap({ status: '0x0' }), [HASH(4)]: swap({ pending: true }) } });
    expect((await call(w, { op: 'record', ref: REFERRER, chain: 'ethereum', txs: [HASH(1)] })).data.results[0].result).toBe('failed');
    expect((await call(w, { op: 'record', chain: 'ethereum', txs: [HASH(4)] })).data.results[0].result).toBe('pending');
    const old = fakeWorld({ evmTx: { [HASH(5)]: swap({ blockTime: NOW - 7 * 3_600_000 }) } });
    expect((await call(old, { op: 'record', ref: REFERRER, chain: 'ethereum', txs: [HASH(5)] })).data.results[0].result).toBe('out-of-time');
    expect(old.credits).toHaveLength(0);
  });

  it('refuses self-referral, in any letter case, and binds nobody', async () => {
    const w = fakeWorld({ evmTx: { [HASH(1)]: swap() } });
    const r = await call(w, { op: 'record', ref: TRADER.replace('0x', '0x').toUpperCase().replace('0X', '0x'), chain: 'ethereum', txs: [HASH(1)] });
    expect(r.data).toEqual({ credited: 0, reason: 'self' });
    expect(w.bindings).toHaveLength(0);
  });

  it('refuses two people who named each other', async () => {
    const w = fakeWorld({ evmTx: { [HASH(1)]: swap() } });
    w.bindings.push({ trader: `evm:${REFERRER}`, referrer: `evm:${TRADER}`, bound_at: NOW - 1000, expires_at: NOW + 1e9 });
    expect((await call(w, { op: 'record', ref: REFERRER, chain: 'ethereum', txs: [HASH(1)] })).data.reason).toBe('mutual');
  });

  it('earns nothing for a revoked referrer, before or after binding', async () => {
    const w = fakeWorld({ evmTx: { [HASH(1)]: swap() } });
    w.revocations.push({ referrer: `evm:${REFERRER}`, reason: 'abuse', revoked_at: NOW });
    expect((await call(w, { op: 'record', ref: REFERRER, chain: 'ethereum', txs: [HASH(1)] })).data.reason).toBe('revoked');
    const w2 = fakeWorld({ evmTx: { [HASH(1)]: swap() } });
    w2.bindings.push({ trader: `evm:${TRADER}`, referrer: `evm:${REFERRER}`, bound_at: NOW - 1000, expires_at: NOW + 1e9 });
    w2.revocations.push({ referrer: `evm:${REFERRER}`, reason: 'abuse', revoked_at: NOW });
    expect((await call(w2, { op: 'record', chain: 'ethereum', txs: [HASH(1)] })).data.reason).toBe('revoked');
    expect(w2.credits).toHaveLength(0);
  });

  it('stops crediting after the 90 days', async () => {
    const w = fakeWorld({ evmTx: { [HASH(1)]: swap() } });
    w.bindings.push({ trader: `evm:${TRADER}`, referrer: `evm:${REFERRER}`, bound_at: NOW - 91 * 86_400_000, expires_at: NOW - 86_400_000 });
    expect((await call(w, { op: 'record', chain: 'ethereum', txs: [HASH(1)] })).data.reason).toBe('window-ended');
    expect(w.credits).toHaveLength(0);
  });

  it('records but does not pay beyond the daily cap, and a Solana referrer on an EVM chain', async () => {
    const w = fakeWorld({ evmTx: { [HASH(1)]: swap() } });
    w.bindings.push({ trader: `evm:${TRADER}`, referrer: `evm:${REFERRER}`, bound_at: NOW - 1000, expires_at: NOW + 1e9 });
    for (let i = 0; i < 200; i++) w.credits.push({ chain: 'ethereum', tx: HASH(1000 + i), asset: USDC_ETH, trader: `evm:0x${String(i).padStart(40, '0')}`, referrer: `evm:${REFERRER}`, fee_raw: String(1000 + i), share_raw: '1', status: 'credited', tx_at: NOW - 60_000, created_at: NOW - 60_000 });
    const r = await call(w, { op: 'record', chain: 'ethereum', txs: [HASH(1)] });
    expect(r.data.results[0].result).toBe('capped');
    expect(w.credits.at(-1)).toMatchObject({ status: 'capped', share_raw: '0' });

    const w2 = fakeWorld({ evmTx: { [HASH(1)]: swap() } });
    const r2 = await call(w2, { op: 'record', ref: SOL_REF, chain: 'ethereum', txs: [HASH(1)] });
    expect(r2.data.results[0].result).toBe('family');
    expect(w2.credits[0]).toMatchObject({ share_raw: '0' });
  });

  it('rejects a network that does not match the signed-in wallet, a bad link and no transactions', async () => {
    const w = fakeWorld();
    expect((await call(w, { op: 'record', ref: REFERRER, chain: 'solana', txs: [SIG] })).status).toBe(400);
    expect((await call(w, { op: 'record', ref: REFERRER, chain: 'ethereum', txs: [] })).status).toBe(400);
    expect((await call(w, { op: 'record', ref: 'junk', chain: 'ethereum', txs: [HASH(1)] })).data.reason).toBe('no-referrer');
  });
});

describe('recording a swap on Solana', () => {
  const tx = (over: Record<string, unknown> = {}) => ({
    blockTime: Math.floor((NOW - 30_000) / 1000),
    meta: { err: null, preBalances: [10e9, 1e9], postBalances: [9.9e9, 1e9 + 5_800_000], preTokenBalances: [], postTokenBalances: [] },
    transaction: { message: { accountKeys: [{ pubkey: SOL_TRADER, signer: true }, { pubkey: SWAP_FEE_WALLET, signer: false }] } },
    ...over,
  });
  it('credits the rise in the fee wallet, paid in a transaction the trader signed', async () => {
    const w = fakeWorld({ solTx: { [SIG]: tx() } });
    const r = await call(w, { op: 'record', ref: REFERRER.length ? SOL_REF : '', chain: 'solana', txs: [SIG] }, { as: `solana:${SOL_TRADER}` });
    expect(r.data.credited).toBe(1);
    expect(w.credits[0]).toMatchObject({ asset: 'So11111111111111111111111111111111111111112', fee_raw: '5800000', share_raw: '1160000', referrer: `solana:${SOL_REF}` });
  });
  it('credits a USDC fee by the token balance of the fee wallet', async () => {
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const t = tx({ meta: { err: null, preBalances: [1, 1], postBalances: [1, 1], preTokenBalances: [{ mint: usdc, owner: SWAP_FEE_WALLET, uiTokenAmount: { amount: '100' } }], postTokenBalances: [{ mint: usdc, owner: SWAP_FEE_WALLET, uiTokenAmount: { amount: '5800100' } }] } });
    const w = fakeWorld({ solTx: { [SIG]: t } });
    await call(w, { op: 'record', ref: SOL_REF, chain: 'solana', txs: [SIG] }, { as: `solana:${SOL_TRADER}` });
    expect(w.credits[0]).toMatchObject({ asset: usdc, fee_raw: '5800000' });
  });
  it('refuses a transaction someone else signed, and a failed one', async () => {
    const other = tx({ transaction: { message: { accountKeys: [{ pubkey: SOL_REF, signer: true }, { pubkey: SWAP_FEE_WALLET, signer: false }] } } });
    const w = fakeWorld({ solTx: { [SIG]: other } });
    expect((await call(w, { op: 'record', ref: SOL_REF, chain: 'solana', txs: [SIG] }, { as: `solana:${SOL_TRADER}` })).data.results[0].result).toBe('not-trader');
    const bad = fakeWorld({ solTx: { [SIG]: tx({ meta: { err: { x: 1 } } }) } });
    expect((await call(bad, { op: 'record', ref: SOL_REF, chain: 'solana', txs: [SIG] }, { as: `solana:${SOL_TRADER}` })).data.results[0].result).toBe('failed');
  });
});

describe('flat Aretia fees are not swap fees', () => {
  const LAUNCH_FEE = 50_000_000;
  const solTx = (instructions: unknown[], inner: unknown[] = []) => ({
    blockTime: Math.floor((NOW - 30_000) / 1000),
    meta: { err: null, preBalances: [10e9, 1e9], postBalances: [9.9e9, 1e9 + LAUNCH_FEE], preTokenBalances: [], postTokenBalances: [], innerInstructions: inner.length ? [{ instructions: inner }] : [] },
    transaction: { message: { accountKeys: [{ pubkey: SOL_TRADER, signer: true }, { pubkey: SWAP_FEE_WALLET, signer: false }], instructions } },
  });
  const transferIx = { programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: {} } };
  const record = (w: ReturnType<typeof fakeWorld>) => call(w, { op: 'record', ref: SOL_REF, chain: 'solana', txs: [SIG] }, { as: `solana:${SOL_TRADER}` });

  it('does not credit a token launch on Solana (it creates a mint)', async () => {
    const w = fakeWorld({ solTx: { [SIG]: solTx([transferIx, { programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', parsed: { type: 'initializeMint', info: {} } }]) } });
    expect((await record(w)).data.results[0].result).toBe('not-swap');
    expect(w.credits).toHaveLength(0);
  });
  it('does not credit a pool opening on Solana (its position NFT mint is made inside the pool program)', async () => {
    const w = fakeWorld({ solTx: { [SIG]: solTx([transferIx], [{ programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', parsed: { type: 'initializeMint2', info: {} } }]) } });
    expect((await record(w)).data.results[0].result).toBe('not-swap');
  });
  it("does not credit a trade on Aretia's own curve", async () => {
    const w = fakeWorld({ solTx: { [SIG]: solTx([{ programId: 'CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu' }]) } });
    expect((await record(w)).data.results[0].result).toBe('not-swap');
  });
  it('still credits a plain swap whose fee happens to be a round number', async () => {
    const w = fakeWorld({ solTx: { [SIG]: solTx([transferIx, { programId: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG' }]) } });
    expect((await record(w)).data.credited).toBe(1);
  });
  it('does not credit the flat 10 USDC pool fee on an EVM chain', async () => {
    const w = fakeWorld({ evmTx: { [HASH(7)]: { from: TRADER, to: USDC_ETH, logs: [feeLog(USDC_ETH, TRADER, 10_000_000n)], blockTime: NOW - 1000 } } });
    const r = await call(w, { op: 'record', ref: REFERRER, chain: 'ethereum', txs: [HASH(7)] });
    expect(r.data.results[0].result).toBe('not-swap');
    expect(w.credits).toHaveLength(0);
  });
});

describe('a referrer reading their own numbers', () => {
  it('shows only their rows, with totals per chain and coin, and counts what earned nothing', async () => {
    const w = fakeWorld();
    const me = `evm:${REFERRER}`;
    const row = (n: number, referrer: string, status: string, fee: string, share: string, chain = 'ethereum') => ({ chain, tx: HASH(n), asset: USDC_ETH, trader: `evm:t${n}`, referrer, fee_raw: fee, share_raw: share, status, tx_at: NOW, created_at: NOW - n });
    w.credits.push(row(1, me, 'credited', '5800000', '1160000'), row(2, me, 'credited', '5800000', '1160000'), row(3, me, 'capped', '5800000', '0'), row(4, 'evm:someone-else', 'credited', '9999', '1999'), row(5, me, 'credited', '58', '11', 'bnb'));
    w.bindings.push({ trader: 'evm:t1', referrer: me, bound_at: NOW - 1000, expires_at: NOW + 1e9 }, { trader: 'evm:t9', referrer: 'evm:someone-else', bound_at: NOW, expires_at: NOW + 1e9 });
    const r = await call(w, { op: 'mine' }, { as: me });
    expect(r.status).toBe(200);
    expect(r.data.traders).toBe(1);
    expect(r.data.notCounted.capped).toBe(1);
    expect(r.data.totals).toEqual([
      { chain: 'bnb', asset: USDC_ETH, swaps: 1, fee: '58', volume: '10000', owed: '11' },
      { chain: 'ethereum', asset: USDC_ETH, swaps: 2, fee: '11600000', volume: '2000000000', owed: '2320000' },
    ]);
    expect(JSON.stringify(r.data)).not.toContain('someone-else');
    expect(w.calls.every((c) => c.includes(encodeURIComponent(me)) || !c.includes('referral_credits'))).toBe(true);
  });
  it('shows nothing owed to a revoked referrer', async () => {
    const w = fakeWorld();
    w.credits.push({ chain: 'ethereum', tx: HASH(1), asset: USDC_ETH, trader: 'evm:t', referrer: `evm:${REFERRER}`, fee_raw: '5800000', share_raw: '1160000', status: 'credited', tx_at: NOW, created_at: NOW });
    w.revocations.push({ referrer: `evm:${REFERRER}`, reason: 'abuse', revoked_at: NOW });
    const r = await call(w, { op: 'mine' }, { as: `evm:${REFERRER}` });
    expect(r.data).toMatchObject({ revoked: true, totals: [] });
  });
});
