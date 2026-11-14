/**
 * Ultimate City Search, milestone 5: missions, clues, hints, answers and treasure discovery. Everything that decides an outcome is
 * decided here: the page only sends intents (start, hint, answer, collect). Answers are stored as keyed hashes and never sent; a
 * treasure's location is sent only to the player who has solved its trail; the first player to reach a treasure takes it, in one
 * conditional update, so two players can never both win the same coin.
 */
import { timingSafeEqual } from 'node:crypto';
import { cityById } from '../src/game/cities.js';
import { distanceKm, type LngLat } from '../src/game/travel.js';
import { missionXp, treasureXp, TREASURE_CLASSES } from '../src/game/rarity.js';
import { answerHash } from './_gameAnswers.js';
import { ensureChallenges } from './_gameChallenges.js';
import type { Rest } from './_swingsAccount.js';

export interface MissionCtx {
  db: Rest;
  playerId: string;
  network: string;
  addressNorm: string;
  body: Record<string, unknown>;
  now: number;
  /** Key the answer hashes are made with (GAME_ANSWER_SECRET, else the session key). */
  secret: string;
  selected(): Promise<string | null>;
  position(cityId: string): Promise<{ position: LngLat; travel: unknown }>;
}
export type MissionOut = { status: number; data: Record<string, unknown> };

export { answerHash };

/** A team hunt gives each member a fifth more XP, because it takes more than one person. */
export const TEAM_BONUS = 0.2;

const WRONG_LIMIT = 5;
const WRONG_WINDOW_MS = 10 * 60_000;

const fail = (status: number, message: string): MissionOut => ({ status, data: { error: 'mission', message } });
const ok = (data: Record<string, unknown>): MissionOut => ({ status: 200, data });
const classOf = (id: string): (typeof TREASURE_CLASSES)[number] | undefined => TREASURE_CLASSES.find((c) => c.id === id);

interface MissionRow { id: string; city_id: string; title: string; description: string; difficulty: string; kind: string; status: string; opens_at: number | null; closes_at: number | null; xp_reward: number; treasure_id: string | null; environment: string }
interface ClueRow { id: string; seq: number; clue_type: string; content: string; answer_hash: string; hints: unknown }
interface PlayerMissionRow { id: string; mission_id: string; status: string; stage: number; hints_used: number; hints_total: number }
interface TreasureRow { id: string; city_id: string; class_id: string; status: string; found_by: string | null }
interface PlayerTreasureRow { treasure_id: string; discovery_status: string; verification_status: string; claim_status: string; unlocked_at: number; discovered_at: number | null }

const MISSION_COLS = 'id,city_id,title,description,difficulty,kind,status,opens_at,closes_at,xp_reward,treasure_id,environment';
const isOpen = (m: MissionRow, now: number): boolean => m.status === 'active' && (m.opens_at === null || Number(m.opens_at) <= now) && (m.closes_at === null || Number(m.closes_at) > now);
const hintList = (c: ClueRow): string[] => (Array.isArray(c.hints) ? c.hints.filter((h): h is string => typeof h === 'string') : []);

async function log(c: MissionCtx, type: string, cityId: string | null, metadata: Record<string, unknown> = {}): Promise<void> {
  await c.db.call('game_player_activities', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ player_id: c.playerId, wallet_address: c.addressNorm, network: c.network, activity_type: type, city_id: cityId, metadata, created_at: c.now }) });
}

async function getMission(c: MissionCtx, id: unknown): Promise<MissionRow | null> {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,60}$/.test(id)) return null;
  const rows = (await c.db.call(`game_missions?id=eq.${id}&select=${MISSION_COLS}&limit=1`)) as MissionRow[] | null;
  return rows?.[0] ?? null;
}

/** Where a mission's progress is kept: the player's own row, or, for a team hunt, the team's. */
interface Scope {
  table: 'game_player_missions' | 'game_team_missions';
  where: string;
  team: { id: string; role: string } | null;
}

async function teamOf(c: MissionCtx): Promise<{ id: string; role: string } | null> {
  const rows = (await c.db.call(`game_team_members?player_id=eq.${c.playerId}&select=team_id,role&limit=1`)) as { team_id: string; role: string }[] | null;
  return rows?.[0] ? { id: rows[0].team_id, role: rows[0].role } : null;
}

