import { describe, expect, it } from 'vitest';
import { boardOp, type BoardCtx } from './_gameBoards.js';
import { periodEnd, periodStart } from '../src/game/periods.js';

type Row = Record<string, unknown>;
const NOW = Date.UTC(2026, 10, 18, 15, 30); // Wednesday 18 November 2026, 15:30 UTC
const P1 = '00000000-0000-4000-8000-000000000001';
const P2 = '00000000-0000-4000-8000-000000000002';
const P3 = '00000000-0000-4000-8000-000000000003';

function world() {
  const t: Record<string, Row[]> = { game_teams: [], game_team_members: [], game_player_profiles: [{ player_id: P1, display_name: 'Ada' }, { player_id: P2, display_name: '' }, { player_id: P3, display_name: 'Cy' }], game_player_activities: [] };
  const rpcCalls: { name: string; body: Row }[] = [];
  const rpcReply: Record<string, unknown> = {};
  let seq = 0;
  const match = (row: Row, params: URLSearchParams): boolean => {
    for (const [k, v] of params) {
      if (['select', 'order', 'limit'].includes(k)) continue;
      const i = v.indexOf('.');
      const op = v.slice(0, i);
      const val = v.slice(i + 1);
      if (op === 'eq' && String(row[k]) !== val) return false;
      if (op === 'in' && !val.slice(1, -1).split(',').includes(String(row[k]))) return false;
    }
    return true;
  };
  const unique = (table: string, row: Row): boolean => {
    if (table === 'game_teams') return t.game_teams!.some((r) => String(r.name).toLowerCase() === String(row.name).toLowerCase() || r.join_code === row.join_code);
    if (table === 'game_team_members') return t.game_team_members!.some((r) => r.player_id === row.player_id);
    return false;
  };
  const db = { async call(path: string, init: RequestInit = {}) {
    const [table, query = ''] = path.split('?');
    const params = new URLSearchParams(query);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Row) : {};
    if (table!.startsWith('rpc/')) {
      rpcCalls.push({ name: table!.slice(4), body });
      return rpcReply[table!.slice(4)] ?? null;
    }
    const rows = (t[table!] ??= []);
    if (method === 'POST') {
      if (unique(table!, body)) throw new Error('answered 409');
      const row = { id: `00000000-0000-4000-8000-0000000001${String(++seq).padStart(2, '0')}`, ...body };
      rows.push(row);
      return String((init.headers as Record<string, string> | undefined)?.prefer).includes('representation') ? [row] : null;
    }
    const hit = rows.filter((r) => match(r, params));
    if (method === 'DELETE') {
      t[table!] = rows.filter((r) => !hit.includes(r));
      if (table === 'game_teams') t.game_team_members = t.game_team_members!.filter((m) => rows.some((r) => r.id === m.team_id) && !hit.some((h) => h.id === m.team_id));
      return null;
    }
    if (method === 'PATCH') {
      for (const r of hit) Object.assign(r, body);
      return null;
    }
    const order = params.get('order');
    if (order) hit.sort((a, b) => Number(a.joined_at) - Number(b.joined_at));
    const limit = Number(params.get('limit') ?? 0);
    return limit > 0 ? hit.slice(0, limit) : hit;
  } };
  const ctx = (player: string, body: Row, now = NOW): BoardCtx => ({ db, playerId: player, network: 'solana', addressNorm: 'addr', body, now });
  return { t, ctx, rpcCalls, rpcReply };
}

