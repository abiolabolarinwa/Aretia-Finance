/**
 * Ultimate City Search, milestone 7: leaderboards and teams. Boards are built in the database from the XP ledger and show display
 * names only: no wallet address, no player id and nothing about a treasure ever leaves here. A team is a name and a join code that
 * only its members can see; its score is the XP its current members earn.
 */
import { randomBytes } from 'node:crypto';
import { cityById } from '../src/game/cities.js';
import { isPeriod, periodEnd, periodStart } from '../src/game/periods.js';
import type { Rest } from './_swingsAccount.js';

export interface BoardCtx {
  db: Rest;
  playerId: string;
  network: string;
  addressNorm: string;
  body: Record<string, unknown>;
  now: number;
}
export type BoardOut = { status: number; data: Record<string, unknown> };

const fail = (status: number, message: string): BoardOut => ({ status, data: { error: 'board', message } });
const ok = (data: Record<string, unknown>): BoardOut => ({ status: 200, data });

const TOP = 50;
const MAX_MEMBERS = 20;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{1,23}$/u;

async function log(c: BoardCtx, type: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await c.db.call('game_player_activities', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ player_id: c.playerId, wallet_address: c.addressNorm, network: c.network, activity_type: type, city_id: null, metadata, created_at: c.now }) });
}

async function leaderboard(c: BoardCtx): Promise<BoardOut> {
  const period = isPeriod(c.body.period) ? c.body.period : 'all';
  let city: string | null = null;
  if (c.body.city !== undefined && c.body.city !== null) {
    city = typeof c.body.city === 'string' ? (cityById(c.body.city)?.id ?? null) : null;
    if (!city) return fail(400, 'That city does not exist.');
  }
  const since = periodStart(period, c.now);
  const [rows, mine] = await Promise.all([
    c.db.call('rpc/game_leaderboard', { method: 'POST', body: JSON.stringify({ p_city: city, p_since: since, p_limit: TOP }) }) as Promise<{ player_id: string; display_name: string; xp: number; rank: number }[] | null>,
    c.db.call('rpc/game_player_rank', { method: 'POST', body: JSON.stringify({ p_player: c.playerId, p_city: city, p_since: since }) }) as Promise<number | null>,
  ]);
  return ok({
    scope: city ? 'city' : 'global',
    city,
    period,
    endsAt: periodEnd(period, c.now),
    entries: (rows ?? []).map((r) => ({ rank: Number(r.rank), name: r.display_name, xp: Number(r.xp), you: r.player_id === c.playerId })),
    yourRank: mine === null || mine === undefined ? null : Number(mine),
  });
}

async function myTeam(c: BoardCtx): Promise<{ id: string; name: string; join_code: string; role: string } | null> {
  const m = (await c.db.call(`game_team_members?player_id=eq.${c.playerId}&select=team_id,role&limit=1`)) as { team_id: string; role: string }[] | null;
  if (!m?.[0]) return null;
  const t = (await c.db.call(`game_teams?id=eq.${m[0].team_id}&select=id,name,join_code&limit=1`)) as { id: string; name: string; join_code: string }[] | null;
  return t?.[0] ? { ...t[0], role: m[0].role } : null;
}

async function teamView(c: BoardCtx): Promise<BoardOut> {
  const team = await myTeam(c);
  if (!team) return ok({ team: null });
  const members = ((await c.db.call(`game_team_members?team_id=eq.${team.id}&select=player_id,role,joined_at&order=joined_at.asc`)) as { player_id: string; role: string }[] | null) ?? [];
  const ids = members.map((m) => m.player_id).join(',');
  const names = ids ? (((await c.db.call(`game_player_profiles?player_id=in.(${ids})&select=player_id,display_name`)) as { player_id: string; display_name: string }[] | null) ?? []) : [];
  const nameOf = new Map(names.map((n) => [n.player_id, n.display_name]));
  const board = (await c.db.call('rpc/game_team_board', { method: 'POST', body: JSON.stringify({ p_since: 0, p_limit: 100 }) })) as { team_id: string; xp: number; rank: number }[] | null;
  const week = (await c.db.call('rpc/game_team_board', { method: 'POST', body: JSON.stringify({ p_since: periodStart('week', c.now), p_limit: 100 }) })) as { team_id: string; xp: number; rank: number }[] | null;
  const all = board?.find((b) => b.team_id === team.id);
  const wk = week?.find((b) => b.team_id === team.id);
  return ok({
    team: {
      name: team.name,
      joinCode: team.join_code,
      owner: team.role === 'owner',
      members: members.map((m) => ({ name: nameOf.get(m.player_id) || `Explorer ${m.player_id.slice(0, 4)}`, you: m.player_id === c.playerId, role: m.role })),
      xp: { all: Number(all?.xp ?? 0), week: Number(wk?.xp ?? 0) },
      rank: { all: all ? Number(all.rank) : null, week: wk ? Number(wk.rank) : null },
    },
  });
}

