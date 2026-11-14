import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak256 } from '../src/swings/core/keccak.js';
import { loginMessage, parseLoginMessage, type LoginPurpose } from '../src/swings/account/loginMessage.js';
import { resetRateLimit } from './_rpcProxy.js';
import { handleAccount, resetAccountState } from './_swingsAccount.js';
import { sqliteRest } from './_gameSqlite.js';
import { handleGame, readGameSession, walletIdentity, type GameInput } from './_game.js';
import { verifyLogin } from './_swingsAuth.js';
import { CITIES } from '../src/game/cities.js';
import { along, distanceKm, flightDurationMs, flightKm, inBounds, localDurationMs } from '../src/game/travel.js';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://aretiafinance.org';
const DOMAIN = 'aretiafinance.org';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const toBase58 = (bytes: Uint8Array): string => {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)]! + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
};
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

function solana(nonce: string, purpose: LoginPurpose = 'game', priv = ed25519.utils.randomPrivateKey()) {
  const address = toBase58(ed25519.getPublicKey(priv));
  const message = loginMessage({ purpose, family: 'solana', address, domain: DOMAIN, issuedAt: NOW, nonce });
  return { address, message, signature: Buffer.from(ed25519.sign(new TextEncoder().encode(message), priv)).toString('base64'), priv };
}
function evm(nonce: string, purpose: LoginPurpose = 'game', priv = secp256k1.utils.randomPrivateKey()) {
  const address = '0x' + hex(keccak256(secp256k1.getPublicKey(priv, false).slice(1)).slice(12));
  const message = loginMessage({ purpose, family: 'evm', address, domain: DOMAIN, issuedAt: NOW, nonce });
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix);
  joined.set(body, prefix.length);
  const sig = secp256k1.sign(keccak256(joined), priv);
  return { address, message, signature: '0x' + sig.toCompactHex() + (27 + sig.recovery).toString(16) };
}

const SECRET = 'game-test-session-secret';
const ENV = { SWINGS_SESSION_SECRET: SECRET };

/** The wallet's own sign-in endpoint still talks to Supabase; a small stand-in is enough to prove the two kinds of token stay apart. */
function walletFake() {
  const nonces = new Map<string, { expires_at: number; used_at: number | null }>();
  const versions = new Map<string, number>();
  return (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const params = new URLSearchParams(url.split('?')[1] ?? '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url.includes('/rest/v1/auth_nonces')) {
      if (method === 'POST') {
        nonces.set(String(body.nonce), { expires_at: Number(body.expires_at), used_at: null });
        return new Response('', { status: 201 });
      }
      const n = nonces.get(params.get('nonce')!.slice(3));
      if (!n || n.used_at !== null) return new Response('[]');
      n.used_at = Number(body.used_at);
      return new Response(JSON.stringify([n]));
    }
    if (url.includes('/rest/v1/account_sessions')) return new Response(method === 'POST' ? '' : JSON.stringify(versions.size ? [] : []), { status: method === 'POST' ? 201 : 200 });
    return new Response('');
  }) as unknown as typeof fetch;
}

function setup() {
  const { rest, raw } = sqliteRest(() => NOW);
  const rows = (sql: string): Record<string, unknown>[] => raw.prepare(sql).all() as Record<string, unknown>[];
  const base = { method: 'POST', origin: ORIGIN, authorization: null as string | null, ip: '5.5.5.5', db: rest, env: { ...ENV } as GameInput['env'], now: NOW };
  const call = (body: unknown, auth: string | null = null, over: Partial<GameInput> = {}) => handleGame({ ...base, authorization: auth, body, ...over });
  const nonce = async (): Promise<string> => (JSON.parse((await call({ op: 'nonce' })).body) as { nonce: string }).nonce;
  const walletEnv = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test' };
  const walletBase = { method: 'POST', origin: ORIGIN, authorization: null as string | null, ip: '5.5.5.5', env: walletEnv, fetchImpl: walletFake(), now: NOW };
  const walletCall = (body: unknown, authorization: string | null = null) => handleAccount({ ...walletBase, authorization, body });
  return {
    call, nonce, walletCall, raw,
    get players() { return rows('select * from game_players'); },
    get wallets() { return rows('select * from game_player_wallets'); },
    get activities() { return rows('select * from game_player_activities order by rowid'); },
    get playerCities() { return rows('select * from game_player_cities'); },
    get sessionOwners() { return rows('select owner from account_sessions').map((r) => String(r.owner)); },
  };
}