async function scopeFor(c: MissionCtx, m: MissionRow): Promise<Scope | MissionOut> {
  if (m.kind !== 'team') return { table: 'game_player_missions', where: `player_id=eq.${c.playerId}&mission_id=eq.${m.id}`, team: null };
  const team = await teamOf(c);
  if (!team) return fail(409, 'A team hunt needs a team. Make or join one first.');
  return { table: 'game_team_missions', where: `team_id=eq.${team.id}&mission_id=eq.${m.id}`, team };
}

async function getPlayerMission(c: MissionCtx, scope: Scope): Promise<PlayerMissionRow | null> {
  const rows = (await c.db.call(`${scope.table}?${scope.where}&select=id,mission_id,status,stage,hints_used,hints_total&limit=1`)) as PlayerMissionRow[] | null;
  return rows?.[0] ?? null;
}

async function clues(c: MissionCtx, missionId: string): Promise<ClueRow[]> {
  return ((await c.db.call(`game_clues?mission_id=eq.${missionId}&select=id,seq,clue_type,content,answer_hash,hints&order=seq.asc`)) as ClueRow[] | null) ?? [];
}

/** The clue a player is on: its text, its type and the hints they have already asked for. Never the answer or its hash. */
async function clueView(c: MissionCtx, m: MissionRow, pm: PlayerMissionRow): Promise<Record<string, unknown>> {
  const all = await clues(c, m.id);
  const clue = all.find((x) => x.seq === pm.stage);
  const hints = clue ? hintList(clue) : [];
  return { mission: { id: m.id, title: m.title, difficulty: m.difficulty, cityId: m.city_id, environment: m.environment ?? 'none' }, status: pm.status, stage: pm.stage, totalStages: all.length, clue: clue ? { type: clue.clue_type, content: clue.content } : null, hintsUsed: pm.hints_used, hintsAvailable: hints.length, hints: hints.slice(0, pm.hints_used) };
}

async function zoneFor(c: MissionCtx, treasureId: string): Promise<Record<string, unknown> | null> {
  const rows = (await c.db.call(`game_treasure_locations?treasure_id=eq.${treasureId}&select=lng,lat,radius_m&limit=1`)) as { lng: number; lat: number; radius_m: number }[] | null;
  return rows?.[0] ? { lng: rows[0].lng, lat: rows[0].lat, radiusM: rows[0].radius_m } : null;
}

async function treasureRow(c: MissionCtx, id: string): Promise<TreasureRow | null> {
  const rows = (await c.db.call(`game_treasures?id=eq.${id}&select=id,city_id,class_id,status,found_by&limit=1`)) as TreasureRow[] | null;
  return rows?.[0] ?? null;
}

const treasureCard = (t: TreasureRow): Record<string, unknown> => {
  const k = classOf(t.class_id);
  return { id: t.id, cityId: t.city_id, class: t.class_id, coin: k?.coin ?? t.class_id, usd: k?.usd ?? 0 };
};