async function teamBoard(c: BoardCtx): Promise<BoardOut> {
  const period = isPeriod(c.body.period) ? c.body.period : 'week';
  const rows = ((await c.db.call('rpc/game_team_board', { method: 'POST', body: JSON.stringify({ p_since: periodStart(period, c.now), p_limit: TOP }) })) as { name: string; xp: number; members: number; rank: number }[] | null) ?? [];
  return ok({ period, endsAt: periodEnd(period, c.now), entries: rows.map((r) => ({ rank: Number(r.rank), name: r.name, xp: Number(r.xp), members: Number(r.members) })) });
}

async function createTeam(c: BoardCtx): Promise<BoardOut> {
  const name = typeof c.body.name === 'string' ? c.body.name.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
  if (!NAME.test(name)) return fail(400, 'Use 2 to 24 letters, numbers, spaces, dots, dashes or underscores for the team name.');
  if (await myTeam(c)) return fail(409, 'You are already in a team. Leave it first.');
  const code = randomBytes(4).toString('hex').toUpperCase();
  let created: { id: string }[] | null;
  try {
    created = (await c.db.call('game_teams', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ name, join_code: code, created_by: c.playerId, created_at: c.now }) })) as { id: string }[] | null;
  } catch {
    return fail(409, 'A team with that name already exists.');
  }
  const id = created?.[0]?.id;
  if (!id) return fail(500, 'The team could not be made.');
  try {
    await c.db.call('game_team_members', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ team_id: id, player_id: c.playerId, role: 'owner', joined_at: c.now }) });
  } catch {
    await c.db.call(`game_teams?id=eq.${id}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } }).catch(() => undefined);
    return fail(409, 'You are already in a team. Leave it first.');
  }
  await log(c, 'team_created');
  return teamView(c);
}

async function joinTeam(c: BoardCtx): Promise<BoardOut> {
  const code = typeof c.body.code === 'string' ? c.body.code.trim().toUpperCase() : '';
  if (!/^[0-9A-F]{8}$/.test(code)) return fail(400, 'That join code is not valid.');
  if (await myTeam(c)) return fail(409, 'You are already in a team. Leave it first.');
  const t = (await c.db.call(`game_teams?join_code=eq.${code}&select=id&limit=1`)) as { id: string }[] | null;
  if (!t?.[0]) return fail(404, 'No team has that join code.');
  const size = (await c.db.call(`game_team_members?team_id=eq.${t[0].id}&select=player_id&limit=${MAX_MEMBERS + 1}`)) as unknown[] | null;
  if ((size?.length ?? 0) >= MAX_MEMBERS) return fail(409, 'That team is full.');
  try {
    await c.db.call('game_team_members', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ team_id: t[0].id, player_id: c.playerId, role: 'member', joined_at: c.now }) });
  } catch {
    return fail(409, 'You are already in a team. Leave it first.');
  }
  await log(c, 'team_joined');
  return teamView(c);
}

async function leaveTeam(c: BoardCtx): Promise<BoardOut> {
  const team = await myTeam(c);
  if (!team) return ok({ team: null });
  await c.db.call(`game_team_members?team_id=eq.${team.id}&player_id=eq.${c.playerId}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
  const left = (await c.db.call(`game_team_members?team_id=eq.${team.id}&select=player_id,joined_at&order=joined_at.asc&limit=1`)) as { player_id: string }[] | null;
  if (!left?.[0]) await c.db.call(`game_teams?id=eq.${team.id}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
  else if (team.role === 'owner') await c.db.call(`game_team_members?team_id=eq.${team.id}&player_id=eq.${left[0].player_id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ role: 'owner' }) });
  await log(c, 'team_left');
  return ok({ team: null });
}

/** Handles a board or team op, or returns null for any other op. */
export async function boardOp(op: unknown, c: BoardCtx): Promise<BoardOut | null> {
  switch (op) {
    case 'leaderboard': return leaderboard(c);
    case 'team': return teamView(c);
    case 'team-board': return teamBoard(c);
    case 'team-create': return createTeam(c);
    case 'team-join': return joinTeam(c);
    case 'team-leave': return leaveTeam(c);
    default: return null;
  }
}