describe('the game sign-in message', () => {
  it('says it is for the game, is not a transaction, and is read back only exactly', () => {
    const m = loginMessage({ purpose: 'game', family: 'solana', address: 'Addr', domain: DOMAIN, issuedAt: NOW, nonce: 'ab'.repeat(16) });
    expect(m).toContain('Ultimate City Search');
    expect(m).toContain('not a transaction');
    expect(parseLoginMessage(m)).toMatchObject({ purpose: 'game', family: 'solana' });
    expect(parseLoginMessage(m + '\nExtra')).toBeNull();
    const w = loginMessage({ family: 'solana', address: 'Addr', domain: DOMAIN, issuedAt: NOW, nonce: 'ab'.repeat(16) });
    expect(parseLoginMessage(w)).toMatchObject({ purpose: 'wallet' });
  });

  it('is refused for a purpose it was not made for, in both directions', () => {
    const g = solana('ab'.repeat(16), 'game');
    const w = solana('cd'.repeat(16), 'wallet');
    expect(verifyLogin({ message: g.message, signature: g.signature, domain: DOMAIN, now: NOW, purpose: 'game' })).toMatchObject({ ok: true });
    expect(verifyLogin({ message: g.message, signature: g.signature, domain: DOMAIN, now: NOW })).toMatchObject({ ok: false });
    expect(verifyLogin({ message: w.message, signature: w.signature, domain: DOMAIN, now: NOW, purpose: 'game' })).toMatchObject({ ok: false });
    expect(verifyLogin({ message: w.message, signature: w.signature, domain: DOMAIN, now: NOW })).toMatchObject({ ok: true });
  });
});

