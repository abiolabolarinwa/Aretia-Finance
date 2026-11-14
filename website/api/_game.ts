/**
 * POST /api/game: Ultimate City Search, milestone 2 (sign-in and the player's identity).
 *
 *   { op: 'nonce' }                       a single-use value for the sign-in message (valid five minutes)
 *   { op: 'login', message, signature }  prove control of a wallet; answers with a game session and the player's profile
 *   { op: 'me' }                          the signed-in player's profile
 *   { op: 'logout' }                      record the sign-out
 *   { op: 'sign-out-all' }                end every game session of this wallet, on every device
 *
 * The game is separate from the wallet and from ACT. A game sign-in message says so and is refused by the wallet endpoint (and the
 * reverse), and a game token (kind "g1") is refused everywhere else. Signing is free and cannot move funds. Nothing here touches a
 * token, a fee or a transaction. The wallet is how a player proves who they are; the permanent key is the internal player id.
 * Needs the same database and migrations 0014 and 0024.
 */
import { isOriginAllowed, overLimit, type ProxyEnv } from './_rpcProxy.js';
import { LOGIN_WINDOW_MS } from '../src/swings/account/loginMessage.js';
import { loginDomains, openToken, SESSION_MS, sessionSecret, sessionVersion, signToken, verifyLogin } from './_swingsAuth.js';
import type { Rest } from './_swingsAccount.js';
import { overBudget } from './_limits.js';
import { allCities, cityById } from '../src/game/cities.js';
import { loadCatalogue, publicCity } from './_gameCatalogue.js';
import { missionOp } from './_gameMissions.js';
import { boardOp } from './_gameBoards.js';
import { adminOp, playerAdminOp } from './_gameAdmin.js';
import { adminOwners } from './_adminOwners.js';
import { evaluateAchievements, history, progress, setDisplayName } from './_gameProgress.js';
import { isRoamMode, roamAllowed } from '../src/game/roamRules.js';
import { distanceKm, flightDurationMs, flightKm, inBounds, isLocalMode, localDurationMs, type LngLat } from '../src/game/travel.js';

