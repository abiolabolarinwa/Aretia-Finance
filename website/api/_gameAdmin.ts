/**
 * Ultimate City Search, milestone 8: the administrator's console API, and the three player-facing ops that feed it (claim a prize,
 * read announcements, report abuse). Admin ops are reached only by a game session whose wallet is in ADMIN_WALLETS; to anyone else
 * they do not exist (the caller answers the same 404 as for an unknown op). Every change an administrator makes is written to an
 * append-only audit log, and the console never shows an answer, only whether a clue has one.
 *
 * Nothing here moves money. A prize claim records an entitlement and a decision; the operator pays by some authorised means
 * elsewhere and records the payment reference afterwards.
 */
import { randomUUID } from 'node:crypto';
import { cityById, parseCity } from '../src/game/cities.js';
import { dropCatalogue, publicCity } from './_gameCatalogue.js';
import { placementProblem } from '../src/game/exclusions.js';
import { canPlace, DIFFICULTIES, TREASURE_CLASSES, type PlacedTreasure } from '../src/game/rarity.js';
import { answerHash } from './_gameAnswers.js';
import type { Rest } from './_swingsAccount.js';

export interface AdminCtx {
  db: Rest;
  /** Wallet identity of the administrator, e.g. "evm:0x…", for the audit log. */
  admin: string;
  playerId: string;
  network: string;
  addressNorm: string;
  body: Record<string, unknown>;
  now: number;
  secret: string;
  prizesEnabled: boolean;
}
export type AdminOut = { status: number; data: Record<string, unknown> };

const fail = (status: number, message: string): AdminOut => ({ status, data: { error: 'admin', message } });
const ok = (data: Record<string, unknown> = { ok: true }): AdminOut => ({ status: 200, data });

const ID = /^[a-z0-9][a-z0-9-]{2,60}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS = ['daily', 'weekly', 'long', 'event', 'team'];
const MISSION_STATUS = ['draft', 'active', 'closed'];
const CLUE_TYPES = ['riddle', 'historical', 'geographical', 'architectural', 'numerical', 'cryptographic', 'visual', 'pattern', 'observation', 'trail', 'mystery'];
const CITY_STATUS = ['active', 'inactive', 'coming_soon'];
const ENVIRONMENTS = ['none', 'underwater', 'underground', 'vault'];
/** Coins worth at least this much (Samarium and up) can be claimed as a prize; smaller ones are collectibles. */
export const CASH_ELIGIBLE_USD = 1;

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

async function audit(c: AdminCtx, action: string, target: string, details: Record<string, unknown> = {}): Promise<void> {
  await c.db.call('game_admin_audit', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ admin: c.admin, action, target, details, at: c.now }) });
}

async function playerLog(c: AdminCtx, type: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await c.db.call('game_player_activities', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ player_id: c.playerId, wallet_address: c.addressNorm, network: c.network, activity_type: type, city_id: null, metadata, created_at: c.now }) });
}

// ---------------------------------------------------------------- reading

async function overview(c: AdminCtx): Promise<AdminOut> {
  const o = (await c.db.call('rpc/game_admin_overview', { method: 'POST', body: JSON.stringify({ p_now: c.now }) })) as Record<string, unknown> | null;
  const claims = (o?.claims ?? {}) as Record<string, { n: number; usd: number }>;
  const usd = (k: string): number => Number(claims[k]?.usd ?? 0);
  const hidden = Number(o?.hiddenValueUsd ?? 0);
  const pendingVerification = Number(o?.pendingVerificationUsd ?? 0);
  const reserve = Number(o?.reserveUsd ?? 0);
  // What the operator may still owe: every treasure not yet found, every find awaiting verification, and claims not yet paid.
  const obligations = hidden + pendingVerification + usd('pending') + usd('approved');
  return ok({
    ...o,
    prizesEnabled: c.prizesEnabled,
    prizes: { committedHiddenUsd: hidden, pendingVerificationUsd: pendingVerification, claimsPendingUsd: usd('pending'), claimsApprovedUnpaidUsd: usd('approved'), paidUsd: usd('paid'), remainingObligationsUsd: obligations, reserveUsd: reserve, shortfallUsd: Math.max(0, obligations - reserve) },
  });
}

