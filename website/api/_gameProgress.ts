/**
 * Ultimate City Search, milestone 6: progression. XP and levels are kept by the database function that awards them; this unlocks
 * achievements from counts the server holds, and serves the player's progress, statistics and history. Nothing here trusts the page.
 */
import { ACHIEVEMENTS, levelFor, newlyEarned, xpToNext, type Snapshot } from '../src/game/achievements.js';
import { CITIES } from '../src/game/cities.js';
import type { Rest } from './_swingsAccount.js';

export interface ProgressCtx {
  db: Rest;
  playerId: string;
  network: string;
  addressNorm: string;
  now: number;
}
export interface Unlock { id: string; title: string; xp: number }

interface ProfileRow { display_name: string; avatar: string | null; explorer_level: number; total_xp: number; total_discoveries: number; missions_completed: number }
interface CityProgressRow { city_id: string; city_xp: number; discoveries: number; completed_missions: number; first_visit_at: number; last_visit_at: number }

async function profile(db: Rest, playerId: string): Promise<ProfileRow | null> {
  const rows = (await db.call(`game_player_profiles?player_id=eq.${playerId}&select=display_name,avatar,explorer_level,total_xp,total_discoveries,missions_completed&limit=1`)) as ProfileRow[] | null;
  return rows?.[0] ?? null;
}

async function count(db: Rest, path: string): Promise<number> {
  const rows = (await db.call(`${path}&select=id&limit=1000`)) as unknown[] | null;
  return rows?.length ?? 0;
}

async function snapshot(c: ProgressCtx): Promise<Snapshot> {
  const [p, cities, flights, hintFree] = await Promise.all([
    profile(c.db, c.playerId),
    c.db.call(`game_player_cities?player_id=eq.${c.playerId}&select=city_id&limit=100`) as Promise<unknown[] | null>,
    count(c.db, `game_player_activities?player_id=eq.${c.playerId}&activity_type=eq.flight_landed`),
    count(c.db, `game_player_missions?player_id=eq.${c.playerId}&status=eq.completed&hints_total=eq.0`),
  ]);
  return { citiesVisited: cities?.length ?? 0, missionsCompleted: p?.missions_completed ?? 0, discoveries: p?.total_discoveries ?? 0, flightsLanded: flights, hintFreeCompletions: hintFree, explorerLevel: p?.explorer_level ?? 1 };
}

/** Unlocks every achievement the player has now earned and does not yet hold, paying each one's XP once. */
export async function evaluateAchievements(c: ProgressCtx): Promise<Unlock[]> {
  const have = new Set(((await c.db.call(`game_player_achievements?player_id=eq.${c.playerId}&select=achievement_id&limit=200`)) as { achievement_id: string }[] | null)?.map((r) => r.achievement_id) ?? []);
  const fresh = newlyEarned(await snapshot(c), have);
  const out: Unlock[] = [];
  for (const a of fresh) {
    // The unique (player, achievement) row is the lock: only the request that inserts it pays the XP.
    const inserted = (await c.db.call('game_player_achievements?on_conflict=player_id,achievement_id', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify({ player_id: c.playerId, achievement_id: a.id, unlocked_at: c.now }) })) as unknown[] | null;
    if (!inserted || inserted.length !== 1) continue;
    await c.db.call('rpc/game_award_xp', { method: 'POST', body: JSON.stringify({ p_player: c.playerId, p_city: null, p_xp: a.xp, p_discoveries: 0, p_missions: 0 }) });
    await c.db.call('game_player_activities', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ player_id: c.playerId, wallet_address: c.addressNorm, network: c.network, activity_type: 'achievement_unlocked', city_id: null, metadata: { achievement: a.id, xp: a.xp }, created_at: c.now }) });
    out.push({ id: a.id, title: a.title, xp: a.xp });
  }
  return out;
}