export interface GameInput {
  method: string;
  origin: string | null;
  authorization: string | null;
  ip: string;
  body: unknown;
  /** The game's database (Cloudflare D1, through `d1Rest`). */
  db: Rest;
  env: ProxyEnv & { SWINGS_SESSION_SECRET?: string; SWINGS_LOGIN_DOMAINS?: string; VERCEL_ENV?: string; GAME_ANSWER_SECRET?: string; GAME_PRIZES_ENABLED?: string; ADMIN_WALLETS?: string };
  now: number;
}
export interface GameOutput {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const NONCES_PER_MINUTE = 20;
const TOKEN_KIND = 'g1';

const randomHex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const json = (status: number, data: unknown, headers: Record<string, string>): GameOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The wallet identity: network plus the normalised address, so an EVM and a Solana address can never be mistaken for each other. */
export function walletIdentity(family: 'evm' | 'solana', address: string): { network: 'evm' | 'solana'; addressNorm: string; owner: string } {
  const addressNorm = family === 'evm' ? address.toLowerCase() : address;
  return { network: family, addressNorm, owner: `${family}:${addressNorm}` };
}

/** The key the game's session version is kept under, apart from the wallet's own sessions. */
const versionKey = (owner: string): string => `game:${owner}`;

export interface GameClaims {
  playerId: string;
  owner: string;
  version: number;
}

export function issueGameSession(secret: string, playerId: string, owner: string, now: number, version: number): { token: string; expiresAt: number } {
  const expiresAt = now + SESSION_MS;
  return { token: signToken(secret, TOKEN_KIND, { p: playerId, o: owner, e: expiresAt, v: version }), expiresAt };
}

export function readGameSession(secret: string, authorization: string | null, now: number): GameClaims | null {
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
  if (!bearer) return null;
  const p = openToken(secret, TOKEN_KIND, bearer);
  if (!p || typeof p.p !== 'string' || typeof p.o !== 'string' || typeof p.e !== 'number' || p.e <= now) return null;
  const version = typeof p.v === 'number' && Number.isInteger(p.v) && p.v >= 0 ? p.v : -1;
  return version < 0 || !/^[0-9a-f-]{36}$/.test(p.p) ? null : { playerId: p.p, owner: p.o, version };
}

interface WalletRow { player_id: string }
interface ProfileRow { selected_city?: string | null; display_name: string; avatar: string | null; explorer_level: number; total_xp: number; total_discoveries: number; missions_completed: number }

async function findPlayer(db: Rest, network: string, addressNorm: string): Promise<string | null> {
  const rows = (await db.call(`game_player_wallets?network=eq.${network}&address_norm=eq.${encodeURIComponent(addressNorm)}&select=player_id&limit=1`)) as WalletRow[] | null;
  return Array.isArray(rows) && rows[0] ? rows[0].player_id : null;
}

/** The player behind a wallet: the existing one, or a new one. A second wallet never joins an existing player here (no automatic merging). */
async function playerFor(db: Rest, network: 'evm' | 'solana', addressNorm: string, now: number): Promise<{ id: string; created: boolean }> {
  const existing = await findPlayer(db, network, addressNorm);
  if (existing) return { id: existing, created: false };
  const made = (await db.call('game_players', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ created_at: now }) })) as { id: string }[];
  const id = made[0]!.id;
  try {
    await db.call('game_player_wallets', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ player_id: id, network, address_norm: addressNorm, verified_at: now, is_primary: true }) });
  } catch (e) {
    // Another sign-in of the same wallet won the race (unique network + address). Use that player and drop the unused one.
    const winner = await findPlayer(db, network, addressNorm);
    await db.call(`game_players?id=eq.${id}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } }).catch(() => undefined);
    if (winner) return { id: winner, created: false };
    throw e;
  }
  await db.call('game_player_profiles', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ player_id: id }) });
  return { id, created: true };
}

async function logActivity(db: Rest, playerId: string, network: string, addressNorm: string, type: string, now: number, metadata: Record<string, unknown> = {}, cityId: string | null = null): Promise<void> {
  await db.call('game_player_activities', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ player_id: playerId, wallet_address: addressNorm, network, activity_type: type, city_id: cityId, metadata, created_at: now }) });
}

async function profileOf(db: Rest, playerId: string): Promise<Record<string, unknown>> {
  const rows = (await db.call(`game_player_profiles?player_id=eq.${playerId}&select=display_name,avatar,explorer_level,total_xp,total_discoveries,missions_completed,selected_city&limit=1`)) as ProfileRow[] | null;
  const p = rows?.[0];
  return { playerId, displayName: p?.display_name ?? '', avatar: p?.avatar ?? null, explorerLevel: p?.explorer_level ?? 1, totalXp: Number(p?.total_xp ?? 0), totalDiscoveries: p?.total_discoveries ?? 0, missionsCompleted: p?.missions_completed ?? 0, selectedCity: p?.selected_city && cityById(p.selected_city) ? p.selected_city : null };
}

interface CityRow { id: string; status: string }
interface PlayerCityRow { city_id: string; first_visit_at: number; last_visit_at: number; city_xp: number; discoveries: number; completed_missions: number; exploration_status: string }

const cityProgress = (r: PlayerCityRow): Record<string, unknown> => ({ firstVisitAt: Number(r.first_visit_at), lastVisitAt: Number(r.last_visit_at), cityXp: Number(r.city_xp), discoveries: r.discoveries, completedMissions: r.completed_missions, explorationStatus: r.exploration_status });

/** Every city with its status and this player's progress in it (null when never visited), and the city last chosen. */
async function listCities(db: Rest, playerId: string): Promise<Record<string, unknown>> {
  const [mine, profile] = await Promise.all([
    db.call(`game_player_cities?player_id=eq.${playerId}&select=city_id,first_visit_at,last_visit_at,city_xp,discoveries,completed_missions,exploration_status`) as Promise<PlayerCityRow[] | null>,
    profileOf(db, playerId),
  ]);
  const progress = new Map((mine ?? []).map((r) => [r.city_id, r]));
  return {
    selected: profile.selectedCity,
    cities: allCities().filter((c) => c.status !== 'inactive').map((c) => {
      const p = progress.get(c.id);
      return { ...publicCity(c), progress: p ? cityProgress(p) : null };
    }),
  };
}

/**
 * Chooses a city. The first visit creates the player's progress row for it; later visits only touch the visit time, so switching
 * city never resets anything. Only an active city from the catalogue can be chosen.
 */
async function selectCity(db: Rest, claims: { playerId: string }, network: string, addressNorm: string, cityId: unknown, now: number): Promise<{ ok: true; city: string; first: boolean; changed: boolean } | { ok: false; status: number; message: string }> {
  const city = typeof cityId === 'string' ? cityById(cityId) : undefined;
  if (!city) return { ok: false, status: 400, message: 'That city does not exist.' };
  const rows = (await db.call(`game_cities?id=eq.${city.id}&select=id,status&limit=1`)) as CityRow[] | null;
  if (rows?.[0]?.status !== 'active') return { ok: false, status: 409, message: `${city.name} is not open yet.` };
  const before = (await profileOf(db, claims.playerId)).selectedCity as string | null;
  const existing = (await db.call(`game_player_cities?player_id=eq.${claims.playerId}&city_id=eq.${city.id}&select=city_id&limit=1`)) as unknown[] | null;
  const first = !existing || existing.length === 0;
  if (first) await db.call('game_player_cities?on_conflict=player_id,city_id', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ player_id: claims.playerId, city_id: city.id, first_visit_at: now, last_visit_at: now, pos_lng: city.center[0], pos_lat: city.center[1] }) });
  else await db.call(`game_player_cities?player_id=eq.${claims.playerId}&city_id=eq.${city.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ last_visit_at: now }) });
  await db.call(`game_player_profiles?player_id=eq.${claims.playerId}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ selected_city: city.id }) });
  const changed = before !== null && before !== city.id;
  await logActivity(db, claims.playerId, network, addressNorm, changed ? 'city_changed' : 'city_selected', now, { from: before, first }, city.id);
  return { ok: true, city: city.id, first, changed };
}

interface TravelRow { city_id: string; pos_lng: number | null; pos_lat: number | null; travel_mode: string | null; travel_from_lng: number | null; travel_from_lat: number | null; travel_to_lng: number | null; travel_to_lat: number | null; travel_departed_at: number | null; travel_arrives_at: number | null }
interface FlightRow { selected_city: string | null; flight_from: string | null; flight_to: string | null; flight_departed_at: number | null; flight_arrives_at: number | null }
const TRAVEL_COLS = 'city_id,pos_lng,pos_lat,travel_mode,travel_from_lng,travel_from_lat,travel_to_lng,travel_to_lat,travel_departed_at,travel_arrives_at';

async function flightRow(db: Rest, playerId: string): Promise<FlightRow> {
  const rows = (await db.call(`game_player_profiles?player_id=eq.${playerId}&select=selected_city,flight_from,flight_to,flight_departed_at,flight_arrives_at&limit=1`)) as FlightRow[] | null;
  return rows?.[0] ?? { selected_city: null, flight_from: null, flight_to: null, flight_departed_at: null, flight_arrives_at: null };
}

const flightView = (f: FlightRow): Record<string, unknown> | null => (f.flight_to && f.flight_from ? { from: f.flight_from, to: f.flight_to, departedAt: Number(f.flight_departed_at), arrivesAt: Number(f.flight_arrives_at) } : null);

/** Lands a flight whose time has passed: the destination becomes the selected city. Returns the flight still in the air, if any. */
async function settleFlight(db: Rest, claims: { playerId: string }, network: string, addressNorm: string, now: number): Promise<Record<string, unknown> | null> {
  const f = await flightRow(db, claims.playerId);
  if (!f.flight_to) return null;
  if (Number(f.flight_arrives_at) > now) return flightView(f);
  const to = f.flight_to;
  await db.call(`game_player_profiles?player_id=eq.${claims.playerId}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ flight_from: null, flight_to: null, flight_departed_at: null, flight_arrives_at: null }) });
  await selectCity(db, claims, network, addressNorm, to, now);
  await logActivity(db, claims.playerId, network, addressNorm, 'flight_landed', now, { from: f.flight_from }, to);
  return null;
}