async function suspicious(c: AdminCtx): Promise<AdminOut> {
  const since = c.now - 24 * 3_600_000;
  const attempts = ((await c.db.call(`game_attempts?at=gt.${since}&select=player_id,correct&limit=5000`)) as { player_id: string; correct: boolean }[] | null) ?? [];
  const by = new Map<string, { wrong: number; right: number }>();
  for (const a of attempts) {
    const e = by.get(a.player_id) ?? { wrong: 0, right: 0 };
    if (a.correct) e.right++;
    else e.wrong++;
    by.set(a.player_id, e);
  }
  const flagged = [...by].filter(([, e]) => e.wrong >= 20).map(([player, e]) => ({ player, wrong24h: e.wrong, right24h: e.right, reason: 'Many wrong answers in a day (guessing or scripting)' }));
  const rows = ((await c.db.call(`game_player_activities?activity_type=eq.hint_requested&created_at=gt.${since}&select=player_id&limit=5000`)) as { player_id: string }[] | null) ?? [];
  const hints = new Map<string, number>();
  for (const r of rows) hints.set(r.player_id, (hints.get(r.player_id) ?? 0) + 1);
  const hinty = [...hints].filter(([, n]) => n >= 60).map(([player, n]) => ({ player, hints24h: n, reason: 'Unusually many hint requests' }));
  return ok({ flagged: [...flagged, ...hinty] });
}

// ---------------------------------------------------------------- cities

