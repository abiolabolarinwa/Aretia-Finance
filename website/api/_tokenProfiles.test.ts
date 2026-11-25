import { beforeEach, describe, expect, it } from 'vitest';
import { decodeBase58, encodeBase58, METADATA_PROGRAM, metadataAddress, TOKEN_2022_PROGRAM } from '../src/swings/mi/solana/accounts.js';
import { resetBudgets } from './_limits.js';
import { resetRateLimit } from './_rpcProxy.js';
import { issueSession } from './_swingsAuth.js';
import { handleProfiles, readTokenFacts, resetProfileState, type ProfilesEnv, type ProfilesInput, type TokenFacts } from './_tokenProfiles.js';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://aretiafinance.org';
const DB_KEY = 'db-key-for-tests';
const ADMIN = '0x' + '9'.repeat(40);
const env: ProfilesEnv = { SUPABASE_URL: 'https://data.example.org', SUPABASE_SERVICE_ROLE_KEY: DB_KEY, ADMIN_WALLETS: ADMIN };
const bearer = (owner: string): string => `Bearer ${issueSession(DB_KEY, owner, NOW).token}`;

const CREATOR = '0x' + '1'.repeat(40);
const STRANGER = '0x' + '3'.repeat(40);
const TOKEN = '0x' + '2'.repeat(40);
const LOGO = `https://assets.aretiafinance.org/img/${'a'.repeat(64)}.png`;
const PROFILE = { description: 'A cat.', website: 'https://cat.example', x: 'https://x.com/cat', telegram: '', discord: '', logo: LOGO };

type Row = Record<string, unknown>;

/** A tiny stand-in for the database's REST interface: eq / in filters, select, limit, insert with the two unique rules, update, delete. */
function fakeDb() {
  const tables: Record<string, Row[]> = { token_profiles: [], token_profile_blocks: [], account_sessions: [] };
  let nextId = 1;
  const match = (row: Row, params: URLSearchParams): boolean => {
    for (const [k, v] of params) {
      if (['select', 'limit', 'order', 'on_conflict'].includes(k)) continue;
      if (v.startsWith('eq.') && String(row[k]) !== v.slice(3)) return false;
      if (v.startsWith('in.(') && !v.slice(4, -1).split(',').includes(String(row[k]))) return false;
    }
    return true;
  };
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const table = u.pathname.replace('/rest/v1/', '');
    const rows = tables[table];
    if (!rows) return new Response('', { status: 404 });
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      const out = rows.filter((r) => match(r, u.searchParams)).slice(0, Number(u.searchParams.get('limit') ?? 1000));
      const cols = u.searchParams.get('select')?.split(',');
      return new Response(JSON.stringify(cols ? out.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))) : out));
    }
    if (method === 'POST') {
      const row = JSON.parse(String(init?.body)) as Row;
      if (table === 'token_profiles') {
        const clash = rows.some((r) => r.chain === row.chain && r.address === row.address && r.status === row.status && (row.status === 'live' || (row.status === 'pending' && r.submitted_by === row.submitted_by)));
        if (clash) return new Response('{"code":"23505"}', { status: 409 });
        rows.push({ id: nextId++, reviewed_by: null, reviewed_at: null, note: null, ...row });
      } else {
        const i = rows.findIndex((r) => r.chain === row.chain && r.address === row.address);
        if (i >= 0) rows[i] = row;
        else rows.push(row);
      }
      return new Response('', { status: 201 });
    }
    if (method === 'PATCH') {
      const patch = JSON.parse(String(init?.body)) as Row;
      for (const r of rows) if (match(r, u.searchParams)) Object.assign(r, patch);
      return new Response(null, { status: 204 });
    }
    if (method === 'DELETE') {
      tables[table] = rows.filter((r) => !match(r, u.searchParams));
      return new Response(null, { status: 204 });
    }
    return new Response('', { status: 405 });
  }) as typeof fetch;
  return { tables, fetchImpl };
}