async function travelRow(db: Rest, playerId: string, cityId: string): Promise<TravelRow | null> {
  const rows = (await db.call(`game_player_cities?player_id=eq.${playerId}&city_id=eq.${cityId}&select=${TRAVEL_COLS}&limit=1`)) as TravelRow[] | null;
  return rows?.[0] ?? null;
}

/** The player's position in a city, finishing a journey whose time has passed. `travel` is the journey still under way, if any. */
async function exploreState(db: Rest, playerId: string, cityId: string, now: number): Promise<{ position: LngLat; travel: Record<string, unknown> | null }> {
  const city = cityById(cityId)!;
  const row = await travelRow(db, playerId, cityId);
  let position: LngLat = row?.pos_lng != null && row.pos_lat != null ? [row.pos_lng, row.pos_lat] : city.center;
  if (row?.travel_arrives_at != null && row.travel_to_lng != null && row.travel_to_lat != null) {
    if (Number(row.travel_arrives_at) > now) {
      return { position, travel: { mode: row.travel_mode, from: [row.travel_from_lng, row.travel_from_lat], to: [row.travel_to_lng, row.travel_to_lat], departedAt: Number(row.travel_departed_at), arrivesAt: Number(row.travel_arrives_at) } };
    }
    position = [row.travel_to_lng, row.travel_to_lat];
    await db.call(`game_player_cities?player_id=eq.${playerId}&city_id=eq.${cityId}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ pos_lng: position[0], pos_lat: position[1], travel_mode: null, travel_from_lng: null, travel_from_lat: null, travel_to_lng: null, travel_to_lat: null, travel_departed_at: null, travel_arrives_at: null }) });
  }
  return { position, travel: null };
}

type Refusal = { ok: false; status: number; message: string };
const refuse = (status: number, message: string): Refusal => ({ ok: false, status, message });

/** Starts a journey across the selected city. The server sets the arrival time; a second journey waits for the first. */
async function startTravel(db: Rest, claims: { playerId: string }, network: string, addressNorm: string, body: Record<string, unknown>, now: number): Promise<{ ok: true } | Refusal> {
  if (await settleFlight(db, claims, network, addressNorm, now)) return refuse(409, 'You are in the air. Wait for the flight to land.');
  const selected = (await flightRow(db, claims.playerId)).selected_city;
  const city = typeof body.city === 'string' ? cityById(body.city) : undefined;
  if (!city || city.id !== selected) return refuse(409, 'You can only travel in the city you are in.');
  const mode = body.mode;
  if (!isLocalMode(mode) || !city.transport.includes(mode)) return refuse(400, `${city.name} has no such way of getting around.`);
  const to = Array.isArray(body.to) && body.to.length === 2 ? ([Number(body.to[0]), Number(body.to[1])] as LngLat) : null;
  if (!to || !inBounds(city, to)) return refuse(400, `That place is outside ${city.name}.`);
  const here = await exploreState(db, claims.playerId, city.id, now);
  if (here.travel) return refuse(409, 'You are already on a journey.');
  const km = distanceKm(here.position, to);
  if (km < 0.05) return refuse(400, 'You are already there.');
  const arrivesAt = now + localDurationMs(km, mode);
  await db.call(`game_player_cities?player_id=eq.${claims.playerId}&city_id=eq.${city.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ pos_lng: here.position[0], pos_lat: here.position[1], travel_mode: mode, travel_from_lng: here.position[0], travel_from_lat: here.position[1], travel_to_lng: to[0], travel_to_lat: to[1], travel_departed_at: now, travel_arrives_at: arrivesAt }) });
  await db.call('game_journeys', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ player_id: claims.playerId, kind: 'local', mode, from_city: city.id, to_city: city.id, distance_km: km, departed_at: now, arrives_at: arrivesAt }) });
  await logActivity(db, claims.playerId, network, addressNorm, 'journey_started', now, { mode, km: Math.round(km * 100) / 100, to }, city.id);
  return { ok: true };
}