async function citySet(c: AdminCtx): Promise<AdminOut> {
  const city = typeof c.body.id === 'string' ? cityById(c.body.id) : undefined;
  if (!city) return fail(400, 'That city is not in the catalogue.');
  const patch: Record<string, unknown> = {};
  if (c.body.status !== undefined) {
    if (typeof c.body.status !== 'string' || !CITY_STATUS.includes(c.body.status)) return fail(400, 'Status must be active, inactive or coming_soon.');
    patch.status = c.body.status;
  }
  if (c.body.cityName !== undefined) {
    const n = str(c.body.cityName, 60);
    if (!n) return fail(400, 'Give the city a name.');
    patch.city_name = n;
  }
  if (c.body.country !== undefined) {
    const n = str(c.body.country, 60);
    if (!n) return fail(400, 'Give the city a country.');
    patch.country = n;
  }
  if (Object.keys(patch).length === 0) return fail(400, 'Nothing to change.');
  await c.db.call(`game_cities?id=eq.${city.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify(patch) });
  dropCatalogue(c.db);
  await audit(c, 'city_set', city.id, patch);
  return ok();
}

/** Every city including hidden ones, for the console. */
async function cityList(c: AdminCtx): Promise<AdminOut> {
  const rows = ((await c.db.call('game_cities?select=*&order=sort_order.asc')) as Record<string, unknown>[] | null) ?? [];
  const cities = rows.flatMap((r) => {
    const city = parseCity(r);
    return city ? [{ ...publicCity(city), sortOrder: Number(r.sort_order ?? 100) }] : [];
  });
  return ok({ cities });
}

/**
 * Adds a city or changes one, from a description (name, country, bounds, centre, transport, colours, landmarks, scene, optional
 * licensed photograph with its credit). Every field is checked; a photograph without a credit is not kept. A new city starts hidden
 * ("coming_soon") unless the administrator says otherwise, and has no automatic placement exclusions, so the administrator's safety
 * confirmation is what protects a treasure there.
 */
async function citySave(c: AdminCtx): Promise<AdminOut> {
  const known = typeof c.body.id === 'string' ? ((await c.db.call(`game_cities?id=eq.${encodeURIComponent(c.body.id)}&select=status,sort_order&limit=1`)) as { status: string; sort_order: number }[] | null)?.[0] : undefined;
  const city = parseCity({ ...c.body, status: c.body.status ?? known?.status ?? 'coming_soon' });
  if (!city) return fail(400, 'That city is not valid: check the id (lower-case letters and dashes), the bounds (west, south, east, north, under 3 degrees across), that the centre and every landmark are inside them, and that transport includes walk and flight.');
  if (typeof c.body.imageUrl === 'string' && c.body.imageUrl && !city.imageUrl) return fail(400, 'A photograph needs an https address and a credit that says who made it and under what licence.');
  const existing = known ? [known] : [];
  const sort = c.body.sortOrder === undefined ? Number(existing[0]?.sort_order ?? 100) : num(c.body.sortOrder);
  if (sort === null || !Number.isInteger(sort) || sort < 0 || sort > 10_000) return fail(400, 'The order must be a whole number from 0 to 10000.');
  const row = { id: city.id, city_name: city.name, country: city.country, bounds: city.bounds, center_lng: city.center[0], center_lat: city.center[1], blurb: city.blurb, transport: city.transport, tint: city.tint, image_url: city.imageUrl, image_credit: city.imageCredit, landmarks: city.landmarks, scene: city.scene, status: city.status, sort_order: sort, ...(existing.length ? {} : { created_at: c.now }) };
  await c.db.call('game_cities?on_conflict=id', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
  dropCatalogue(c.db);
  await audit(c, existing.length ? 'city_save' : 'city_create', city.id, { status: city.status, scene: city.scene, photo: Boolean(city.imageUrl), landmarks: city.landmarks.length });
  return ok({ id: city.id });
}

// ---------------------------------------------------------------- missions and clues

async function missionList(c: AdminCtx): Promise<AdminOut> {
  const filter = typeof c.body.city === 'string' && cityById(c.body.city) ? `&city_id=eq.${c.body.city}` : '';
  const rows = (await c.db.call(`game_missions?select=id,city_id,title,description,difficulty,kind,status,opens_at,closes_at,xp_reward,treasure_id,environment${filter}&order=city_id.asc`)) as Record<string, unknown>[] | null;
  return ok({ missions: rows ?? [] });
}

async function missionSave(c: AdminCtx): Promise<AdminOut> {
  const b = c.body;
  const id = typeof b.id === 'string' && ID.test(b.id) ? b.id : null;
  const city = typeof b.city === 'string' ? cityById(b.city) : undefined;
  const title = str(b.title, 120);
  if (!id || !city || !title) return fail(400, 'A mission needs an id (lower-case letters, numbers, dashes), a city and a title.');
  if (typeof b.difficulty !== 'string' || !(DIFFICULTIES as readonly string[]).includes(b.difficulty)) return fail(400, 'Difficulty must be beginner, intermediate, advanced, expert or legendary.');
  const kind = typeof b.kind === 'string' ? b.kind : 'long';
  const status = typeof b.status === 'string' ? b.status : 'draft';
  if (!KINDS.includes(kind) || !MISSION_STATUS.includes(status)) return fail(400, 'Unknown kind or status.');
  const opens = b.opensAt === null || b.opensAt === undefined ? null : num(b.opensAt);
  const closes = b.closesAt === null || b.closesAt === undefined ? null : num(b.closesAt);
  if ((b.opensAt != null && opens === null) || (b.closesAt != null && closes === null)) return fail(400, 'Times must be numbers (milliseconds).');
  if (opens !== null && closes !== null && closes <= opens) return fail(400, 'A mission must close after it opens.');
  const xp = b.xpReward === undefined ? 100 : num(b.xpReward);
  if (xp === null || !Number.isInteger(xp) || xp < 0 || xp > 100_000) return fail(400, 'XP must be a whole number from 0 to 100000.');
  let treasure: string | null = null;
  if (b.treasureId !== undefined && b.treasureId !== null) {
    if (typeof b.treasureId !== 'string' || !UUID.test(b.treasureId)) return fail(400, 'That treasure id is not valid.');
    const t = (await c.db.call(`game_treasures?id=eq.${b.treasureId}&select=id,city_id,status&limit=1`)) as { city_id: string; status: string }[] | null;
    if (!t?.[0] || t[0].city_id !== city.id || t[0].status === 'withdrawn') return fail(400, 'That treasure is not in this city or is withdrawn.');
    treasure = b.treasureId;
  }
  if (status === 'active') {
    const clues = (await c.db.call(`game_clues?mission_id=eq.${id}&select=id&limit=1`)) as unknown[] | null;
    if (!clues?.length) return fail(409, 'Add at least one clue before a mission goes live.');
  }
  const environment = b.environment === undefined ? 'none' : b.environment;
  if (typeof environment !== 'string' || !ENVIRONMENTS.includes(environment)) return fail(400, 'The setting must be none, underwater, underground or vault.');
  const row = { id, environment, city_id: city.id, title, description: typeof b.description === 'string' ? b.description.slice(0, 2000) : '', difficulty: b.difficulty, kind, status, opens_at: opens, closes_at: closes, xp_reward: xp, treasure_id: treasure };
  await c.db.call('game_missions?on_conflict=id', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
  await audit(c, 'mission_save', id, { city: city.id, status, difficulty: b.difficulty, treasure });
  return ok();
}

async function clueList(c: AdminCtx): Promise<AdminOut> {
  const id = typeof c.body.mission === 'string' && ID.test(c.body.mission) ? c.body.mission : null;
  if (!id) return fail(400, 'Which mission?');
  const rows = ((await c.db.call(`game_clues?mission_id=eq.${id}&select=seq,clue_type,content,hints&order=seq.asc`)) as { seq: number; clue_type: string; content: string; hints: unknown }[] | null) ?? [];
  // The answer is never sent back, only that one is stored.
  return ok({ clues: rows.map((r) => ({ seq: r.seq, type: r.clue_type, content: r.content, hints: r.hints, hasAnswer: true })) });
}

async function clueSave(c: AdminCtx): Promise<AdminOut> {
  const b = c.body;
  const mission = typeof b.mission === 'string' && ID.test(b.mission) ? b.mission : null;
  const seq = typeof b.seq === 'number' && Number.isInteger(b.seq) && b.seq >= 1 && b.seq <= 50 ? b.seq : null;
  const content = str(b.content, 2000);
  if (!mission || !seq || !content) return fail(400, 'A clue needs a mission, a step number and text.');
  if (typeof b.type !== 'string' || !CLUE_TYPES.includes(b.type)) return fail(400, 'Unknown clue type.');
  const hints = Array.isArray(b.hints) ? b.hints.filter((h): h is string => typeof h === 'string' && h.trim().length > 0 && h.length <= 300).slice(0, 5) : [];
  const answer = typeof b.answer === 'string' && b.answer.trim().length > 0 && b.answer.length <= 200 ? b.answer : null;
  const exists = (await c.db.call(`game_missions?id=eq.${mission}&select=id&limit=1`)) as unknown[] | null;
  if (!exists?.length) return fail(404, 'That mission does not exist.');
  const all = ((await c.db.call(`game_clues?mission_id=eq.${mission}&select=id,seq&order=seq.asc`)) as { id: string; seq: number }[] | null) ?? [];
  const current = all.find((r) => r.seq === seq);
  if (!current && seq !== all.length + 1) return fail(400, `The next step is ${all.length + 1}; steps cannot skip.`);
  if (!current && !answer) return fail(400, 'A new clue needs an answer.');
  if (current) {
    // The id stays the same on an edit, so a stored answer keeps working unless a new one is given.
    const patch: Record<string, unknown> = { clue_type: b.type, content, hints };
    if (answer) patch.answer_hash = answerHash(c.secret, current.id, answer);
    await c.db.call(`game_clues?id=eq.${current.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify(patch) });
  } else {
    const id = randomUUID();
    await c.db.call('game_clues', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ id, mission_id: mission, seq, clue_type: b.type, content, answer_hash: answerHash(c.secret, id, answer!), hints }) });
  }
  await audit(c, 'clue_save', `${mission}#${seq}`, { type: b.type, answerChanged: Boolean(answer), hints: hints.length });
  return ok();
}