async function listMissions(c: MissionCtx): Promise<MissionOut> {
  const city = typeof c.body.city === 'string' ? cityById(c.body.city) : undefined;
  if (!city) return fail(400, 'That city does not exist.');
  // Today's and this week's challenges are made the first time anyone asks for them.
  try {
    await ensureChallenges(c.db, city, c.now, c.secret);
  } catch {
    // the rest of the list is still worth showing
  }
  const rows = ((await c.db.call(`game_missions?city_id=eq.${city.id}&status=eq.active&select=${MISSION_COLS}`)) as MissionRow[] | null) ?? [];
  const open = rows.filter((m) => isOpen(m, c.now));
  if (open.length === 0) return ok({ missions: [] });
  const ids = open.map((m) => m.id).join(',');
  const team = open.some((m) => m.kind === 'team') ? await teamOf(c) : null;
  const [mine, theirs, stages, treasures] = await Promise.all([
    c.db.call(`game_player_missions?player_id=eq.${c.playerId}&mission_id=in.(${ids})&select=mission_id,status,stage`) as Promise<PlayerMissionRow[] | null>,
    team ? (c.db.call(`game_team_missions?team_id=eq.${team.id}&mission_id=in.(${ids})&select=mission_id,status,stage`) as Promise<PlayerMissionRow[] | null>) : Promise.resolve([] as PlayerMissionRow[]),
    c.db.call(`game_clues?mission_id=in.(${ids})&select=mission_id`) as Promise<{ mission_id: string }[] | null>,
    open.some((m) => m.treasure_id) ? (c.db.call(`game_treasures?id=in.(${open.filter((m) => m.treasure_id).map((m) => m.treasure_id).join(',')})&select=id,city_id,class_id,status,found_by`) as Promise<TreasureRow[] | null>) : Promise.resolve([] as TreasureRow[]),
  ]);
  const byMission = new Map((mine ?? []).map((p) => [p.mission_id, p]));
  const byTeam = new Map((theirs ?? []).map((p) => [p.mission_id, p]));
  const treasureById = new Map((treasures ?? []).map((t) => [t.id, t]));
  return ok({
    missions: open.map((m) => {
      const t = m.treasure_id ? treasureById.get(m.treasure_id) : undefined;
      const p = m.kind === 'team' ? (byTeam.get(m.id) ?? byMission.get(m.id)) : byMission.get(m.id);
      return {
        id: m.id,
        title: m.title,
        description: m.description,
        difficulty: m.difficulty,
        kind: m.kind,
        environment: m.environment ?? 'none',
        needsTeam: m.kind === 'team' && !team,
        closesAt: m.closes_at === null ? null : Number(m.closes_at),
        xpReward: m.xp_reward,
        // The prize on offer, only while it can still be won. Where it is, is never listed.
        treasure: t && t.status === 'hidden' ? { coin: classOf(t.class_id)?.coin, usd: classOf(t.class_id)?.usd } : null,
        totalStages: (stages ?? []).filter((s) => s.mission_id === m.id).length,
        progress: p ? { status: p.status, stage: p.stage } : null,
      };
    }),
  });
}