/** Starts a simulated flight to another open city. Not a booking: it only moves the player in the game. */
async function startFlight(db: Rest, claims: { playerId: string }, network: string, addressNorm: string, body: Record<string, unknown>, now: number): Promise<{ ok: true } | Refusal> {
  if (await settleFlight(db, claims, network, addressNorm, now)) return refuse(409, 'You are already in the air.');
  const from = (await flightRow(db, claims.playerId)).selected_city;
  const dest = typeof body.to === 'string' ? cityById(body.to) : undefined;
  if (!from || !cityById(from)) return refuse(409, 'Choose a city first.');
  if (!dest) return refuse(400, 'That city does not exist.');
  if (dest.id === from) return refuse(400, 'You are already in that city.');
  const open = (await db.call(`game_cities?id=eq.${dest.id}&select=id,status&limit=1`)) as CityRow[] | null;
  if (open?.[0]?.status !== 'active') return refuse(409, `${dest.name} is not open yet.`);
  if ((await exploreState(db, claims.playerId, from, now)).travel) return refuse(409, 'Finish your journey before you fly.');
  const km = flightKm(from, dest.id)!;
  const arrivesAt = now + flightDurationMs(km);
  await db.call(`game_player_profiles?player_id=eq.${claims.playerId}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ flight_from: from, flight_to: dest.id, flight_departed_at: now, flight_arrives_at: arrivesAt }) });
  await db.call('game_journeys', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ player_id: claims.playerId, kind: 'flight', mode: 'flight', from_city: from, to_city: dest.id, distance_km: km, departed_at: now, arrives_at: arrivesAt }) });
  await logActivity(db, claims.playerId, network, addressNorm, 'flight_started', now, { to: dest.id, km: Math.round(km) }, from);
  return { ok: true };
}

async function fullState(db: Rest, playerId: string, now: number): Promise<Record<string, unknown>> {
  const f = await flightRow(db, playerId);
  const flight = f.flight_to && Number(f.flight_arrives_at) > now ? flightView(f) : null;
  const selected = f.selected_city && cityById(f.selected_city) ? f.selected_city : null;
  const here = selected && !flight ? await exploreState(db, playerId, selected, now) : null;
  return { serverNow: now, selected, flight, position: here?.position ?? null, travel: here?.travel ?? null };
}

/**
 * Records where the player has walked or driven to in the 3D world. The page moves the player freely; this accepts a report only if
 * it is no further from the last one than that way of travelling allows in the time since (see roamRules.ts), so the stored position,
 * which is what collecting a treasure is checked against, can only be reached by actually getting there.
 */
const FIRST_REPORT_MS = 5_000;

async function roam(db: Rest, claims: { playerId: string }, network: string, addressNorm: string, body: Record<string, unknown>, now: number): Promise<{ status: number; data: Record<string, unknown> }> {
  const fail = (status: number, message: string, extra: Record<string, unknown> = {}) => ({ status, data: { error: 'roam', message, ...extra } });
  if (await settleFlight(db, claims, network, addressNorm, now)) return fail(409, 'You are in the air. Wait for the flight to land.');
  const city = typeof body.city === 'string' ? cityById(body.city) : undefined;
  const selected = (await flightRow(db, claims.playerId)).selected_city;
  if (!city || city.id !== selected) return fail(409, 'You can only roam the city you are in.');
  if (!isRoamMode(body.mode)) return fail(400, 'Unknown way of getting around.');
  const to = Array.isArray(body.to) && body.to.length === 2 ? ([Number(body.to[0]), Number(body.to[1])] as LngLat) : null;
  if (!to || !inBounds(city, to)) return fail(400, 'That place is outside ' + city.name + '.');
  const row = await travelRow(db, claims.playerId, city.id);
  if (!row) return fail(409, 'Enter the city first.');
  if (row.travel_arrives_at != null && Number(row.travel_arrives_at) > now) return fail(409, 'You are on a timed journey. Let it finish, or stay on the map until it does.');
  const from: LngLat = row.pos_lng != null && row.pos_lat != null ? [row.pos_lng, row.pos_lat] : city.center;
  let at: number | null;
  try {
    const t = (await db.call(`game_player_cities?player_id=eq.${claims.playerId}&city_id=eq.${city.id}&select=pos_at&limit=1`)) as { pos_at: number | null }[] | null;
    at = t?.[0]?.pos_at ?? null;
  } catch {
    return fail(503, 'Roaming needs a database update (d1/0003_roam.sql) that has not been applied yet.');
  }
  // With no earlier report there is no elapsed time to count, so only a few seconds are allowed: a first report cannot be a jump.
  const check = roamAllowed(from, to, body.mode, at === null ? FIRST_REPORT_MS : now - Number(at));
  if (!check.ok) return fail(409, 'You moved too fast, so you were put back where you were.', { position: from, serverNow: now });
  await db.call(`game_player_cities?player_id=eq.${claims.playerId}&city_id=eq.${city.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ pos_lng: to[0], pos_lat: to[1], pos_at: now }) });
  return { status: 200, data: { position: to, serverNow: now } };
}