async function clueDelete(c: AdminCtx): Promise<AdminOut> {
  const mission = typeof c.body.mission === 'string' && ID.test(c.body.mission) ? c.body.mission : null;
  if (!mission) return fail(400, 'Which mission?');
  const all = ((await c.db.call(`game_clues?mission_id=eq.${mission}&select=id,seq&order=seq.asc`)) as { id: string; seq: number }[] | null) ?? [];
  const last = all[all.length - 1];
  if (!last) return fail(404, 'That mission has no clues.');
  const live = (await c.db.call(`game_missions?id=eq.${mission}&select=status&limit=1`)) as { status: string }[] | null;
  if (live?.[0]?.status === 'active' && all.length === 1) return fail(409, 'Close the mission before removing its only clue.');
  // Only the last step can go, so steps stay in order.
  await c.db.call(`game_clues?id=eq.${last.id}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
  await audit(c, 'clue_delete', `${mission}#${last.seq}`);
  return ok();
}

// ---------------------------------------------------------------- treasures

async function treasureList(c: AdminCtx): Promise<AdminOut> {
  const filter = typeof c.body.city === 'string' && cityById(c.body.city) ? `&city_id=eq.${c.body.city}` : '';
  const ts = ((await c.db.call(`game_treasures?select=id,city_id,class_id,season,status,found_by,found_at${filter}`)) as Record<string, unknown>[] | null) ?? [];
  const locs = ts.length ? (((await c.db.call(`game_treasure_locations?treasure_id=in.(${ts.map((t) => t.id).join(',')})&select=treasure_id,lng,lat,radius_m`)) as { treasure_id: string; lng: number; lat: number; radius_m: number }[] | null) ?? []) : [];
  const at = new Map(locs.map((l) => [l.treasure_id, l]));
  return ok({ treasures: ts.map((t) => ({ ...t, zone: at.get(String(t.id)) ? { lng: at.get(String(t.id))!.lng, lat: at.get(String(t.id))!.lat, radiusM: at.get(String(t.id))!.radius_m } : null })) });
}

async function treasurePlace(c: AdminCtx): Promise<AdminOut> {
  const b = c.body;
  const city = typeof b.city === 'string' ? cityById(b.city) : undefined;
  const cls = typeof b.class === 'string' ? TREASURE_CLASSES.find((k) => k.id === b.class) : undefined;
  const lng = num(b.lng);
  const lat = num(b.lat);
  const radiusM = b.radiusM === undefined ? 60 : num(b.radiusM);
  if (!city || !cls || lng === null || lat === null || radiusM === null) return fail(400, 'A treasure needs a city, a class and a position.');
  if (b.confirmSafe !== true) return fail(400, 'Confirm that the place is public, lawful, safe and needs nobody to enter private or restricted ground.');
  const problem = placementProblem({ city: city.id, lng, lat, radiusM });
  if (problem) return fail(400, problem);
  const existing = ((await c.db.call('game_treasures?select=city_id,class_id,status')) as { city_id: string; class_id: string; status: string }[] | null) ?? [];
  const placed: PlacedTreasure[] = existing.map((t) => ({ cityId: t.city_id, classId: t.class_id, status: t.status }));
  const caps = b.supplyCap !== undefined && num(b.supplyCap) !== null ? { [cls.id]: Number(b.supplyCap) } : {};
  const can = canPlace(placed, city.id, cls.id, caps);
  if (!can.ok) return fail(409, can.reason);
  const season = str(b.season, 40) ?? 'launch';
  let id: string | undefined;
  try {
    const made = (await c.db.call('game_treasures', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ city_id: city.id, class_id: cls.id, season, created_at: c.now }) })) as { id: string }[] | null;
    id = made?.[0]?.id;
  } catch {
    return fail(409, 'That treasure could not be placed (a city has one Diamond Treasure).');
  }
  if (!id) return fail(500, 'The treasure could not be placed.');
  try {
    await c.db.call('game_treasure_locations', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ treasure_id: id, lng, lat, radius_m: radiusM }) });
  } catch {
    await c.db.call(`game_treasures?id=eq.${id}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } }).catch(() => undefined);
    return fail(500, 'The treasure location could not be saved.');
  }
  await audit(c, 'treasure_place', id, { city: city.id, class: cls.id, season, radiusM, confirmedSafe: true });
  return ok({ id });
}

async function treasureWithdraw(c: AdminCtx): Promise<AdminOut> {
  const id = typeof c.body.id === 'string' && UUID.test(c.body.id) ? c.body.id : null;
  if (!id) return fail(400, 'Which treasure?');
  const done = (await c.db.call(`game_treasures?id=eq.${id}&status=eq.hidden`, { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ status: 'withdrawn' }) })) as unknown[] | null;
  if (!done?.length) return fail(409, 'Only a treasure that is still hidden can be withdrawn.');
  await audit(c, 'treasure_withdraw', id);
  return ok();
}

// ---------------------------------------------------------------- verification and claims

async function verifyQueue(c: AdminCtx): Promise<AdminOut> {
  const rows = ((await c.db.call('game_player_treasures?verification_status=eq.pending&select=player_id,treasure_id,discovered_at&order=discovered_at.asc&limit=100')) as { player_id: string; treasure_id: string; discovered_at: number }[] | null) ?? [];
  const ts = rows.length ? (((await c.db.call(`game_treasures?id=in.(${rows.map((r) => r.treasure_id).join(',')})&select=id,city_id,class_id`)) as { id: string; city_id: string; class_id: string }[] | null) ?? []) : [];
  const by = new Map(ts.map((t) => [t.id, t]));
  return ok({ queue: rows.map((r) => ({ playerId: r.player_id, treasureId: r.treasure_id, discoveredAt: Number(r.discovered_at), cityId: by.get(r.treasure_id)?.city_id ?? null, class: by.get(r.treasure_id)?.class_id ?? null })) });
}

async function verify(c: AdminCtx): Promise<AdminOut> {
  const b = c.body;
  const player = typeof b.playerId === 'string' && UUID.test(b.playerId) ? b.playerId : null;
  const treasure = typeof b.treasureId === 'string' && UUID.test(b.treasureId) ? b.treasureId : null;
  if (!player || !treasure || (b.decision !== 'verified' && b.decision !== 'rejected')) return fail(400, 'Give the player, the treasure and a decision (verified or rejected).');
  const done = (await c.db.call(`game_player_treasures?player_id=eq.${player}&treasure_id=eq.${treasure}&verification_status=eq.pending`, { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ verification_status: b.decision }) })) as unknown[] | null;
  if (!done?.length) return fail(409, 'That find is not waiting for verification.');
  // A rejected find can put the treasure back in play, if the finder cheated.
  if (b.decision === 'rejected' && b.reopen === true) await c.db.call(`game_treasures?id=eq.${treasure}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ status: 'hidden', found_by: null, found_at: null }) });
  await audit(c, 'verify', `${player}:${treasure}`, { decision: b.decision, reopened: b.reopen === true, notes: str(b.notes, 500) ?? '' });
  return ok();
}