let db: ReturnType<typeof fakeDb>;
let facts: TokenFacts;
const call = (owner: string | null, body: unknown, over: Partial<ProfilesInput> = {}) =>
  handleProfiles({ method: 'POST', origin: ORIGIN, authorization: owner ? bearer(owner) : null, ip: '1.1.1.1', query: {}, body, env, fetchImpl: db.fetchImpl, now: NOW, readFacts: async () => structuredClone(facts), ...over }).then((r) => ({ status: r.status, data: JSON.parse(r.body || '{}') as Record<string, unknown> }));
const read = () => handleProfiles({ method: 'GET', origin: null, authorization: null, ip: '1.1.1.1', query: { chain: 'bnb', address: TOKEN }, body: null, env, fetchImpl: db.fetchImpl, now: NOW }).then((r) => JSON.parse(r.body) as { profile: Record<string, unknown> | null });

beforeEach(() => {
  resetProfileState();
  resetBudgets();
  resetRateLimit();
  db = fakeDb();
  facts = { exists: true, controllers: [CREATOR], name: 'Cat', symbol: 'CAT' };
});

describe('publishing a profile', () => {
  it('goes live at once for the wallet that controls the token, and the public read shows it', async () => {
    const out = await call(`evm:${CREATOR}`, { op: 'submit', chain: 'bnb', address: TOKEN, profile: PROFILE });
    expect(out.status).toBe(200);
    expect(out.data.status).toBe('live');
    const p = (await read()).profile;
    expect(p).toMatchObject({ chain: 'bnb', address: TOKEN, description: 'A cat.', website: 'https://cat.example/', proof: 'authority', logo: LOGO });
    expect(p).not.toHaveProperty('submitted_by');
  });

  it('a second version from the controller replaces the first; only one is ever live', async () => {
    await call(`evm:${CREATOR}`, { op: 'submit', chain: 'bnb', address: TOKEN, profile: PROFILE });
    await call(`evm:${CREATOR}`, { op: 'submit', chain: 'bnb', address: TOKEN, profile: { ...PROFILE, description: 'A better cat.' } });
    expect(db.tables.token_profiles!.filter((r) => r.status === 'live')).toHaveLength(1);
    resetProfileState();
    expect((await read()).profile?.description).toBe('A better cat.');
  });

  it('waits for review when the wallet does not control the token (or nobody does), and is not shown until approved', async () => {
    facts.controllers = [];
    const out = await call(`evm:${STRANGER}`, { op: 'submit', chain: 'bnb', address: TOKEN, profile: PROFILE });
    expect(out.data.status).toBe('pending');
    expect((await read()).profile).toBeNull();
    // Sending again updates the same request rather than adding another.
    await call(`evm:${STRANGER}`, { op: 'submit', chain: 'bnb', address: TOKEN, profile: { ...PROFILE, description: 'Edited.' } });
    expect(db.tables.token_profiles!.filter((r) => r.status === 'pending')).toHaveLength(1);
  });

  it('the controller is decided from the chain, not from anything the browser says', async () => {
    const out = await call(`evm:${STRANGER}`, { op: 'submit', chain: 'bnb', address: TOKEN, profile: PROFILE, controllers: [STRANGER], proof: 'authority' });
    expect(out.data.status).toBe('pending');
  });

  it('refuses without a sign-in, from another site, with the other family of wallet, or for a token that does not exist', async () => {
    expect((await call(null, { op: 'submit', chain: 'bnb', address: TOKEN, profile: PROFILE })).status).toBe(401);
    expect((await call(`evm:${CREATOR}`, { op: 'submit', chain: 'bnb', address: TOKEN, profile: PROFILE }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call(`solana:${encodeBase58(new Uint8Array(32).fill(4))}`, { op: 'submit', chain: 'bnb', address: TOKEN, profile: PROFILE })).data.error).toBe('wrong-wallet');
    facts = { exists: false, controllers: [], name: null, symbol: null };
    expect((await call(`evm:${CREATOR}`, { op: 'submit', chain: 'bnb', address: TOKEN, profile: PROFILE })).status).toBe(404);
  });

  it('refuses unsafe fields and impersonating tokens', async () => {
    const bad = await call(`evm:${CREATOR}`, { op: 'submit', chain: 'bnb', address: TOKEN, profile: { ...PROFILE, website: 'https://bit.ly/x' } });
    expect(bad.status).toBe(400);
    facts.symbol = 'USDT';
    const fake = await call(`evm:${CREATOR}`, { op: 'submit', chain: 'bnb', address: TOKEN, profile: PROFILE });
    expect(fake.data.error).toBe('impersonation');
    expect(db.tables.token_profiles).toHaveLength(0);
  });

  it('limits how often one wallet can submit', async () => {
    for (let i = 0; i < 10; i++) expect((await call(`evm:${CREATOR}`, { op: 'submit', chain: 'bnb', address: TOKEN, profile: PROFILE })).status).toBe(200);
    expect((await call(`evm:${CREATOR}`, { op: 'submit', chain: 'bnb', address: TOKEN, profile: PROFILE })).status).toBe(429);
  });

  it('check tells the wallet what will happen before it types', async () => {
    expect((await call(`evm:${CREATOR}`, { op: 'check', chain: 'bnb', address: TOKEN })).data).toMatchObject({ controls: 'authority', blocked: false, live: null });
    expect((await call(`evm:${STRANGER}`, { op: 'check', chain: 'bnb', address: TOKEN })).data).toMatchObject({ controls: 'review', hasController: true });
  });
});

describe('the owner’s review', () => {
  it('is invisible (404) to anyone but the owner wallets', async () => {
    expect((await call(`evm:${CREATOR}`, { op: 'admin-list' })).status).toBe(404);
    expect((await call(null, { op: 'admin-list' })).status).toBe(404);
  });

  it('approve puts a waiting request live; reject does not', async () => {
    facts.controllers = [];
    await call(`evm:${STRANGER}`, { op: 'submit', chain: 'bnb', address: TOKEN, profile: PROFILE });
    const list = await call(`evm:${ADMIN}`, { op: 'admin-list' });
    const pending = list.data.pending as Row[];
    expect(pending).toHaveLength(1);
    expect(pending[0]!.submitted_by).toBe(`evm:${STRANGER}`);
    expect((await call(`evm:${ADMIN}`, { op: 'admin-approve', id: pending[0]!.id })).status).toBe(200);
    expect((await read()).profile).toMatchObject({ proof: 'review', description: 'A cat.' });

    await call(`evm:${CREATOR}`, { op: 'submit', chain: 'bnb', address: TOKEN, profile: { ...PROFILE, description: 'Other.' } });
    const second = ((await call(`evm:${ADMIN}`, { op: 'admin-list' })).data.pending as Row[])[0]!;
    await call(`evm:${ADMIN}`, { op: 'admin-reject', id: second.id });
    resetProfileState();
    expect((await read()).profile?.description).toBe('A cat.');
  });

  it('remove takes the profile down and blocks the token until allowed again', async () => {
    await call(`evm:${CREATOR}`, { op: 'submit', chain: 'bnb', address: TOKEN, profile: PROFILE });
    expect((await call(`evm:${ADMIN}`, { op: 'admin-remove', chain: 'bnb', address: TOKEN, reason: 'scam' })).status).toBe(200);
    expect((await read()).profile).toBeNull();
    expect((await call(`evm:${CREATOR}`, { op: 'submit', chain: 'bnb', address: TOKEN, profile: PROFILE })).data.error).toBe('blocked');
    await call(`evm:${ADMIN}`, { op: 'admin-unblock', chain: 'bnb', address: TOKEN });
    expect((await call(`evm:${CREATOR}`, { op: 'submit', chain: 'bnb', address: TOKEN, profile: PROFILE })).data.status).toBe('live');
  });
});

describe('reading control from the chain', () => {
  const rpcWorld = (answer: (method: string, params: unknown[]) => unknown) =>
    (async (_url: string | URL, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      const result = answer(b.method, b.params);
      return new Response(JSON.stringify(result instanceof Error ? { error: { message: 'execution reverted' } } : { result }));
    }) as typeof fetch;
  const word = (a: string): string => '0x' + a.slice(2).padStart(64, '0');
  const str = (s: string): string => '0x' + (32).toString(16).padStart(64, '0') + s.length.toString(16).padStart(64, '0') + Buffer.from(s).toString('hex').padEnd(64, '0');

  it('Ethereum-style: owner() is the controller; a renounced owner (zero) and a missing function give none', async () => {
    const f = await readTokenFacts('bnb', TOKEN, {}, rpcWorld((m, p) => (m === 'eth_getCode' ? '0x6080' : ((p[0] as { data: string }).data === '0x8da5cb5b' ? word(CREATOR) : (p[0] as { data: string }).data === '0x95d89b41' ? str('CAT') : new Error()))));
    expect(f).toEqual({ exists: true, controllers: [CREATOR], name: null, symbol: 'CAT' });
    const g = await readTokenFacts('bnb', TOKEN, {}, rpcWorld((m) => (m === 'eth_getCode' ? '0x6080' : word('0x' + '0'.repeat(40)))));
    expect(g.controllers).toEqual([]);
    const none = await readTokenFacts('bnb', TOKEN, {}, rpcWorld((m) => (m === 'eth_getCode' ? '0x' : null)));
    expect(none.exists).toBe(false);
  });

  it('Solana: the mint authority and the metadata update authority are controllers; a pump.fun-style mint with both given up has none', async () => {
    const mintAddr = encodeBase58(new Uint8Array(32).fill(11));
    const auth = new Uint8Array(32).fill(12);
    const upd = new Uint8Array(32).fill(13);
    const mint = new Uint8Array(82);
    mint[0] = 1;
    mint.set(auth, 4);
    mint[44] = 6;
    mint[45] = 1;
    const meta = new Uint8Array(1 + 32 + 32 + 4 + 3 + 4 + 3 + 4);
    meta[0] = 4;
    meta.set(upd, 1);
    meta.set(new Uint8Array(32).fill(11), 33);
    const dv = new DataView(meta.buffer);
    dv.setUint32(65, 3, true);
    meta.set(Buffer.from('Cat'), 69);
    dv.setUint32(72, 3, true);
    meta.set(Buffer.from('CAT'), 76);
    dv.setUint32(79, 0, true);
    const acc = (d: Uint8Array, owner: string) => ({ data: [Buffer.from(d).toString('base64'), 'base64'], owner });
    let asked: unknown[] = [];
    const f = await readTokenFacts('solana', mintAddr, {}, rpcWorld((_m, p) => {
      asked = p[0] as unknown[];
      return { value: [acc(mint, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), acc(meta, METADATA_PROGRAM)] };
    }));
    expect(asked).toEqual([mintAddr, metadataAddress(mintAddr)]);
    expect(f).toEqual({ exists: true, controllers: [encodeBase58(auth), encodeBase58(upd)], name: 'Cat', symbol: 'CAT' });

    mint[0] = 0; // mint authority given up
    const given = await readTokenFacts('solana', mintAddr, {}, rpcWorld(() => ({ value: [acc(mint, TOKEN_2022_PROGRAM), null] })));
    expect(given.controllers).toEqual([]);
    // pump.fun keeps its own program authority as the update authority: that is not a person, so it does not count.
    meta.set(decodeBase58('TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM')!, 1);
    const pump = await readTokenFacts('solana', mintAddr, {}, rpcWorld(() => ({ value: [acc(mint, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), acc(meta, METADATA_PROGRAM)] })));
    expect(pump.controllers).toEqual([]);
    const missing = await readTokenFacts('solana', mintAddr, {}, rpcWorld(() => ({ value: [null, null] })));
    expect(missing.exists).toBe(false);
  });
});