/** The player's level, achievements (earned or not), per-city statistics and totals. */
export async function progress(c: ProgressCtx): Promise<Record<string, unknown>> {
  const [p, mine, cityRows, snap] = await Promise.all([
    profile(c.db, c.playerId),
    c.db.call(`game_player_achievements?player_id=eq.${c.playerId}&select=achievement_id,unlocked_at&limit=200`) as Promise<{ achievement_id: string; unlocked_at: number }[] | null>,
    c.db.call(`game_player_cities?player_id=eq.${c.playerId}&select=city_id,city_xp,discoveries,completed_missions,first_visit_at,last_visit_at&limit=100`) as Promise<CityProgressRow[] | null>,
    snapshot(c),
  ]);
  const xp = Number(p?.total_xp ?? 0);
  const unlocked = new Map((mine ?? []).map((r) => [r.achievement_id, Number(r.unlocked_at)]));
  const byCity = new Map((cityRows ?? []).map((r) => [r.city_id, r]));
  return {
    profile: { displayName: p?.display_name ?? '', avatar: p?.avatar ?? null },
    level: { current: levelFor(xp), xp, toNext: xpToNext(xp) },
    totals: { xp, discoveries: snap.discoveries, missionsCompleted: snap.missionsCompleted, citiesVisited: snap.citiesVisited, flightsLanded: snap.flightsLanded, hintFreeCompletions: snap.hintFreeCompletions },
    firstFinds: (mine ?? []).filter((r) => r.achievement_id.startsWith('ff-')).map((r) => {
      const rest = r.achievement_id.slice(3);
      const cut = rest.lastIndexOf('-');
      const cityId = rest.slice(0, cut);
      const cls = rest.slice(cut + 1);
      return { cityId, class: cls, unlockedAt: Number(r.unlocked_at) };
    }),
    achievements: ACHIEVEMENTS.map((a) => ({ id: a.id, title: a.title, description: a.description, xp: a.xp, unlockedAt: unlocked.get(a.id) ?? null })),
    cities: CITIES.map((city) => {
      const r = byCity.get(city.id);
      return { id: city.id, visited: Boolean(r), cityXp: Number(r?.city_xp ?? 0), discoveries: r?.discoveries ?? 0, completedMissions: r?.completed_missions ?? 0, lastVisitAt: r ? Number(r.last_visit_at) : null };
    }),
  };
}

const META_KEYS = ['mission', 'stage', 'mode', 'km', 'to', 'from', 'class', 'xp', 'first', 'n', 'achievement', 'hints', 'verification'];
const PAGE = 50;

/** The player's own activity, newest first, a page at a time (`before` is the `next` of the previous page). */
export async function history(c: ProgressCtx, before: unknown): Promise<Record<string, unknown>> {
  const cursor = typeof before === 'number' && Number.isFinite(before) ? `&created_at=lt.${Math.floor(before)}` : '';
  const rows = ((await c.db.call(`game_player_activities?player_id=eq.${c.playerId}${cursor}&select=id,activity_type,city_id,metadata,created_at&order=created_at.desc&limit=${PAGE + 1}`)) as { id: string; activity_type: string; city_id: string | null; metadata: Record<string, unknown> | null; created_at: number }[] | null) ?? [];
  const page = rows.slice(0, PAGE);
  return {
    items: page.map((r) => ({ id: r.id, type: r.activity_type, cityId: r.city_id, at: Number(r.created_at), details: Object.fromEntries(Object.entries(r.metadata ?? {}).filter(([k]) => META_KEYS.includes(k))) })),
    next: rows.length > PAGE ? Number(page[page.length - 1]!.created_at) : null,
  };
}

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{1,23}$/u;

/** Sets the name shown on leaderboards. Letters, numbers, spaces and _ . - only, 2 to 24 characters. */
export async function setDisplayName(c: ProgressCtx, name: unknown): Promise<{ ok: true; displayName: string } | { ok: false; message: string }> {
  const clean = typeof name === 'string' ? name.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
  if (!NAME.test(clean)) return { ok: false, message: 'Use 2 to 24 letters, numbers, spaces, dots, dashes or underscores.' };
  await c.db.call(`game_player_profiles?player_id=eq.${c.playerId}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ display_name: clean }) });
  await c.db.call('game_player_activities', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ player_id: c.playerId, wallet_address: c.addressNorm, network: c.network, activity_type: 'profile_updated', city_id: null, metadata: {}, created_at: c.now }) });
  return { ok: true, displayName: clean };
}