async function claimsList(c: AdminCtx): Promise<AdminOut> {
  const status = typeof c.body.status === 'string' && ['pending', 'approved', 'rejected', 'paid'].includes(c.body.status) ? `&claim_status=eq.${c.body.status}` : '';
  const rows = (await c.db.call(`game_prize_claims?select=id,player_id,treasure_id,amount_usd,claim_status,verification_details,payment_reference,created_at,decided_at,paid_at${status}&order=created_at.asc&limit=200`)) as Record<string, unknown>[] | null;
  return ok({ claims: rows ?? [] });
}

async function claimDecide(c: AdminCtx): Promise<AdminOut> {
  const id = typeof c.body.id === 'string' && UUID.test(c.body.id) ? c.body.id : null;
  if (!id || (c.body.decision !== 'approved' && c.body.decision !== 'rejected')) return fail(400, 'Give the claim and a decision (approved or rejected).');
  const details = str(c.body.notes, 2000) ?? '';
  const done = (await c.db.call(`game_prize_claims?id=eq.${id}&claim_status=eq.pending`, { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ claim_status: c.body.decision, verification_details: details, decided_at: c.now }) })) as unknown[] | null;
  if (!done?.length) return fail(409, 'That claim is not waiting for a decision.');
  await audit(c, 'claim_decide', id, { decision: c.body.decision });
  return ok();
}

