import { beforeEach, describe, expect, it } from 'vitest';
import * as core from '../scripts/revenueReportCore.mjs';
import { resetBudgets } from './_limits.js';
import { resetRateLimit } from './_rpcProxy.js';
import { issueSession } from './_swingsAuth.js';
import {
  EVM_CHAINS, EVM_FEE_ADDRESS, SOLANA_FEE_WALLET, SOLANA_FLAT_FEE_LAMPORTS, SOLANA_USDC_MINT, adminOwners, bumpsFor, cleanLabel, estimateCreationRevenue, handleAdmin, handleBeacon, normaliseOwner, summariseCounters, summariseEvents, summariseSavedTrades, tally,
  type AdminEnv,
} from './_adminStats.js';

const NOW = 1_800_000_000_000;
const KEY = 'service-key-for-tests';
const ORIGIN = 'https://aretiafinance.org';
const OWNER_ADDR = '0x' + 'a'.repeat(40);
const OTHER_ADDR = '0x' + 'b'.repeat(40);
const env: AdminEnv = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: KEY, SWINGS_SESSION_SECRET: 'secret-for-tests', ADMIN_WALLETS: OWNER_ADDR.toUpperCase().replace('0X', '0x') };

beforeEach(() => {
  resetRateLimit();
  resetBudgets();
});

/** A database that answers account_sessions with nothing, the counters from `tables`, and counts rpc calls. */
function world(tables: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/rest/v1/')) {
      const path = url.split('/rest/v1/')[1]!.split('?')[0]!;
      calls.push(`${init?.method ?? 'GET'} ${path} ${init?.body ?? ''}`);
      if (path.startsWith('rpc/')) return new Response('', { status: 204 });
      if (path === 'account_sessions') return new Response('[]');
      if (path in tables) return new Response(JSON.stringify(tables[path]));
      return new Response('{}', { status: 404 });
    }
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const session = (addr: string) => `Bearer ${issueSession('secret-for-tests', `evm:${addr.toLowerCase()}`, NOW).token}`;
const admin = (over: Partial<Parameters<typeof handleAdmin>[0]>, fetchImpl: typeof fetch) =>
  handleAdmin({ method: 'POST', origin: ORIGIN, authorization: session(OWNER_ADDR), ip: '1.1.1.1', body: {}, env, fetchImpl, now: NOW, ...over });

describe('the owner allow-list', () => {
  it('reads EVM (any case, with or without evm:) and Solana entries and ignores junk', () => {
    const sol = '4Nd1mBQtrMJVYVfKGkqmKMo8WhEKUuf3fEdSm7X1E6SG';
    const owners = adminOwners({ ADMIN_WALLETS: `0xAbCdEf${'0'.repeat(34)}, evm:0x${'C'.repeat(40)};${sol} not-an-address solana:${sol}` });
    expect([...owners].sort()).toEqual([`evm:0xabcdef${'0'.repeat(34)}`, `evm:0x${'c'.repeat(40)}`, `solana:${sol}`].sort());
    expect(adminOwners({}).size).toBe(0);
    expect(normaliseOwner('0x123')).toBeNull();
  });
});

describe('/api/swings-admin is owner-only, and everyone else gets the 404 of a path that does not exist', () => {
  it('answers the owner, in any spelling of the address', async () => {
    const { fetchImpl } = world({ admin_counters: [{ day: '2026-10-20', kind: 'visit', key: 'all', n: 7 }], user_trades: [], swings_events: [], launchbox_tokens: [] });
    const out = await admin({}, fetchImpl);
    expect(out.status).toBe(200);
    const body = JSON.parse(out.body);
    expect(body.counters.status).toBe('ok');
    expect(body.counters.visits).toBe(7);
  });

  it('refuses a missing session, a signed-in stranger, a forged token, the wrong method and a foreign origin with the same 404 and no data', async () => {
    const { fetchImpl } = world({ admin_counters: [{ day: '2026-10-20', kind: 'visit', key: 'all', n: 7 }] });
    const unknown = { status: 404, body: '{"error":"not-found"}' };
    for (const over of [
      { authorization: null },
      { authorization: session(OTHER_ADDR) },
      { authorization: 'Bearer forged.token.value' },
      { method: 'GET' },
      { origin: 'https://evil.example' },
      { origin: null },
    ]) {
      const out = await admin(over, fetchImpl);
      expect({ status: out.status, body: out.body }).toEqual(unknown);
    }
  });

  it('is a 404 for everyone when no allow-list is set, or the owner has ended their sessions', async () => {
    const { fetchImpl } = world({});
    expect((await admin({ env: { ...env, ADMIN_WALLETS: '' } }, fetchImpl)).status).toBe(404);
    const revoked = (async (input: string | URL) => (String(input).includes('account_sessions') ? new Response(JSON.stringify([{ version: 3 }])) : new Response('[]'))) as typeof fetch;
    expect((await admin({}, revoked)).status).toBe(404);
  });

  it('says "not set up" for a section whose table is missing, instead of failing', async () => {
    const { fetchImpl } = world({ launchbox_tokens: [], swings_events: [], user_trades: [] });
    const body = JSON.parse((await admin({}, fetchImpl)).body);
    expect(body.counters.status).toBe('not-set-up');
    expect(body.counters.note).toContain('docs/admin-page.md');
    expect(body.saved.status).toBe('ok');
  });
});

