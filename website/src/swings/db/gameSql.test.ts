/**
 * Runs the game's real SQL (migrations 0024 to 0029) on a real Postgres engine (PGlite) and checks what the database itself
 * promises: XP is added atomically with a ledger row, boards rank by window and city and show names only, a team's score is its
 * members' XP, there is one Diamond per city, and there is one first finder per class and city.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { applyMigrations, loadMigrations, type SqlClient } from './migrate.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const dir = join(process.cwd(), 'supabase', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
const P = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let db: PGlite;
const q = async (sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> => (await db.query(sql, params)).rows as Record<string, unknown>[];

beforeAll(async () => {
  db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;');
  const sql: SqlClient = { exec: async (s) => void (await db.exec(s)), query: q };
  await applyMigrations(sql, loadMigrations(files));
  for (let i = 1; i <= 4; i++) {
    await db.exec(`insert into public.game_players (id, created_at) values ('${P(i)}', 1); insert into public.game_player_profiles (player_id, display_name) values ('${P(i)}', '${i === 3 ? '' : 'Player' + i}');`);
  }
  for (const [p, city] of [[1, 'paris'], [1, 'london'], [2, 'paris'], [3, 'paris']] as const) {
    await db.exec(`insert into public.game_player_cities (player_id, city_id, first_visit_at, last_visit_at) values ('${P(p)}', '${city}', 1, 1)`);
  }
});

const award = (p: number, city: string | null, xp: number, disc = 0, missions = 0): Promise<unknown> => q('select public.game_award_xp($1, $2, $3, $4, $5)', [P(p), city, xp, disc, missions]);

describe('XP awards', () => {
  it('adds to the profile, the city and the ledger together, and sets the level', async () => {
    await award(1, 'paris', 150, 0, 1);
    await award(1, 'london', 50, 1, 0);
    await award(2, 'paris', 300);
    await award(3, 'paris', 300);
    await award(4, null, 20); // a player who never entered a city: only the profile and ledger change
    const p1 = (await q(`select total_xp, total_discoveries, missions_completed, explorer_level from public.game_player_profiles where player_id = '${P(1)}'`))[0]!;
    expect(p1).toMatchObject({ total_xp: 200, total_discoveries: 1, missions_completed: 1, explorer_level: 2 });
    const c = (await q(`select city_id, city_xp from public.game_player_cities where player_id = '${P(1)}' order by city_id`)) as { city_id: string; city_xp: number }[];
    expect(c.map((r) => [r.city_id, Number(r.city_xp)])).toEqual([['london', 50], ['paris', 150]]);
    expect(Number((await q(`select sum(xp) as s from public.game_xp_events where player_id = '${P(1)}'`))[0]!.s)).toBe(200);
    expect(Number((await q('select count(*) as n from public.game_xp_events'))[0]!.n)).toBe(5);
  });

  it('is not callable by the public roles', async () => {
    await db.exec('set role anon');
    await expect(q('select public.game_award_xp($1, $2, 1, 0, 0)', [P(1), 'paris'])).rejects.toThrow(/permission denied/);
    await db.exec('reset role');
  });
});

describe('boards', () => {
  it('ranks globally with ties sharing a rank, and shows names, never ids or wallets', async () => {
    const rows = (await q('select * from public.game_leaderboard(null, 0, 50)')) as { player_id: string; display_name: string; xp: number; rank: number }[];
    expect(rows.map((r) => [r.display_name, Number(r.xp), Number(r.rank)])).toEqual([
      ['Player2', 300, 1],
      ['Explorer 0000', 300, 1],
      ['Player1', 200, 3],
      ['Player4', 20, 4],
    ]);
    expect(Object.keys(rows[0]!).sort()).toEqual(['display_name', 'player_id', 'rank', 'xp']);
  });

  it('ranks per city, ignoring XP earned elsewhere', async () => {
    const rows = (await q("select display_name, xp from public.game_leaderboard('london', 0, 50)")) as { display_name: string; xp: number }[];
    expect(rows.map((r) => [r.display_name, Number(r.xp)])).toEqual([['Player1', 50]]);
  });

  it('counts only a window, and caps the length of a board', async () => {
    await db.exec(`insert into public.game_xp_events (player_id, city_id, xp, at) values ('${P(4)}', 'paris', 1000, 10)`);
    const xpOf = async (since: number): Promise<number> => Number(((await q('select xp from public.game_leaderboard(null, $1, 50) where display_name = $2', [since, 'Player4'])) as { xp: number }[])[0]!.xp);
    expect(await xpOf(0)).toBe(1020);
    expect(await xpOf(11)).toBe(20);
    expect((await q('select * from public.game_leaderboard(null, 0, 1)')).length).toBe(1);
    expect((await q('select * from public.game_leaderboard(null, 0, 100000)')).length).toBeLessThanOrEqual(100);
    await db.exec('delete from public.game_xp_events where at = 10');
  });

  it('gives a player their rank, and null when they have no XP in the window', async () => {
    expect(Number((await q('select public.game_player_rank($1, null, 0) as r', [P(1)]))[0]!.r)).toBe(3);
    expect(Number((await q('select public.game_player_rank($1, null, 0) as r', [P(2)]))[0]!.r)).toBe(1);
    expect((await q('select public.game_player_rank($1, $2, 0) as r', [P(2), 'london']))[0]!.r).toBeNull();
    expect((await q('select public.game_player_rank($1, null, 9000000000000000) as r', [P(1)]))[0]!.r).toBeNull();
  });
});

describe('teams', () => {
  it('score a team by its members XP, allow one team per player and unique names', async () => {
    await db.exec(`insert into public.game_teams (id, name, join_code, created_by, created_at) values
      ('${P(101)}', 'Night Owls', 'AAAAAAAA', '${P(1)}', 1), ('${P(102)}', 'Early Birds', 'BBBBBBBB', '${P(2)}', 1);
      insert into public.game_team_members (team_id, player_id, role, joined_at) values
      ('${P(101)}', '${P(1)}', 'owner', 1), ('${P(101)}', '${P(3)}', 'member', 2), ('${P(102)}', '${P(2)}', 'owner', 1)`);
    const rows = (await q('select name, xp, members, rank from public.game_team_board(0, 10)')) as { name: string; xp: number; members: number; rank: number }[];
    expect(rows.map((r) => [r.name, Number(r.xp), Number(r.members), Number(r.rank)])).toEqual([['Night Owls', 500, 2, 1], ['Early Birds', 300, 1, 2]]);
    await expect(db.exec(`insert into public.game_team_members (team_id, player_id, joined_at) values ('${P(102)}', '${P(1)}', 3)`)).rejects.toThrow(/duplicate key/);
    await expect(db.exec(`insert into public.game_teams (name, join_code, created_by, created_at) values ('night owls', 'CCCCCCCC', '${P(4)}', 1)`)).rejects.toThrow(/duplicate key/);
    await expect(db.exec(`insert into public.game_teams (name, join_code, created_by, created_at) values ('Bad Code', 'xyz', '${P(4)}', 1)`)).rejects.toThrow();
  });
});

describe('one-of-a-kind rules', () => {
  it('allows one live Diamond Treasure per city, and a new one once the old is withdrawn', async () => {
    await db.exec("insert into public.game_treasures (id, city_id, class_id) values ('" + P(201) + "', 'paris', 'diamond')");
    await expect(db.exec("insert into public.game_treasures (city_id, class_id) values ('paris', 'diamond')")).rejects.toThrow(/duplicate key/);
    await db.exec("insert into public.game_treasures (city_id, class_id) values ('london', 'diamond'), ('paris', 'golden'), ('paris', 'golden')");
    await db.exec("update public.game_treasures set status = 'withdrawn' where id = '" + P(201) + "'");
    await db.exec("insert into public.game_treasures (city_id, class_id) values ('paris', 'diamond')");
  });

  it('allows one first finder per class and city, ever', async () => {
    await db.exec(`insert into public.game_player_achievements (player_id, achievement_id, unlocked_at) values ('${P(1)}', 'ff-paris-diamond', 1)`);
    await expect(db.exec(`insert into public.game_player_achievements (player_id, achievement_id, unlocked_at) values ('${P(2)}', 'ff-paris-diamond', 2)`)).rejects.toThrow(/duplicate key/);
    await db.exec(`insert into public.game_player_achievements (player_id, achievement_id, unlocked_at) values ('${P(2)}', 'ff-paris-golden', 2), ('${P(2)}', 'first-steps', 2), ('${P(1)}', 'first-steps', 2)`);
  });

  it('holds the eight classes with the stated values', async () => {
    const rows = (await q('select id, usd_value from public.game_treasure_classes order by rarity_rank')) as { id: string; usd_value: string }[];
    expect(rows.map((r) => [r.id, Number(r.usd_value)])).toEqual([['diamond', 1000], ['golden', 587], ['lithium', 212], ['silver', 65], ['cerium', 37], ['samarium', 1], ['thulium', 0.1], ['lutetium', 0.0027]]);
    expect((await q('select id from public.game_cities')).length).toBe(9);
  });
});