async function claimPaid(c: AdminCtx): Promise<AdminOut> {
  const id = typeof c.body.id === 'string' && UUID.test(c.body.id) ? c.body.id : null;
  const ref = str(c.body.paymentReference, 200);
  if (!id || !ref) return fail(400, 'Give the claim and the payment reference from your payment records.');
  const done = (await c.db.call(`game_prize_claims?id=eq.${id}&claim_status=eq.approved`, { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ claim_status: 'paid', payment_reference: ref, paid_at: c.now }) })) as unknown[] | null;
  if (!done?.length) return fail(409, 'Only an approved claim can be marked paid.');
  await audit(c, 'claim_paid', id, { paymentReference: ref });
  return ok();
}

async function reserveAdd(c: AdminCtx): Promise<AdminOut> {
  const amount = num(c.body.amountUsd);
  if (amount === null || amount === 0 || Math.abs(amount) > 10_000_000) return fail(400, 'Give a non-zero amount in US dollars (negative to take out).');
  await c.db.call('game_reserve_entries', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ amount_usd: amount, note: str(c.body.note, 300) ?? '', admin: c.admin, at: c.now }) });
  await audit(c, 'reserve_entry', 'reserve', { amountUsd: amount });
  return ok();
}

// ---------------------------------------------------------------- reports, announcements, audit