describe('/api/swings-beacon', () => {
  const beacon = (body: unknown, over: Partial<Parameters<typeof handleBeacon>[0]> = {}, fetchImpl = world().fetchImpl) =>
    handleBeacon({ method: 'POST', origin: ORIGIN, ip: '2.2.2.2', country: 'gb', body, env, fetchImpl, now: NOW, ...over });

  it('counts a visit and its country with one increment each, and stores no address of the caller', async () => {
    const w = world();
    expect((await beacon({ k: 'visit' }, {}, w.fetchImpl)).status).toBe(204);
    expect(w.calls).toHaveLength(2);
    expect(w.calls.join('\n')).toContain('"p_kind":"country","p_key":"GB"');
    expect(w.calls.join('\n')).not.toContain('2.2.2.2');
  });

  it('survives a database without the migration', async () => {
    const down = (async () => new Response('{}', { status: 404 })) as typeof fetch;
    expect((await beacon({ k: 'visit' }, {}, down)).status).toBe(204);
  });

  it('refuses a foreign origin and a GET, and rate-limits', async () => {
    expect((await beacon({ k: 'visit' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await beacon({ k: 'visit' }, { method: 'GET' })).status).toBe(405);
    let last = 0;
    for (let i = 0; i < 40; i++) last = (await beacon({ k: 'visit' }, { ip: '9.9.9.9' })).status;
    expect(last).toBe(429);
  });
});

describe('what a beacon may add', () => {
  it('maps a visit to the visit and country counters, with XX for an unknown country', () => {
    expect(bumpsFor({ k: 'visit' }, 'de')).toEqual([{ kind: 'visit', key: 'all' }, { kind: 'country', key: 'DE' }]);
    expect(bumpsFor({ k: 'visit' }, null)[1]).toEqual({ kind: 'country', key: 'XX' });
    expect(bumpsFor({ k: 'visit' }, 'not-a-country')[1]).toEqual({ kind: 'country', key: 'XX' });
  });

  it('counts a confirmed swap by wallet, network and coin, and a failed one as an issue', () => {
    expect(bumpsFor({ k: 'swap', chain: 'solana', from: 'SOL', to: 'USDC', wallet: 'Phantom', status: 'confirmed' }, null)).toEqual([
      { kind: 'wallet', key: 'Phantom' },
      { kind: 'chain', key: 'solana' },
      { kind: 'coin', key: 'solana:SOL' },
      { kind: 'coin', key: 'solana:USDC' },
    ]);
    expect(bumpsFor({ k: 'swap', chain: 'bnb', from: 'BNB', to: 'X', wallet: null, status: 'failed' }, null)).toEqual([{ kind: 'issue', key: 'swap-failed:bnb' }]);
  });

  it('drops anything unrecognised and strips odd characters from labels, so an address or a message cannot be stored as one', () => {
    expect(bumpsFor({ k: 'swap', chain: 'mars', status: 'confirmed' }, null)).toEqual([]);
    expect(bumpsFor({ k: 'swap', chain: 'solana', status: 'pending' }, null)).toEqual([]);
    expect(bumpsFor({ k: 'issue', area: 'steal-keys' }, null)).toEqual([]);
    expect(bumpsFor('nonsense', null)).toEqual([]);
    expect(cleanLabel('<script>alert(1)</script>', 12)).toBe('scriptalert1');
    expect(cleanLabel('   ')).toBeNull();
    expect(bumpsFor({ k: 'issue', area: 'js-error', detail: 'TypeError: x is undefined' }, null)[0]!.key.length).toBeLessThanOrEqual(48);
  });
});

describe('summaries', () => {
  it('adds counters up by day, country, wallet, coin and issue', () => {
    const s = summariseCounters([
      { day: '2026-10-02', kind: 'visit', key: 'all', n: 3 },
      { day: '2026-10-01', kind: 'visit', key: 'all', n: 2 },
      { day: '2026-10-01', kind: 'country', key: 'GB', n: 4 },
      { day: '2026-10-02', kind: 'country', key: 'GB', n: 1 },
      { day: '2026-10-02', kind: 'issue', key: 'js-error:TypeError', n: 2 },
    ]);
    expect(s.visits).toBe(5);
    expect(s.visitsByDay.map((d) => d.key)).toEqual(['2026-10-01', '2026-10-02']);
    expect(s.countries).toEqual([{ key: 'GB', n: 5 }]);
    expect(s.issues[0]).toEqual({ key: 'js-error:TypeError', n: 2 });
  });

  it('counts distinct traders and confirmed coins from saved histories', () => {
    const t = summariseSavedTrades([
      { owner: 'evm:0x1', data: { status: 'confirmed', chain: 'bnb', fromSymbol: 'BNB', toSymbol: 'CAKE' } },
      { owner: 'evm:0x1', data: { status: 'failed', chain: 'bnb', fromSymbol: 'BNB', toSymbol: 'CAKE' } },
      { owner: 'solana:abc', data: { status: 'confirmed', chain: 'solana', fromSymbol: 'SOL', toSymbol: 'BONK' } },
    ]);
    expect(t).toMatchObject({ traders: 2, confirmed: 2, failed: 1 });
    expect(t.coins.map((c) => c.key).sort()).toEqual(['bnb:BNB', 'bnb:CAKE', 'solana:BONK', 'solana:SOL']);
  });

  it('lists failed swaps and quotes as problems and not confirmed ones', () => {
    const e = summariseEvents([
      { name: 'swap', chain: 'bnb', provider: '0x', status: 'failed' },
      { name: 'swap', chain: 'bnb', provider: '0x', status: 'confirmed' },
      { name: 'quote_failed', chain: null, provider: 'jupiter', status: null },
    ]);
    expect(e.problems.map((p) => p.key).sort()).toEqual(['quote failed · jupiter', 'swap failed · bnb · 0x']);
    expect(tally([{ key: 'a', n: 1 }, { key: 'a', n: 2 }, { key: 'b', n: 2 }])).toEqual([{ key: 'a', n: 3 }, { key: 'b', n: 2 }]);
  });

  it('estimates creation revenue as tokens times the flat fee, and says n/a without a price', () => {
    const est = estimateCreationRevenue([{ chain: 'solana' }, { chain: 'solana' }, { chain: 'bnb' }], { solana: 100, binancecoin: null, ethereum: 2000, 'polygon-ecosystem-token': 0.5 });
    expect(est.lines.find((l) => l.chain === 'Solana')).toMatchObject({ tokens: 2, usd: 10 });
    expect(est.lines.find((l) => l.chain === 'BNB Chain')!.usd).toBeNull();
    expect(estimateCreationRevenue([], { solana: null }).usd).toBeNull();
  });
});

describe('fee addresses stay the ones the private revenue report uses', () => {
  it('matches revenueReportCore.mjs', () => {
    expect(SOLANA_FEE_WALLET).toBe(core.SOLANA_FEE_WALLET);
    expect(EVM_FEE_ADDRESS).toBe(core.EVM_FEE_ADDRESS);
    expect(SOLANA_FLAT_FEE_LAMPORTS).toBe(core.SOLANA_FLAT_FEE_LAMPORTS);
    expect(SOLANA_USDC_MINT).toBe(core.SOLANA_USDC.mint);
    for (const c of EVM_CHAINS) {
      const k = core.EVM_CHAINS.find((x: { key: string }) => x.key === c.key)!;
      expect(c).toMatchObject({ symbol: k.symbol, coingecko: k.coingecko, rpc: k.rpc, creationFeeWei: k.creationFeeWei });
      expect(c.usdc).toEqual([k.stables.USDC.address, k.stables.USDC.decimals]);
      expect(c.usdt).toEqual([k.stables.USDT.address, k.stables.USDT.decimals]);
    }
  });
});