describe('the game endpoint', () => {
  beforeEach(() => {
    resetRateLimit();
    resetAccountState();
  });

  it('keeps wallets of different networks apart', () => {
    expect(walletIdentity('evm', '0xAbC0000000000000000000000000000000000001')).toEqual({ network: 'evm', addressNorm: '0xabc0000000000000000000000000000000000001', owner: 'evm:0xabc0000000000000000000000000000000000001' });
    expect(walletIdentity('solana', 'AbC').addressNorm).toBe('AbC');
  });

  it('creates a player on the first Solana sign-in and finds the same one on the next', async () => {
    const t = setup();
    const priv = ed25519.utils.randomPrivateKey();
    const a = solana(await t.nonce(), 'game', priv);
    const r1 = await t.call({ op: 'login', message: a.message, signature: a.signature });
    expect(r1.status).toBe(200);
    const one = JSON.parse(r1.body) as { token: string; created: boolean; profile: { playerId: string; explorerLevel: number }; network: string };
    expect(one.created).toBe(true);
    expect(one.network).toBe('solana');
    const b = solana(await t.nonce(), 'game', priv);
    const two = JSON.parse((await t.call({ op: 'login', message: b.message, signature: b.signature })).body) as { created: boolean; profile: { playerId: string } };
    expect(two.created).toBe(false);
    expect(two.profile.playerId).toBe(one.profile.playerId);
    expect(t.players).toHaveLength(1);
    expect(t.wallets).toHaveLength(1);
    expect(t.activities.map((x) => x.activity_type)).toEqual(['wallet_connected', 'login', 'login']);
    expect(t.activities.every((x) => x.player_id === one.profile.playerId && x.network === 'solana' && x.wallet_address === a.address)).toBe(true);
  });

  it('signs an Ethereum-style wallet in with a lower-case identity, as a different player from any Solana wallet', async () => {
    const t = setup();
    const e = evm(await t.nonce());
    const r = JSON.parse((await t.call({ op: 'login', message: e.message, signature: e.signature })).body) as { network: string };
    expect(r.network).toBe('evm');
    expect(t.wallets[0]).toMatchObject({ network: 'evm', address_norm: e.address.toLowerCase() });
    const s = solana(await t.nonce());
    await t.call({ op: 'login', message: s.message, signature: s.signature });
    expect(t.players).toHaveLength(2);
  });

  it('refuses a replayed signature, a wallet-purpose message, a wrong signature and an unknown nonce', async () => {
    const t = setup();
    const a = solana(await t.nonce());
    expect((await t.call({ op: 'login', message: a.message, signature: a.signature })).status).toBe(200);
    expect((await t.call({ op: 'login', message: a.message, signature: a.signature })).status).toBe(401);
    const w = solana(await t.nonce(), 'wallet');
    expect((await t.call({ op: 'login', message: w.message, signature: w.signature })).status).toBe(401);
    const bad = solana(await t.nonce());
    const other = solana('ee'.repeat(16));
    expect((await t.call({ op: 'login', message: bad.message, signature: other.signature })).status).toBe(401);
    const unknown = solana('ff'.repeat(16));
    expect((await t.call({ op: 'login', message: unknown.message, signature: unknown.signature })).status).toBe(401);
    expect(t.players).toHaveLength(1);
  });

  it('gives a game token that works only for the game, and a wallet token that does not work for the game', async () => {
    const t = setup();
    const a = solana(await t.nonce());
    const token = (JSON.parse((await t.call({ op: 'login', message: a.message, signature: a.signature })).body) as { token: string }).token;
    expect(token.startsWith('g1.')).toBe(true);
    expect((await t.call({ op: 'me' }, `Bearer ${token}`)).status).toBe(200);
    expect((await t.walletCall({ op: 'get' })).status).toBe(401);
    expect((await t.walletCall({ op: 'get' }, `Bearer ${token}`)).status).toBe(401); // a game token is no use to the wallet
    const w = solana(await t.nonce(), 'wallet');
    const walletLogin = JSON.parse((await t.walletCall({ op: 'login', message: w.message, signature: w.signature })).body) as { token: string };
    expect((await t.call({ op: 'me' }, `Bearer ${walletLogin.token}`)).status).toBe(401);
  });

  it('ends every game session on sign-out-everywhere, and needs a session for everything but sign-in', async () => {
    const t = setup();
    expect((await t.call({ op: 'me' })).status).toBe(401);
    expect((await t.call({ op: 'me' }, 'Bearer nope')).status).toBe(401);
    const a = solana(await t.nonce());
    const token = (JSON.parse((await t.call({ op: 'login', message: a.message, signature: a.signature })).body) as { token: string }).token;
    expect((await t.call({ op: 'sign-out-all' }, `Bearer ${token}`)).status).toBe(200);
    expect((await t.call({ op: 'me' }, `Bearer ${token}`)).status).toBe(401);
    expect(t.sessionOwners.length).toBeGreaterThan(0);
    expect(t.sessionOwners.every((k) => k.startsWith('game:'))).toBe(true);
  });

  it('refuses a bad origin and a wrong method, and a token past its time', async () => {
    const t = setup();
    expect((await t.call({ op: 'nonce' }, null, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await t.call({}, null, { method: 'GET' })).status).toBe(405);
    const a = solana(await t.nonce());
    const token = (JSON.parse((await t.call({ op: 'login', message: a.message, signature: a.signature })).body) as { token: string }).token;
    expect(readGameSession(SECRET, `Bearer ${token}`, NOW)).toMatchObject({ owner: `solana:${a.address}` });
    expect(readGameSession(SECRET, `Bearer ${token}`, NOW + 8 * 86_400_000)).toBeNull();
    expect(readGameSession('other', `Bearer ${token}`, NOW)).toBeNull();
  });
});

describe('cities', () => {
  beforeEach(() => {
    resetRateLimit();
    resetAccountState();
  });
  const signedIn = async (t: ReturnType<typeof setup>) => {
    const a = solana(await t.nonce());
    const res = JSON.parse((await t.call({ op: 'login', message: a.message, signature: a.signature })).body) as { token: string };
    return `Bearer ${res.token}`;
  };

  it('lists all nine cities with no progress for a new player, and needs a session', async () => {
    const t = setup();
    expect((await t.call({ op: 'cities' })).status).toBe(401);
    const r = JSON.parse((await t.call({ op: 'cities' }, await signedIn(t))).body) as { selected: string | null; cities: { id: string; status: string; progress: unknown }[] };
    expect(r.selected).toBeNull();
    expect(r.cities).toHaveLength(9);
    expect(r.cities.every((c) => c.status === 'active' && c.progress === null)).toBe(true);
  });

  it("keeps each city's progress when the player switches, and records first visit, change and return", async () => {
    const t = setup();
    const auth = await signedIn(t);
    const first = JSON.parse((await t.call({ op: 'select-city', city: 'lagos' }, auth)).body) as { selected: string; first: boolean; changed: boolean };
    expect(first).toMatchObject({ selected: 'lagos', first: true, changed: false });
    t.raw.exec("update game_player_cities set city_xp = 50 where city_id = 'lagos'"); // progress earned in Lagos
    const second = JSON.parse((await t.call({ op: 'select-city', city: 'paris' }, auth)).body) as { selected: string; first: boolean; changed: boolean; cities: { id: string; progress: { cityXp: number } | null }[] };
    expect(second).toMatchObject({ selected: 'paris', first: true, changed: true });
    const back = JSON.parse((await t.call({ op: 'select-city', city: 'lagos' }, auth)).body) as { first: boolean; cities: { id: string; progress: { cityXp: number } | null }[] };
    expect(back.first).toBe(false);
    expect(back.cities.find((c) => c.id === 'lagos')!.progress!.cityXp).toBe(50);
    expect(back.cities.find((c) => c.id === 'paris')!.progress).not.toBeNull();
    expect(t.playerCities).toHaveLength(2);
    const kinds = t.activities.filter((x) => String(x.activity_type).startsWith('city_')).map((x) => x.activity_type);
    expect(kinds).toEqual(['city_selected', 'city_changed', 'city_changed']);
  });

  it('refuses an unknown city and a city that is not open, and does not change the selection', async () => {
    const t = setup();
    const auth = await signedIn(t);
    expect((await t.call({ op: 'select-city', city: 'atlantis' }, auth)).status).toBe(400);
    expect((await t.call({ op: 'select-city', city: 42 }, auth)).status).toBe(400);
    t.raw.exec("update game_cities set status = 'inactive' where id = 'miami'");
    expect((await t.call({ op: 'select-city', city: 'miami' }, auth)).status).toBe(409);
    expect(t.playerCities).toHaveLength(0);
    expect(JSON.parse((await t.call({ op: 'me' }, auth)).body).profile.selectedCity).toBeNull();
  });
});

describe('travel and flights', () => {
  beforeEach(() => {
    resetRateLimit();
    resetAccountState();
  });
  const signedIn = async (t: ReturnType<typeof setup>) => {
    const a = solana(await t.nonce());
    const res = JSON.parse((await t.call({ op: 'login', message: a.message, signature: a.signature })).body) as { token: string };
    return `Bearer ${res.token}`;
  };
  type State = { selected: string | null; flight: { to: string; arrivesAt: number } | null; position: [number, number] | null; travel: { mode: string; arrivesAt: number } | null; message?: string };
  const at = (t: ReturnType<typeof setup>, auth: string, now: number) => (body: Record<string, unknown>) => t.call(body, auth, { now });

  it('walks across a city on the server clock, one journey at a time, only inside the city and with its own transport', async () => {
    const t = setup();
    const auth = await signedIn(t);
    const go = at(t, auth, NOW);
    expect((await go({ op: 'travel', city: 'lagos', mode: 'walk', to: [3.4, 6.5] })).status).toBe(409); // no city chosen yet
    await go({ op: 'select-city', city: 'lagos' });
    const start = JSON.parse((await go({ op: 'travel', city: 'lagos', mode: 'walk', to: [3.4, 6.5] })).body) as State;
    expect(start.travel!.mode).toBe('walk');
    expect(start.travel!.arrivesAt).toBeGreaterThan(NOW + 1_999);
    expect((await go({ op: 'travel', city: 'lagos', mode: 'taxi', to: [3.38, 6.52] })).status).toBe(409); // already moving
    const mid = JSON.parse((await go({ op: 'state' })).body) as State;
    expect(mid.travel).not.toBeNull();
    const done = JSON.parse((await at(t, auth, start.travel!.arrivesAt + 1)({ op: 'state' })).body) as State;
    expect(done.travel).toBeNull();
    expect(done.position).toEqual([3.4, 6.5]);
    const later = at(t, auth, start.travel!.arrivesAt + 10);
    expect((await later({ op: 'travel', city: 'lagos', mode: 'run', to: [10, 10] })).status).toBe(400); // outside Lagos
    expect((await later({ op: 'travel', city: 'lagos', mode: 'metro', to: [3.5, 6.5] })).status).toBe(400); // Lagos has no metro here
    expect((await later({ op: 'travel', city: 'lagos', mode: 'flight', to: [3.5, 6.5] })).status).toBe(400); // flights are a separate op
    expect((await later({ op: 'travel', city: 'lagos', mode: 'walk', to: [3.4, 6.5] })).status).toBe(400); // already there
    expect((await later({ op: 'travel', city: 'paris', mode: 'walk', to: [2.3, 48.85] })).status).toBe(409); // not in Paris
    expect(t.activities.filter((x) => x.activity_type === 'journey_started')).toHaveLength(1);
  });

  it('flies between cities on the server clock, and keeps the player from acting while in the air', async () => {
    const t = setup();
    const auth = await signedIn(t);
    const go = at(t, auth, NOW);
    expect((await go({ op: 'fly', to: 'london' })).status).toBe(409); // no city chosen yet
    await go({ op: 'select-city', city: 'lagos' });
    expect((await go({ op: 'fly', to: 'lagos' })).status).toBe(400);
    expect((await go({ op: 'fly', to: 'atlantis' })).status).toBe(400);
    t.raw.exec("update game_cities set status = 'inactive' where id = 'paris'");
    expect((await go({ op: 'fly', to: 'paris' })).status).toBe(409);
    const up = JSON.parse((await go({ op: 'fly', to: 'london' })).body) as State;
    expect(up.flight!.to).toBe('london');
    expect(up.flight!.arrivesAt - NOW).toBeGreaterThanOrEqual(8_000);
    expect((await go({ op: 'select-city', city: 'dubai' })).status).toBe(409);
    expect((await go({ op: 'travel', city: 'lagos', mode: 'walk', to: [3.4, 6.5] })).status).toBe(409);
    expect((await go({ op: 'fly', to: 'dubai' })).status).toBe(409);
    expect(JSON.parse((await go({ op: 'state' })).body).flight).not.toBeNull();
    const landed = JSON.parse((await at(t, auth, up.flight!.arrivesAt + 1)({ op: 'state' })).body) as State;
    expect(landed).toMatchObject({ selected: 'london', flight: null });
    expect(landed.position).toEqual([-0.1276, 51.5072]);
    expect(t.playerCities.map((r) => r.city_id).sort()).toEqual(['lagos', 'london']);
    expect(t.activities.map((x) => x.activity_type)).toEqual(expect.arrayContaining(['flight_started', 'flight_landed']));
  });
});

describe('travel rules', () => {
  it('measures distance and gives every player the same speeds and a bounded journey time', () => {
    const km = flightKm('lagos', 'london')!;
    expect(km).toBeGreaterThan(4800);
    expect(km).toBeLessThan(5200);
    expect(flightDurationMs(km)).toBeGreaterThan(flightDurationMs(500));
    expect(flightDurationMs(20_000)).toBeLessThanOrEqual(90_000);
    expect(localDurationMs(0.1, 'car')).toBe(2_000);
    expect(localDurationMs(500, 'walk')).toBe(120_000);
    expect(localDurationMs(10, 'run')).toBeLessThan(localDurationMs(10, 'walk'));
    expect(distanceKm([0, 0], [0, 0])).toBe(0);
    expect(along([0, 0], [10, 20], 50, 100)).toEqual([5, 10]);
    expect(along([0, 0], [10, 20], 500, 100)).toEqual([10, 20]);
  });

  it('keeps every city centre inside its own bounds, and flights possible between every pair', () => {
    for (const c of CITIES) {
      expect(inBounds(c, c.center), c.id).toBe(true);
      expect(c.transport).toContain('flight');
      for (const d of CITIES) if (d.id !== c.id) expect(flightKm(c.id, d.id)).toBeGreaterThan(1);
    }
    expect(CITIES).toHaveLength(9);
  });
});

describe('the admin gate', () => {
  beforeEach(() => {
    resetRateLimit();
    resetAccountState();
  });

  it('shows the admin ops only to a wallet in ADMIN_WALLETS; to anyone else they look like ops that do not exist', async () => {
    const t = setup();
    const priv = ed25519.utils.randomPrivateKey();
    const boss = solana(await t.nonce(), 'game', priv);
    const env = { ...ENV, ADMIN_WALLETS: `solana:${boss.address}` };
    const adminToken = (JSON.parse((await t.call({ op: 'login', message: boss.message, signature: boss.signature }, null, { env })).body) as { token: string }).token;
    const other = solana(await t.nonce());
    const userToken = (JSON.parse((await t.call({ op: 'login', message: other.message, signature: other.signature }, null, { env })).body) as { token: string }).token;
    const as = (token: string, op: string) => t.call({ op }, `Bearer ${token}`, { env });

    expect(JSON.parse((await as(adminToken, 'me')).body).admin).toBe(true);
    expect(JSON.parse((await as(userToken, 'me')).body).admin).toBe(false);
    expect((await as(adminToken, 'admin-audit')).status).toBe(200);
    const denied = await as(userToken, 'admin-audit');
    const unknown = await as(userToken, 'admin-no-such-op');
    expect(denied.status).toBe(404);
    expect(denied.body).toBe(unknown.body);
    expect((await as(adminToken, 'admin-no-such-op')).status).toBe(404);
    expect((await t.call({ op: 'admin-audit' }, null, { env })).status).toBe(401); // no session at all
    // With no administrators configured, nobody is one.
    expect((await as(adminToken, 'admin-audit').then(() => t.call({ op: 'admin-audit' }, `Bearer ${adminToken}`))).status).toBe(404);
  });
});

describe('the game stays apart from ACT', () => {
  it('mentions no token, staking or fee code in the game module or its API', () => {
    const files: string[] = [join(process.cwd(), 'api', '_game.ts')];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p);
      }
    };
    walk(join(process.cwd(), 'src', 'game'));
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      // Code only: the sign-in statement may say "uses no ACT".
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/'[^'\n]*'/g, "''");
      expect(code, f).not.toMatch(/\bACT\b|staking|walletCurve|walletAretiaPool|sendTransaction|signTransaction|eth_sendTransaction/);
    }
  });
});

describe('guessing limits', () => {
  it('limits answers per address as well as per player', async () => {
    resetRateLimit();
    resetAccountState();
    const t = setup();
    const a = solana(await t.nonce());
    const token = (JSON.parse((await t.call({ op: 'login', message: a.message, signature: a.signature })).body) as { token: string }).token;
    const auth = `Bearer ${token}`;
    let limited = 0;
    for (let i = 0; i < 40; i++) if ((await t.call({ op: 'answer', mission: 'some-mission', answer: String(i) }, auth, { ip: '9.9.9.9' })).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
    // Another address is not held back by it.
    expect((await t.call({ op: 'answer', mission: 'some-mission', answer: '1' }, auth, { ip: '8.8.8.8' })).status).not.toBe(429);
  });
});