async function reportsList(c: AdminCtx): Promise<AdminOut> {
  const rows = (await c.db.call('game_abuse_reports?status=eq.open&select=id,reporter,kind,details,created_at&order=created_at.asc&limit=100')) as Record<string, unknown>[] | null;
  return ok({ reports: rows ?? [] });
}

async function reportResolve(c: AdminCtx): Promise<AdminOut> {
  const id = typeof c.body.id === 'string' && UUID.test(c.body.id) ? c.body.id : null;
  if (!id || (c.body.status !== 'resolved' && c.body.status !== 'dismissed')) return fail(400, 'Give the report and resolved or dismissed.');
  const done = (await c.db.call(`game_abuse_reports?id=eq.${id}&status=eq.open`, { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ status: c.body.status, resolved_at: c.now }) })) as unknown[] | null;
  if (!done?.length) return fail(409, 'That report is already closed.');
  await audit(c, 'report_resolve', id, { status: c.body.status });
  return ok();
}

async function announce(c: AdminCtx): Promise<AdminOut> {
  const title = str(c.body.title, 120);
  if (!title) return fail(400, 'Give the announcement a title.');
  const expires = c.body.expiresAt === undefined || c.body.expiresAt === null ? null : num(c.body.expiresAt);
  if (c.body.expiresAt != null && (expires === null || expires <= c.now)) return fail(400, 'The end time must be in the future.');
  const made = (await c.db.call('game_announcements', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ title, body: typeof c.body.body === 'string' ? c.body.body.slice(0, 2000) : '', created_at: c.now, expires_at: expires }) })) as { id: string }[] | null;
  await audit(c, 'announce', made?.[0]?.id ?? '', { title });
  return ok({ id: made?.[0]?.id });
}

