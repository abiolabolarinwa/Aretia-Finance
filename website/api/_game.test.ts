import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak256 } from '../src/swings/core/keccak.js';
import { loginMessage, parseLoginMessage, type LoginPurpose } from '../src/swings/account/loginMessage.js';
import { resetRateLimit } from './_rpcProxy.js';
import { handleAccount, resetAccountState } from './_swingsAccount.js';
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

function setup() {
  const nonces = new Map<string, { expires_at: number; used_at: number | null }>();
  const versions = new Map<string, number>();
  const players: { id: string }[] = [];
  const wallets: { player_id: string; network: string; address_norm: string }[] = [];
  const profiles = new Map<string, Record<string, unknown>>();
  const activities: { player_id: string; activity_type: string; network: string; wallet_address: string }[] = [];
  const cityStatus = new Map<string, string>(['lagos','new-york','nairobi','hong-kong','london','dubai','paris','miami','nicosia'].map((c) => [c, 'active']));
  const playerCities: Record<string, unknown>[] = [];
  let seq = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const params = new URLSearchParams(url.split('?')[1] ?? '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url.includes('/rest/v1/auth_nonces')) {
      if (method === 'POST') {
        nonces.set(String(body.nonce), { expires_at: Number(body.expires_at), used_at: null });
        return new Response('', { status: 201 });
      }
      const n = nonces.get(params.get('nonce')!.slice(3));
      if (!n || n.used_at !== null || n.expires_at <= Number(params.get('expires_at')!.slice(3))) return new Response('[]');
      n.used_at = Number(body.used_at);
      return new Response(JSON.stringify([n]));
    }
    if (url.includes('/rest/v1/account_sessions')) {
      if (method === 'POST') {
        versions.set(String(body.owner), Number(body.version));
        return new Response('', { status: 201 });
      }
      const v = versions.get(decodeURIComponent(params.get('owner')!.slice(3)));
      return new Response(JSON.stringify(v === undefined ? [] : [{ version: v }]));
    }
    if (url.includes('/rest/v1/game_journeys')) return new Response('', { status: 201 });
    if (url.includes('/rest/v1/game_cities')) {
      if (params.has('id')) {
        const id = params.get('id')!.slice(3);
        return new Response(JSON.stringify(cityStatus.has(id) ? [{ id, status: cityStatus.get(id) }] : []));
      }
      return new Response(JSON.stringify([...cityStatus].map(([id, status]) => ({ id, status }))));
    }
    if (url.includes('/rest/v1/game_player_cities')) {
      const pid = params.get('player_id')?.slice(3);
      const cid = params.get('city_id')?.slice(3);
      if (method === 'POST') {
        if (!playerCities.some((r) => r.player_id === body.player_id && r.city_id === body.city_id)) playerCities.push({ city_xp: 0, discoveries: 0, completed_missions: 0, exploration_status: 'exploring', ...body });
        return new Response('', { status: 201 });
      }
      if (method === 'PATCH') {
        Object.assign(playerCities.find((r) => r.player_id === pid && r.city_id === cid)!, body);
        return new Response('');
      }
      return new Response(JSON.stringify(playerCities.filter((r) => r.player_id === pid && (!cid || r.city_id === cid))));
    }
    if (url.includes('/rest/v1/game_player_wallets')) {
      if (method === 'POST') {
        if (wallets.some((w) => w.network === body.network && w.address_norm === body.address_norm)) return new Response('{}', { status: 409 });
        wallets.push({ player_id: String(body.player_id), network: String(body.network), address_norm: String(body.address_norm) });
        return new Response('', { status: 201 });
      }
      const net = params.get('network')!.slice(3);
      const addr = decodeURIComponent(params.get('address_norm')!.slice(3));
      const w = wallets.find((x) => x.network === net && x.address_norm === addr);
      return new Response(JSON.stringify(w ? [{ player_id: w.player_id }] : []));
    }
    if (url.includes('/rest/v1/game_players')) {
      if (method === 'POST') {
        const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
        players.push({ id });
        return new Response(JSON.stringify([{ id }]), { status: 201 });
      }
      return new Response('');
    }
    if (url.includes('/rest/v1/game_player_profiles')) {
      if (method === 'POST') {
        profiles.set(String(body.player_id), { display_name: '', avatar: null, explorer_level: 1, total_xp: 0, total_discoveries: 0, missions_completed: 0 });
        return new Response('', { status: 201 });
      }
      if (method === 'PATCH') {
        Object.assign(profiles.get(params.get('player_id')!.slice(3))!, body);
        return new Response('');
      }
      const id = params.get('player_id')!.slice(3);
      return new Response(JSON.stringify(profiles.has(id) ? [profiles.get(id)] : []));
    }
    if (url.includes('/rest/v1/game_player_activities')) {
      activities.push({ player_id: String(body.player_id), activity_type: String(body.activity_type), network: String(body.network), wallet_address: String(body.wallet_address) });
      return new Response('', { status: 201 });
    }
    return new Response('');
  }) as unknown as typeof fetch;
  const base = { method: 'POST', origin: ORIGIN, authorization: null as string | null, ip: '5.5.5.5', env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test' }, fetchImpl, now: NOW };
  const call = (body: unknown, auth: string | null = null, over: Partial<GameInput> = {}) => handleGame({ ...base, authorization: auth, body, ...over });
  const nonce = async (): Promise<string> => (JSON.parse((await call({ op: 'nonce' })).body) as { nonce: string }).nonce;
  const walletCall = (body: unknown) => handleAccount({ ...base, body });
  return { call, nonce, walletCall, cityStatus, playerCities, players, wallets, activities, versions, nonces };
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
    expect((await t.walletCall({ op: 'get' }) as { status: number }).status).toBe(401);
    expect((await handleAccount({ method: 'POST', origin: ORIGIN, authorization: `Bearer ${token}`, ip: '6.6.6.6', body: { op: 'get' }, env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test' }, fetchImpl: (async () => new Response('[]')) as unknown as typeof fetch, now: NOW })).status).toBe(401);
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
    expect([...t.versions.keys()].every((k) => k.startsWith('game:'))).toBe(true);
  });

  it('refuses a bad origin and a wrong method, and a token past its time', async () => {
    const t = setup();
    expect((await t.call({ op: 'nonce' }, null, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await t.call({}, null, { method: 'GET' })).status).toBe(405);
    const a = solana(await t.nonce());
    const token = (JSON.parse((await t.call({ op: 'login', message: a.message, signature: a.signature })).body) as { token: string }).token;
    expect(readGameSession('sb_secret_test', `Bearer ${token}`, NOW)).toMatchObject({ owner: `solana:${a.address}` });
    expect(readGameSession('sb_secret_test', `Bearer ${token}`, NOW + 8 * 86_400_000)).toBeNull();
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
    t.playerCities[0]!.city_xp = 50; // progress earned in Lagos
    const second = JSON.parse((await t.call({ op: 'select-city', city: 'paris' }, auth)).body) as { selected: string; first: boolean; changed: boolean; cities: { id: string; progress: { cityXp: number } | null }[] };
    expect(second).toMatchObject({ selected: 'paris', first: true, changed: true });
    const back = JSON.parse((await t.call({ op: 'select-city', city: 'lagos' }, auth)).body) as { first: boolean; cities: { id: string; progress: { cityXp: number } | null }[] };
    expect(back.first).toBe(false);
    expect(back.cities.find((c) => c.id === 'lagos')!.progress!.cityXp).toBe(50);
    expect(back.cities.find((c) => c.id === 'paris')!.progress).not.toBeNull();
    expect(t.playerCities).toHaveLength(2);
    const kinds = t.activities.filter((x) => x.activity_type.startsWith('city_')).map((x) => x.activity_type);
    expect(kinds).toEqual(['city_selected', 'city_changed', 'city_changed']);
  });

  it('refuses an unknown city and a city that is not open, and does not change the selection', async () => {
    const t = setup();
    const auth = await signedIn(t);
    expect((await t.call({ op: 'select-city', city: 'atlantis' }, auth)).status).toBe(400);
    expect((await t.call({ op: 'select-city', city: 42 }, auth)).status).toBe(400);
    t.cityStatus.set('miami', 'inactive');
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
    t.cityStatus.set('paris', 'inactive');
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