describe('periods', () => {
  it('start and end each window on UTC boundaries, weeks on Monday', () => {
    expect(new Date(periodStart('day', NOW)).toISOString()).toBe('2026-11-18T00:00:00.000Z');
    expect(new Date(periodEnd('day', NOW)!).toISOString()).toBe('2026-11-19T00:00:00.000Z');
    expect(new Date(periodStart('week', NOW)).toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(new Date(periodEnd('week', NOW)!).toISOString()).toBe('2026-11-23T00:00:00.000Z');
    expect(new Date(periodStart('month', NOW)).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(new Date(periodEnd('month', NOW)!).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(periodStart('all', NOW)).toBe(0);
    expect(periodEnd('all', NOW)).toBeNull();
    // A Sunday belongs to the week that started the Monday before.
    expect(new Date(periodStart('week', Date.UTC(2026, 10, 22, 23))).toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(new Date(periodEnd('month', Date.UTC(2026, 11, 31, 23))!).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('leaderboards', () => {
  it('asks the database for the right window and city, marks the player, and passes on no ids', async () => {
    const w = world();
    w.rpcReply.game_leaderboard = [{ player_id: P2, display_name: 'Explorer 0000', xp: 300, rank: 1 }, { player_id: P1, display_name: 'Ada', xp: 200, rank: 2 }];
    w.rpcReply.game_player_rank = 2;
    const r = await boardOp('leaderboard', w.ctx(P1, { period: 'week', city: 'paris' }));
    expect(r!.status).toBe(200);
    expect(w.rpcCalls[0]).toEqual({ name: 'game_leaderboard', body: { p_city: 'paris', p_since: Date.UTC(2026, 10, 16), p_limit: 50 } });
    expect(r!.data).toMatchObject({ scope: 'city', city: 'paris', period: 'week', yourRank: 2, endsAt: Date.UTC(2026, 10, 23) });
    expect(r!.data.entries).toEqual([{ rank: 1, name: 'Explorer 0000', xp: 300, you: false }, { rank: 2, name: 'Ada', xp: 200, you: true }]);
    expect(JSON.stringify(r!.data)).not.toContain(P2);
  });

  it('defaults to the global all-time board, and refuses an unknown city', async () => {
    const w = world();
    const r = await boardOp('leaderboard', w.ctx(P1, { period: 'sometime' }));
    expect(r!.data).toMatchObject({ scope: 'global', period: 'all', entries: [], yourRank: null });
    expect(w.rpcCalls[0]!.body).toEqual({ p_city: null, p_since: 0, p_limit: 50 });
    expect((await boardOp('leaderboard', w.ctx(P1, { city: 'atlantis' })))!.status).toBe(400);
    expect((await boardOp('leaderboard', w.ctx(P1, { city: 7 })))!.status).toBe(400);
  });
});

describe('teams', () => {
  it('lets a player make a team, shows the join code to members, and lets others join with it', async () => {
    const w = world();
    expect((await boardOp('team', w.ctx(P1, {})))!.data.team).toBeNull();
    const made = await boardOp('team-create', w.ctx(P1, { name: '  Night   Owls ' }));
    const team = made!.data.team as { name: string; joinCode: string; owner: boolean; members: { name: string; you: boolean; role: string }[] };
    expect(team).toMatchObject({ name: 'Night Owls', owner: true, members: [{ name: 'Ada', you: true, role: 'owner' }] });
    expect(team.joinCode).toMatch(/^[0-9A-F]{8}$/);
    const joined = await boardOp('team-join', w.ctx(P2, { code: team.joinCode.toLowerCase() }));
    expect((joined!.data.team as { owner: boolean; members: { name: string }[] }).owner).toBe(false);
    expect((joined!.data.team as { members: { name: string }[] }).members.map((m) => m.name)).toEqual(['Ada', 'Explorer 0000']);
    expect(w.t.game_player_activities!.map((a) => a.activity_type)).toEqual(['team_created', 'team_joined']);
  });

  it('refuses bad names, duplicate names, a second team, bad or unknown codes and a full team', async () => {
    const w = world();
    for (const bad of ['', 'x', '<b>', 'y'.repeat(25), 5]) expect((await boardOp('team-create', w.ctx(P1, { name: bad })))!.status).toBe(400);
    const made = await boardOp('team-create', w.ctx(P1, { name: 'Owls' }));
    const code = (made!.data.team as { joinCode: string }).joinCode;
    expect((await boardOp('team-create', w.ctx(P1, { name: 'Other' })))!.status).toBe(409);
    expect((await boardOp('team-create', w.ctx(P2, { name: 'owls' })))!.status).toBe(409);
    expect((await boardOp('team-join', w.ctx(P2, { code: 'nope' })))!.status).toBe(400);
    expect((await boardOp('team-join', w.ctx(P2, { code: 'FFFFFFFF' })))!.status).toBe(404);
    expect((await boardOp('team-join', w.ctx(P1, { code })))!.status).toBe(409);
    const teamId = w.t.game_teams![0]!.id;
    for (let i = 0; i < 18; i++) w.t.game_team_members!.push({ team_id: teamId, player_id: `x${i}`, role: 'member', joined_at: 5 });
    expect((await boardOp('team-join', w.ctx(P2, { code })))!.status).toBe(200);
    expect((await boardOp('team-join', w.ctx(P3, { code })))!.status).toBe(409); // 20 members already
  });

  it('hands the team to the longest-standing member when the owner leaves, and removes an empty team', async () => {
    const w = world();
    const code = ((await boardOp('team-create', w.ctx(P1, { name: 'Owls' })))!.data.team as { joinCode: string }).joinCode;
    w.t.game_team_members![0]!.joined_at = 1;
    await boardOp('team-join', w.ctx(P2, { code }));
    w.t.game_team_members![1]!.joined_at = 2;
    expect((await boardOp('team-leave', w.ctx(P1, {})))!.data.team).toBeNull();
    expect(w.t.game_team_members!.map((m) => [m.player_id, m.role])).toEqual([[P2, 'owner']]);
    await boardOp('team-leave', w.ctx(P2, {}));
    expect(w.t.game_teams).toHaveLength(0);
    expect((await boardOp('team-leave', w.ctx(P2, {})))!.data.team).toBeNull();
  });

  it('shows team standings with names, sizes and ranks only', async () => {
    const w = world();
    w.rpcReply.game_team_board = [{ team_id: 'secret-id', name: 'Owls', xp: 500, members: 2, rank: 1 }];
    const r = await boardOp('team-board', w.ctx(P1, { period: 'day' }));
    expect(w.rpcCalls[0]!.body).toEqual({ p_since: Date.UTC(2026, 10, 18), p_limit: 50 });
    expect(r!.data.entries).toEqual([{ rank: 1, name: 'Owls', xp: 500, members: 2 }]);
    expect(JSON.stringify(r!.data)).not.toContain('secret-id');
  });

  it('ignores ops it does not own', async () => {
    expect(await boardOp('missions', world().ctx(P1, {}))).toBeNull();
  });
});