async function announcementEnd(c: AdminCtx): Promise<AdminOut> {
  const id = typeof c.body.id === 'string' && UUID.test(c.body.id) ? c.body.id : null;
  if (!id) return fail(400, 'Which announcement?');
  await c.db.call(`game_announcements?id=eq.${id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ active: false }) });
  await audit(c, 'announcement_end', id);
  return ok();
}

async function auditList(c: AdminCtx): Promise<AdminOut> {
  const rows = (await c.db.call('game_admin_audit?select=id,admin,action,target,details,at&order=at.desc&limit=100')) as Record<string, unknown>[] | null;
  return ok({ entries: rows ?? [] });
}

/** Handles an admin op. The caller has already checked the session belongs to an administrator. Returns null for any other op. */
export async function adminOp(op: unknown, c: AdminCtx): Promise<AdminOut | null> {
  switch (op) {
    case 'admin-overview': return overview(c);
    case 'admin-suspicious': return suspicious(c);
    case 'admin-city-set': return citySet(c);
    case 'admin-city-list': return cityList(c);
    case 'admin-city-save': return citySave(c);
    case 'admin-mission-list': return missionList(c);
    case 'admin-mission-save': return missionSave(c);
    case 'admin-clue-list': return clueList(c);
    case 'admin-clue-save': return clueSave(c);
    case 'admin-clue-delete': return clueDelete(c);
    case 'admin-treasure-list': return treasureList(c);
    case 'admin-treasure-place': return treasurePlace(c);
    case 'admin-treasure-withdraw': return treasureWithdraw(c);
    case 'admin-verify-queue': return verifyQueue(c);
    case 'admin-verify': return verify(c);
    case 'admin-claims': return claimsList(c);
    case 'admin-claim-decide': return claimDecide(c);
    case 'admin-claim-paid': return claimPaid(c);
    case 'admin-reserve': return reserveAdd(c);
    case 'admin-reports': return reportsList(c);
    case 'admin-report-resolve': return reportResolve(c);
    case 'admin-announce': return announce(c);
    case 'admin-announcement-end': return announcementEnd(c);
    case 'admin-audit': return auditList(c);
    default: return null;
  }
}

// ---------------------------------------------------------------- player ops

/** A player claims the prize for a treasure they have collected and that has been verified. Records the claim; pays nothing. */
async function claimPrize(c: AdminCtx): Promise<AdminOut> {
  if (!c.prizesEnabled) return fail(409, 'Cash prizes are not open yet. Your verified finds are recorded and will be honoured under the competition terms when prizes open.');
  const id = typeof c.body.treasure === 'string' && UUID.test(c.body.treasure) ? c.body.treasure : null;
  if (!id) return fail(400, 'Which treasure?');
  const pt = (await c.db.call(`game_player_treasures?player_id=eq.${c.playerId}&treasure_id=eq.${id}&select=discovery_status,verification_status&limit=1`)) as { discovery_status: string; verification_status: string }[] | null;
  if (!pt?.[0] || pt[0].discovery_status !== 'discovered') return fail(404, 'You have not collected that treasure.');
  if (pt[0].verification_status !== 'verified') return fail(409, 'This find has not been verified yet.');
  const t = (await c.db.call(`game_treasures?id=eq.${id}&select=class_id&limit=1`)) as { class_id: string }[] | null;
  const cls = TREASURE_CLASSES.find((k) => k.id === t?.[0]?.class_id);
  if (!cls || cls.usd < CASH_ELIGIBLE_USD) return fail(409, 'This coin is a collectible and is not redeemable for cash.');
  try {
    await c.db.call('game_prize_claims', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ player_id: c.playerId, treasure_id: id, amount_usd: cls.usd, created_at: c.now }) });
  } catch {
    return fail(409, 'A claim for this treasure already exists.');
  }
  await c.db.call(`game_player_treasures?player_id=eq.${c.playerId}&treasure_id=eq.${id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ claim_status: 'pending' }) });
  await playerLog(c, 'prize_claimed', { treasure: id, usd: cls.usd });
  return ok({ claim: 'pending' });
}

async function announcements(c: AdminCtx): Promise<AdminOut> {
  const rows = ((await c.db.call(`game_announcements?active=eq.true&select=id,title,body,created_at,expires_at&order=created_at.desc&limit=10`)) as { id: string; title: string; body: string; created_at: number; expires_at: number | null }[] | null) ?? [];
  return ok({ announcements: rows.filter((r) => r.expires_at === null || Number(r.expires_at) > c.now).map((r) => ({ id: r.id, title: r.title, body: r.body, at: Number(r.created_at) })) });
}

async function reportAbuse(c: AdminCtx): Promise<AdminOut> {
  const kind = typeof c.body.kind === 'string' && ['cheating', 'exploit', 'wrong-clue', 'harassment', 'other'].includes(c.body.kind) ? c.body.kind : null;
  if (!kind) return fail(400, 'Choose what you are reporting.');
  const recent = (await c.db.call(`game_abuse_reports?reporter=eq.${c.playerId}&created_at=gt.${c.now - 3_600_000}&select=id&limit=6`)) as unknown[] | null;
  if ((recent?.length ?? 0) >= 5) return { status: 429, data: { error: 'admin', message: 'You have sent several reports this hour. Please wait.' } };
  await c.db.call('game_abuse_reports', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ reporter: c.playerId, kind, details: typeof c.body.details === 'string' ? c.body.details.slice(0, 2000) : '', created_at: c.now }) });
  await playerLog(c, 'abuse_reported', { kind });
  return ok();
}

/** Ops any signed-in player may use. Returns null for any other op. */
export async function playerAdminOp(op: unknown, c: AdminCtx): Promise<AdminOut | null> {
  switch (op) {
    case 'claim-prize': return claimPrize(c);
    case 'announcements': return announcements(c);
    case 'report-abuse': return reportAbuse(c);
    default: return null;
  }
}