export async function handleGame(input: GameInput): Promise<GameOutput> {
  const headers: Record<string, string> = { vary: 'origin', 'cache-control': 'no-store' };
  const allowed = isOriginAllowed(input.origin, input.env);
  if (allowed) {
    headers['access-control-allow-origin'] = input.origin!;
    headers['access-control-allow-methods'] = 'POST, OPTIONS';
    headers['access-control-allow-headers'] = 'content-type, authorization';
  }
  if (input.method === 'OPTIONS') return { status: allowed ? 204 : 403, body: '', headers };
  if (input.method !== 'POST') return json(405, { error: 'method' }, { ...headers, allow: 'POST, OPTIONS' });
  if (!allowed) return json(403, { error: 'origin' }, headers);
  const secret = sessionSecret(input.env);
  if (!secret) return json(503, { error: 'not-configured', message: 'The game is not set up on this server yet.' }, headers);
  const body = obj(input.body);
  const op = body.op;
  // Roaming reports where the player is every moment or two, so it has its own allowance (per player, below) instead of the shared one.
  if (op !== 'roam' && overLimit(`game:${input.ip}`, input.now)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '60' });
  const db = input.db;
  try {
    await loadCatalogue(db, input.now);
  } catch {
    return json(502, { error: 'database', message: 'The game could not be reached.' }, headers);
  }
  // The list of cities is public: a visitor can see the cards before signing in.
  if (op === 'catalogue') return json(200, { cities: allCities().filter((c) => c.status !== 'inactive').map(publicCity) }, { ...headers, 'cache-control': 'public, max-age=30' });

  if (op === 'nonce') {
    if (overBudget(`gamenonce:${input.ip}`, input.now, NONCES_PER_MINUTE)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '60' });
    const nonce = randomHex(16);
    try {
      await db.call('auth_nonces', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ nonce, created_at: input.now, expires_at: input.now + LOGIN_WINDOW_MS }) });
    } catch {
      return json(502, { error: 'database', message: 'Signing in is not available right now.' }, headers);
    }
    return json(200, { nonce, expiresAt: input.now + LOGIN_WINDOW_MS }, headers);
  }

  if (op === 'login') {
    const message = typeof body.message === 'string' ? body.message : '';
    const signature = typeof body.signature === 'string' ? body.signature : '';
    if (!message || message.length > 1000 || !signature || signature.length > 400) return json(400, { error: 'bad-request' }, headers);
    const domains = loginDomains(input.env);
    if (input.env.VERCEL_ENV !== 'production') {
      const local = /^http:\/\/((?:localhost|127\.0\.0\.1)(?::\d+)?)$/.exec(input.origin ?? '')?.[1];
      if (local) domains.push(local);
    }
    const check = verifyLogin({ message, signature, domain: domains, now: input.now, purpose: 'game' });
    if (!check.ok) return json(401, { error: 'sign-in', message: check.reason }, headers);
    const id = walletIdentity(check.family, check.address);
    try {
      const used = (await db.call(`auth_nonces?nonce=eq.${encodeURIComponent(check.nonce ?? '')}&used_at=is.null&expires_at=gt.${input.now}`, { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ used_at: input.now, owner: id.owner }) })) as unknown[] | null;
      if (!Array.isArray(used) || used.length !== 1) return json(401, { error: 'sign-in', message: 'That sign-in was already used or has expired. Try again.' }, headers);
      const player = await playerFor(db, id.network, id.addressNorm, input.now);
      await db.call(`game_player_profiles?player_id=eq.${player.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ last_login_at: input.now }) });
      if (player.created) await logActivity(db, player.id, id.network, id.addressNorm, 'wallet_connected', input.now, { first: true });
      await logActivity(db, player.id, id.network, id.addressNorm, 'login', input.now);
      const version = await sessionVersion(db, versionKey(id.owner));
      const session = issueGameSession(secret, player.id, id.owner, input.now, version);
      return json(200, { token: session.token, expiresAt: session.expiresAt, network: id.network, address: check.address, profile: await profileOf(db, player.id), created: player.created }, headers);
    } catch {
      return json(502, { error: 'database', message: 'Signing in is not available right now.' }, headers);
    }
  }

  const claims = readGameSession(secret, input.authorization, input.now);
  if (!claims) return json(401, { error: 'session', message: 'Sign in again to continue.' }, headers);
  const network: 'evm' | 'solana' = claims.owner.startsWith('evm:') ? 'evm' : 'solana';
  const addressNorm = claims.owner.slice(claims.owner.indexOf(':') + 1);
  try {
    // A session ends when the player signs out everywhere: the token's version is older than the stored one.
    if (claims.version < (await sessionVersion(db, versionKey(claims.owner)))) return json(401, { error: 'session', message: 'Sign in again to continue.' }, headers);
    if (op === 'me') return json(200, { profile: await profileOf(db, claims.playerId), network, address: addressNorm, admin: adminOwners(input.env).has(claims.owner) }, headers);
    if (op === 'roam') {
      if (overBudget(`roam:${claims.playerId}`, input.now, 100)) return json(429, { error: 'rate-limit', message: 'Too many position reports. Slow down a little.' }, { ...headers, 'retry-after': '10' });
      const r = await roam(db, claims, network, addressNorm, body, input.now);
      return json(r.status, r.data, headers);
    }
    if (op === 'cities' || op === 'select-city' || op === 'state' || op === 'travel' || op === 'fly') await settleFlight(db, claims, network, addressNorm, input.now);
    const isAdmin = adminOwners(input.env).has(claims.owner);
    const actx = { db, admin: claims.owner, playerId: claims.playerId, network, addressNorm, body, now: input.now, secret: input.env.GAME_ANSWER_SECRET?.trim() || secret, prizesEnabled: input.env.GAME_PRIZES_ENABLED === '1' };
    if (typeof op === 'string' && op.startsWith('admin-')) {
      // To anyone who is not an administrator, an admin op looks exactly like an op that does not exist.
      if (!isAdmin || overBudget(`gameadmin:${claims.playerId}`, input.now, 120)) return json(404, { error: 'not-found' }, headers);
      const a = await adminOp(op, actx);
      return a ? json(a.status, a.data, headers) : json(404, { error: 'not-found' }, headers);
    }
    const extra = await playerAdminOp(op, actx);
    if (extra) return json(extra.status, extra.data, headers);
    // Guessing is also limited per address, so many wallets from one place cannot multiply a player's tries.
    if (op === 'answer' && overBudget(`gameanswer:${input.ip}`, input.now, 30)) return json(429, { error: 'rate-limit', message: 'Too many answers from here. Wait a minute.' }, { ...headers, 'retry-after': '60' });
    const mission = await missionOp(op, {
      db,
      playerId: claims.playerId,
      network,
      addressNorm,
      body,
      now: input.now,
      secret: input.env.GAME_ANSWER_SECRET?.trim() || secret,
      selected: async () => (await flightRow(db, claims.playerId)).selected_city,
      position: (cityId) => exploreState(db, claims.playerId, cityId, input.now),
    });
    const pctx = { db, playerId: claims.playerId, network, addressNorm, now: input.now };
    if (mission) {
      // A completed mission or a collected treasure can earn an achievement; tell the page in the same answer.
      const unlocked = mission.status === 200 && (op === 'answer' || op === 'collect') ? await evaluateAchievements(pctx) : [];
      return json(mission.status, unlocked.length > 0 ? { ...mission.data, achievements: unlocked } : mission.data, headers);
    }
    if (op === 'team-join' && overBudget(`teamjoin:${claims.playerId}`, input.now, 10)) return json(429, { error: 'rate-limit', message: 'Too many tries. Wait a minute.' }, { ...headers, 'retry-after': '60' });
    const board = await boardOp(op, { db, playerId: claims.playerId, network, addressNorm, body, now: input.now });
    if (board) return json(board.status, board.data, headers);
    if (op === 'progress') {
      const achievements = await evaluateAchievements(pctx);
      return json(200, { ...(await progress(pctx)), newlyUnlocked: achievements }, headers);
    }
    if (op === 'history') return json(200, await history(pctx, body.before), headers);
    if (op === 'set-profile') {
      const r = await setDisplayName(pctx, body.name);
      return r.ok ? json(200, { displayName: r.displayName }, headers) : json(400, { error: 'profile', message: r.message }, headers);
    }
    if (op === 'cities') return json(200, await listCities(db, claims.playerId), headers);
    if (op === 'state') return json(200, await fullState(db, claims.playerId, input.now), headers);
    if (op === 'travel' || op === 'fly') {
      const r = op === 'travel' ? await startTravel(db, claims, network, addressNorm, body, input.now) : await startFlight(db, claims, network, addressNorm, body, input.now);
      if (!r.ok) return json(r.status, { error: op, message: r.message }, headers);
      return json(200, await fullState(db, claims.playerId, input.now), headers);
    }
    if (op === 'select-city') {
      if ((await flightRow(db, claims.playerId)).flight_to) return json(409, { error: 'city', message: 'You are in the air. Wait for the flight to land.' }, headers);
      const r = await selectCity(db, claims, network, addressNorm, body.city, input.now);
      if (!r.ok) return json(r.status, { error: 'city', message: r.message }, headers);
      return json(200, { ...(await listCities(db, claims.playerId)), first: r.first, changed: r.changed, achievements: await evaluateAchievements({ db, playerId: claims.playerId, network, addressNorm, now: input.now }) }, headers);
    }
    if (op === 'logout') {
      await logActivity(db, claims.playerId, network, addressNorm, 'logout', input.now);
      return json(200, { ok: true }, headers);
    }
    if (op === 'sign-out-all') {
      const next = (await sessionVersion(db, versionKey(claims.owner))) + 1;
      await db.call('account_sessions?on_conflict=owner', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ owner: versionKey(claims.owner), version: next, updated_at: input.now }) });
      await logActivity(db, claims.playerId, network, addressNorm, 'logout', input.now, { everywhere: true });
      return json(200, { ok: true }, headers);
    }
    return json(400, { error: 'bad-request' }, headers);
  } catch {
    return json(502, { error: 'database', message: 'The game could not be reached.' }, headers);
  }
}