async function startMission(c: MissionCtx): Promise<MissionOut> {
  const m = await getMission(c, c.body.mission);
  if (!m || !isOpen(m, c.now)) return fail(404, 'That mission is not open.');
  if ((await clues(c, m.id)).length === 0) return fail(404, 'That mission is not open.');
  const scope = await scopeFor(c, m);
  if (isOut(scope)) return scope;
  if (scope.team) {
    const size = (await c.db.call(`game_team_members?team_id=eq.${scope.team.id}&select=player_id&limit=3`)) as unknown[] | null;
    if ((size?.length ?? 0) < 2) return fail(409, 'A team hunt needs at least two members.');
  }
  const existing = await getPlayerMission(c, scope);
  if (existing?.status === 'completed') return fail(409, scope.team ? 'Your team has already completed this hunt.' : 'You have already completed this mission.');
  // A player who finished a team hunt with a team they have since left cannot start it again alone.
  if (scope.team && (await c.db.call(`game_player_missions?player_id=eq.${c.playerId}&mission_id=eq.${m.id}&status=eq.completed&select=id&limit=1`) as unknown[] | null)?.length) return fail(409, 'You have already completed this hunt.');
  const insert = scope.team ? { team_id: scope.team.id, mission_id: m.id, started_by: c.playerId, started_at: c.now } : { player_id: c.playerId, mission_id: m.id, started_at: c.now };
  const conflict = scope.team ? 'team_id,mission_id' : 'player_id,mission_id';
  if (!existing) {
    await c.db.call(`${scope.table}?on_conflict=${conflict}`, { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(insert) });
    await log(c, scope.team ? 'team_hunt_started' : 'mission_started', m.city_id, { mission: m.id });
  } else if (existing.status === 'abandoned') {
    await c.db.call(`${scope.table}?${scope.where}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ status: 'active', stage: 1, hints_used: 0, hints_total: 0, started_at: c.now }) });
    await log(c, scope.team ? 'team_hunt_started' : 'mission_started', m.city_id, { mission: m.id, restarted: true });
  }
  const pm = await getPlayerMission(c, scope);
  return pm ? ok(await clueView(c, m, pm)) : fail(500, 'The mission could not be started.');
}

async function activeMission(c: MissionCtx): Promise<{ m: MissionRow; pm: PlayerMissionRow; scope: Scope } | MissionOut> {
  const m = await getMission(c, c.body.mission);
  if (!m) return fail(404, 'That mission does not exist.');
  const scope = await scopeFor(c, m);
  if (isOut(scope)) return scope;
  const pm = await getPlayerMission(c, scope);
  if (!pm || pm.status !== 'active') return fail(409, 'Start the mission first.');
  if (!isOpen(m, c.now)) return fail(409, 'This mission has closed.');
  return { m, pm, scope };
}
const isOut = (v: unknown): v is MissionOut => typeof (v as MissionOut).status === 'number';

async function showClue(c: MissionCtx): Promise<MissionOut> {
  const a = await activeMission(c);
  return isOut(a) ? a : ok(await clueView(c, a.m, a.pm));
}

async function takeHint(c: MissionCtx): Promise<MissionOut> {
  const a = await activeMission(c);
  if (isOut(a)) return a;
  const clue = (await clues(c, a.m.id)).find((x) => x.seq === a.pm.stage);
  if (!clue || a.pm.hints_used >= hintList(clue).length) return fail(409, 'There are no more hints for this clue.');
  const rows = (await c.db.call(`${a.scope.table}?${a.scope.where}&status=eq.active&hints_used=eq.${a.pm.hints_used}`, { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ hints_used: a.pm.hints_used + 1, hints_total: a.pm.hints_total + 1 }) })) as PlayerMissionRow[] | null;
  if (!rows || rows.length !== 1) return fail(409, 'Try again.');
  await log(c, 'hint_requested', a.m.city_id, { mission: a.m.id, stage: a.pm.stage, n: a.pm.hints_used + 1 });
  return ok(await clueView(c, a.m, rows[0]!));
}

/** Pays a finished mission to the player, or to every current member of the team, and unlocks its treasure for them. */
async function finish(c: MissionCtx, a: { m: MissionRow; pm: PlayerMissionRow; scope: Scope }, xp: number): Promise<MissionOut> {
  const members = a.scope.team ? (((await c.db.call(`game_team_members?team_id=eq.${a.scope.team.id}&select=player_id`)) as { player_id: string }[] | null) ?? []).map((r) => r.player_id) : [c.playerId];
  const each = a.scope.team ? Math.round(xp * (1 + TEAM_BONUS)) : xp;
  const t = a.m.treasure_id ? await treasureRow(c, a.m.treasure_id) : null;
  for (const member of members) {
    if (a.scope.team) {
      // Every member gets the mission as completed on their own record, which is what their totals and achievements count.
      await c.db.call('game_player_missions?on_conflict=player_id,mission_id', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ player_id: member, mission_id: a.m.id, status: 'completed', score: each, hints_total: a.pm.hints_total, started_at: c.now, completed_at: c.now }) });
    }
    await c.db.call('rpc/game_award_xp', { method: 'POST', body: JSON.stringify({ p_player: member, p_city: a.m.city_id, p_xp: each, p_discoveries: 0, p_missions: 1 }) });
    if (t && t.status === 'hidden') await c.db.call('game_player_treasures?on_conflict=player_id,treasure_id', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ player_id: member, treasure_id: t.id, unlocked_at: c.now }) });
  }
  if (a.scope.team) {
    // Each member's record shows the hunt, under their own wallet, which is what their achievements count.
    const wallets = ((await c.db.call(`game_player_wallets?player_id=in.(${members.join(',')})&select=player_id,network,address_norm`)) as { player_id: string; network: string; address_norm: string }[] | null) ?? [];
    for (const w of wallets) {
      await c.db.call('game_player_activities', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ player_id: w.player_id, wallet_address: w.address_norm, network: w.network, activity_type: 'team_hunt_completed', city_id: a.m.city_id, metadata: { mission: a.m.id, xp: each, members: members.length }, created_at: c.now }) });
    }
  } else {
    await log(c, 'mission_completed', a.m.city_id, { mission: a.m.id, xp: each, hints: a.pm.hints_total });
  }
  let treasure: Record<string, unknown> | null = null;
  if (t && t.status === 'hidden') {
    await log(c, 'treasure_unlocked', t.city_id, { treasure: t.id, class: t.class_id });
    treasure = { ...treasureCard(t), zone: await zoneFor(c, t.id) };
  }
  return ok({ correct: true, completed: true, xp: each, team: Boolean(a.scope.team), treasure });
}

async function answerClue(c: MissionCtx): Promise<MissionOut> {
  const a = await activeMission(c);
  if (isOut(a)) return a;
  const given = typeof c.body.answer === 'string' ? c.body.answer : '';
  if (!given.trim() || given.length > 200) return fail(400, 'Type an answer.');
  const wrong = (await c.db.call(`game_attempts?player_id=eq.${c.playerId}&mission_id=eq.${a.m.id}&correct=eq.false&at=gt.${c.now - WRONG_WINDOW_MS}&select=id`)) as unknown[] | null;
  if ((wrong?.length ?? 0) >= WRONG_LIMIT) return { status: 429, data: { error: 'mission', message: 'Too many wrong answers. Think it over and try again in a few minutes.' } };
  const all = await clues(c, a.m.id);
  const clue = all.find((x) => x.seq === a.pm.stage);
  if (!clue) return fail(409, 'This mission has no clue here.');
  const want = Buffer.from(clue.answer_hash, 'hex');
  const got = Buffer.from(answerHash(c.secret, clue.id, given), 'hex');
  const correct = want.length === got.length && timingSafeEqual(want, got);
  await c.db.call('game_attempts', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ player_id: c.playerId, mission_id: a.m.id, seq: clue.seq, correct, at: c.now }) });
  await log(c, correct ? 'answer_correct' : 'answer_incorrect', a.m.city_id, { mission: a.m.id, stage: clue.seq });
  if (!correct) return ok({ correct: false, attemptsLeft: Math.max(0, WRONG_LIMIT - 1 - (wrong?.length ?? 0)) });

  if (clue.seq < all.length) {
    const next = (await c.db.call(`${a.scope.table}?${a.scope.where}&status=eq.active&stage=eq.${a.pm.stage}`, { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ stage: a.pm.stage + 1, hints_used: 0 }) })) as PlayerMissionRow[] | null;
    return ok({ correct: true, completed: false, ...(next?.[0] ? { next: await clueView(c, a.m, next[0]) } : {}) });
  }

  // The last clue. The status change is conditional, so a repeated request cannot pay out twice.
  const xp = missionXp(a.m.xp_reward, a.pm.hints_total);
  const done = (await c.db.call(`${a.scope.table}?${a.scope.where}&status=eq.active`, { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ status: 'completed', score: xp, completed_at: c.now }) })) as PlayerMissionRow[] | null;
  if (!done || done.length !== 1) return fail(409, 'This mission is already finished.');
  return finish(c, a, xp);
}

async function abandon(c: MissionCtx): Promise<MissionOut> {
  const a = await activeMission(c);
  if (isOut(a)) return a;
  if (a.scope.team && a.scope.team.role !== 'owner') return fail(403, 'Only the team owner can give up a team hunt.');
  await c.db.call(`${a.scope.table}?${a.scope.where}&status=eq.active`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ status: 'abandoned' }) });
  await log(c, a.scope.team ? 'team_hunt_abandoned' : 'mission_abandoned', a.m.city_id, { mission: a.m.id, stage: a.pm.stage });
  return ok({ abandoned: true });
}

async function myTreasures(c: MissionCtx): Promise<MissionOut> {
  const mine = ((await c.db.call(`game_player_treasures?player_id=eq.${c.playerId}&select=treasure_id,discovery_status,verification_status,claim_status,unlocked_at,discovered_at&order=unlocked_at.desc`)) as PlayerTreasureRow[] | null) ?? [];
  if (mine.length === 0) return ok({ treasures: [] });
  const ts = ((await c.db.call(`game_treasures?id=in.(${mine.map((p) => p.treasure_id).join(',')})&select=id,city_id,class_id,status,found_by`)) as TreasureRow[] | null) ?? [];
  const byId = new Map(ts.map((t) => [t.id, t]));
  const out: Record<string, unknown>[] = [];
  for (const p of mine) {
    const t = byId.get(p.treasure_id);
    if (!t) continue;
    // Where it is, only while it can still be collected by this player.
    const zone = p.discovery_status === 'unlocked' && t.status === 'hidden' ? await zoneFor(c, t.id) : null;
    out.push({ ...treasureCard(t), discovery: p.discovery_status, verification: p.verification_status, claim: p.claim_status, unlockedAt: Number(p.unlocked_at), discoveredAt: p.discovered_at === null ? null : Number(p.discovered_at), available: t.status === 'hidden', zone });
  }
  return ok({ treasures: out });
}

async function collect(c: MissionCtx): Promise<MissionOut> {
  const id = typeof c.body.treasure === 'string' && /^[0-9a-f-]{36}$/.test(c.body.treasure) ? c.body.treasure : null;
  if (!id) return fail(400, 'That treasure does not exist.');
  const rows = (await c.db.call(`game_player_treasures?player_id=eq.${c.playerId}&treasure_id=eq.${id}&select=treasure_id,discovery_status,verification_status,claim_status,unlocked_at,discovered_at&limit=1`)) as PlayerTreasureRow[] | null;
  const mine = rows?.[0];
  // A treasure you have not unlocked looks exactly like one that does not exist.
  if (!mine) return fail(404, 'You have not found a way to that treasure yet.');
  if (mine.discovery_status === 'discovered') return fail(409, 'You have already collected this treasure.');
  const t = await treasureRow(c, id);
  if (!t) return fail(404, 'You have not found a way to that treasure yet.');
  if (t.status !== 'hidden') return fail(409, 'Someone else reached this treasure first.');
  const zone = await zoneFor(c, t.id);
  if (!zone) return fail(409, 'This treasure cannot be collected right now.');
  if ((await c.selected()) !== t.city_id) return fail(409, `Go to ${cityById(t.city_id)?.name ?? 'its city'} first.`);
  const here = await c.position(t.city_id);
  if (here.travel) return fail(409, 'Finish your journey first.');
  if (distanceKm(here.position, [zone.lng as number, zone.lat as number]) * 1000 > (zone.radiusM as number)) return fail(409, 'You are not close enough yet. Travel to the marked place.');
  // First to arrive takes it: one conditional update decides, so two players can never both win.
  const won = (await c.db.call(`game_treasures?id=eq.${t.id}&status=eq.hidden`, { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ status: 'found', found_by: c.playerId, found_at: c.now }) })) as TreasureRow[] | null;
  if (!won || won.length !== 1) return fail(409, 'Someone else reached this treasure first.');
  const k = classOf(t.class_id);
  // Small coins are recorded as verified at once; anything of value waits for the operator to verify it before it is an entitlement.
  const verification = (k?.usd ?? 0) <= 0.1 ? 'verified' : 'pending';
  await c.db.call(`game_player_treasures?player_id=eq.${c.playerId}&treasure_id=eq.${t.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ discovery_status: 'discovered', verification_status: verification, discovered_at: c.now }) });
  const xp = treasureXp(k?.rank ?? 8);
  await c.db.call('rpc/game_award_xp', { method: 'POST', body: JSON.stringify({ p_player: c.playerId, p_city: t.city_id, p_xp: xp, p_discoveries: 1, p_missions: 0 }) });
  await log(c, 'treasure_discovered', t.city_id, { treasure: t.id, class: t.class_id, verification });
  // First Finder: the first player ever to collect this class of treasure in this city. One holder, enforced by a unique index.
  let firstFinder = false;
  try {
    await c.db.call('game_player_achievements', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ player_id: c.playerId, achievement_id: `ff-${t.city_id}-${t.class_id}`, unlocked_at: c.now }) });
    firstFinder = true;
  } catch {
    // someone already holds it
  }
  let bonus = 0;
  if (firstFinder) {
    bonus = xp;
    await c.db.call('rpc/game_award_xp', { method: 'POST', body: JSON.stringify({ p_player: c.playerId, p_city: t.city_id, p_xp: bonus, p_discoveries: 0, p_missions: 0 }) });
    await log(c, 'first_finder', t.city_id, { class: t.class_id, xp: bonus });
  }
  return ok({ discovered: true, xp, firstFinder, firstFinderBonus: bonus, treasure: { ...treasureCard(t), verification, discoveredAt: c.now } });
}

/** Handles a mission or treasure op, or returns null for any other op. */
export async function missionOp(op: unknown, c: MissionCtx): Promise<MissionOut | null> {
  switch (op) {
    case 'missions': return listMissions(c);
    case 'mission-start': return startMission(c);
    case 'clue': return showClue(c);
    case 'hint': return takeHint(c);
    case 'answer': return answerClue(c);
    case 'mission-abandon': return abandon(c);
    case 'treasures': return myTreasures(c);
    case 'collect': return collect(c);
    default: return null;
  }
}
