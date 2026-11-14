/**
 * A Cloudflare D1 (SQLite) implementation of the small data interface the game's server code uses (`Rest.call(path, init)`, shaped
 * like the PostgREST requests the code was first written against). It understands exactly the subset the game uses: eq / neq / gt /
 * gte / lt / lte / in / is / like filters, order, limit, select, insert (with ignore-duplicates, merge-duplicates and on_conflict),
 * update and delete with RETURNING, and the five server functions the game needs (award XP, leaderboard, rank, team board, admin
 * overview). Table and column names are checked against a fixed list and every value is a bound parameter, so nothing a player
 * sends can reach the SQL text.
 */
import type { Rest } from './_swingsAccount.js';

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface D1Like {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

type Row = Record<string, unknown>;

const TABLES = new Set([
  'auth_nonces', 'account_sessions', 'game_players', 'game_player_wallets', 'game_player_profiles', 'game_player_activities', 'game_cities',
  'game_player_cities', 'game_journeys', 'game_treasure_classes', 'game_treasures', 'game_treasure_locations', 'game_missions', 'game_clues',
  'game_player_missions', 'game_attempts', 'game_player_treasures', 'game_player_achievements', 'game_xp_events', 'game_teams',
  'game_team_members', 'game_prize_claims', 'game_reserve_entries', 'game_announcements', 'game_abuse_reports', 'game_admin_audit',
]);
/** Columns that hold JSON text. */
const JSON_COLS: Record<string, string[]> = {
  game_clues: ['hints'],
  game_player_activities: ['metadata'],
  game_admin_audit: ['details'],
  game_cities: ['bounds', 'transport', 'tint', 'landmarks'],
};
/** Columns that are true/false (stored 0/1). */
const BOOL_COLS: Record<string, string[]> = {
  game_attempts: ['correct'],
  game_announcements: ['active'],
  game_player_wallets: ['is_primary'],
};
const IDENT = /^[a-z_][a-z0-9_]*$/;
const RESERVED = new Set(['select', 'order', 'limit', 'on_conflict']);

const fail = (status: number): Error => new Error(`The game database answered ${status}.`);

function ident(name: string): string {
  if (!IDENT.test(name)) throw fail(400);
  return name;
}

function toDb(table: string, col: string, v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  if ((JSON_COLS[table] ?? []).includes(col) && typeof v === 'string') return v;
  return v;
}

function fromDb(table: string, row: Row): Row {
  const out: Row = { ...row };
  for (const c of JSON_COLS[table] ?? []) {
    if (typeof out[c] === 'string') {
      try {
        out[c] = JSON.parse(out[c] as string);
      } catch {
        // leave as text
      }
    }
  }
  for (const c of BOOL_COLS[table] ?? []) if (c in out) out[c] = Number(out[c]) === 1;
  return out;
}

interface Where { sql: string; values: unknown[] }

function where(table: string, params: URLSearchParams): Where {
  const parts: string[] = [];
  const values: unknown[] = [];
  const bools = BOOL_COLS[table] ?? [];
  for (const [k, v] of params) {
    if (RESERVED.has(k)) continue;
    const col = ident(k);
    const dot = v.indexOf('.');
    if (dot < 0) throw fail(400);
    const op = v.slice(0, dot);
    const val = v.slice(dot + 1);
    const asValue = (s: string): unknown => (bools.includes(col) ? (s === 'true' ? 1 : s === 'false' ? 0 : s) : s);
    const simple: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'like' };
    if (op in simple) {
      parts.push(`${col} ${simple[op]} ?`);
      values.push(op === 'like' ? val.split('*').join('%') : op === 'eq' || op === 'neq' ? asValue(val) : val);
    } else if (op === 'is') {
      if (val === 'null') parts.push(`${col} is null`);
      else if (val === 'true' || val === 'false') {
        parts.push(`${col} = ?`);
        values.push(val === 'true' ? 1 : 0);
      } else throw fail(400);
    } else if (op === 'in') {
      if (!val.startsWith('(') || !val.endsWith(')')) throw fail(400);
      const items = val.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
      if (items.length === 0) parts.push('0 = 1');
      else {
        parts.push(`${col} in (${items.map(() => '?').join(',')})`);
        values.push(...items.map(asValue));
      }
    } else throw fail(400);
  }
  return { sql: parts.length ? ` where ${parts.join(' and ')}` : '', values };
}

function cols(params: URLSearchParams): string {
  const s = params.get('select');
  if (!s || s === '*') return '*';
  return s.split(',').map((c) => ident(c.trim())).join(', ');
}

function mapError(e: unknown): Error {
  const m = e instanceof Error ? e.message : String(e);
  if (/UNIQUE constraint failed|unique/i.test(m)) return fail(409);
  if (/constraint|FOREIGN KEY/i.test(m)) return fail(400);
  return fail(500);
}

export interface D1Options {
  /** The clock used for the XP ledger. */
  now?: () => number;
}

export function d1Rest(db: D1Like, options: D1Options = {}): Rest {
  const now = options.now ?? Date.now;
  const all = async (sql: string, values: unknown[] = []): Promise<Row[]> => {
    try {
      return (await db.prepare(sql).bind(...values).all()).results as Row[];
    } catch (e) {
      throw mapError(e);
    }
  };
  const first = async (sql: string, values: unknown[] = []): Promise<Row | null> => (await all(sql, values))[0] ?? null;
  const num = (v: unknown): number => Number(v ?? 0);

  // ------------------------------------------------------------------ server functions
  async function awardXp(b: Row): Promise<null> {
    const player = String(b.p_player);
    const city = b.p_city === null || b.p_city === undefined ? null : String(b.p_city);
    const xp = num(b.p_xp);
    const disc = num(b.p_discoveries);
    const miss = num(b.p_missions);
    const stmts = [
      db.prepare('update game_player_profiles set total_xp = total_xp + ?, total_discoveries = total_discoveries + ?, missions_completed = missions_completed + ? where player_id = ?').bind(xp, disc, miss, player),
      db.prepare('update game_player_cities set city_xp = city_xp + ?, discoveries = discoveries + ?, completed_missions = completed_missions + ? where player_id = ? and city_id = ?').bind(xp, disc, miss, player, city),
    ];
    if (xp > 0) stmts.push(db.prepare('insert into game_xp_events (player_id, city_id, xp, at) values (?, ?, ?, ?)').bind(player, city, xp, now()));
    try {
      await db.batch(stmts);
    } catch (e) {
      throw mapError(e);
    }
    // The level follows from the total, so it is worked out from what is stored now.
    const p = await first('select total_xp from game_player_profiles where player_id = ?', [player]);
    if (p) await db.prepare('update game_player_profiles set explorer_level = ? where player_id = ?').bind(Math.floor(Math.sqrt(num(p.total_xp) / 100)) + 1, player).run();
    return null;
  }

  async function leaderboard(b: Row): Promise<Row[]> {
    const city = b.p_city === null || b.p_city === undefined ? null : String(b.p_city);
    const limit = Math.min(Math.max(Math.floor(num(b.p_limit)) || 1, 1), 100);
    const rows = await all(
      `select player_id, display_name, xp, rank from (
         select e.player_id as player_id,
                coalesce(nullif(p.display_name, ''), 'Explorer ' || substr(e.player_id, 1, 4)) as display_name,
                sum(e.xp) as xp,
                rank() over (order by sum(e.xp) desc) as rank
           from game_xp_events e join game_player_profiles p on p.player_id = e.player_id
          where e.at >= ? and (? is null or e.city_id = ?)
          group by e.player_id, p.display_name
       ) order by xp desc, player_id limit ?`,
      [num(b.p_since), city, city, limit],
    );
    return rows.map((r) => ({ ...r, xp: num(r.xp), rank: num(r.rank) }));
  }

  async function playerRank(b: Row): Promise<number | null> {
    const city = b.p_city === null || b.p_city === undefined ? null : String(b.p_city);
    const since = num(b.p_since);
    const mine = await first('select sum(xp) as xp from game_xp_events where player_id = ? and at >= ? and (? is null or city_id = ?)', [String(b.p_player), since, city, city]);
    if (!mine || mine.xp === null || mine.xp === undefined) return null;
    const higher = await first('select count(*) as n from (select sum(xp) as s from game_xp_events where at >= ? and (? is null or city_id = ?) group by player_id having sum(xp) > ?)', [since, city, city, num(mine.xp)]);
    return num(higher?.n) + 1;
  }

  async function teamBoard(b: Row): Promise<Row[]> {
    const limit = Math.min(Math.max(Math.floor(num(b.p_limit)) || 1, 1), 100);
    const rows = await all(
      `select team_id, name, xp, members, rank from (
         select t.id as team_id, t.name as name, coalesce(sum(e.xp), 0) as xp, count(distinct m.player_id) as members,
                rank() over (order by coalesce(sum(e.xp), 0) desc) as rank
           from game_teams t join game_team_members m on m.team_id = t.id
           left join game_xp_events e on e.player_id = m.player_id and e.at >= ?
          group by t.id, t.name
       ) order by xp desc, team_id limit ?`,
      [num(b.p_since), limit],
    );
    return rows.map((r) => ({ ...r, xp: num(r.xp), members: num(r.members), rank: num(r.rank) }));
  }

  async function adminOverview(b: Row): Promise<Row> {
    const t = num(b.p_now);
    const n = async (sql: string, v: unknown[] = []): Promise<number> => num((await first(sql, v))?.n);
    const group = async (sql: string): Promise<Row> => Object.fromEntries((await all(sql)).map((r) => [String(r.k), r.v]));
    const claims: Row = {};
    for (const r of await all('select claim_status as k, count(*) as n, sum(amount_usd) as usd from game_prize_claims group by claim_status')) claims[String(r.k)] = { n: num(r.n), usd: num(r.usd) };
    return {
      players: await n('select count(*) as n from game_players'),
      newPlayers7d: await n('select count(*) as n from game_players where created_at >= ?', [t - 7 * 86_400_000]),
      activities24h: await n('select count(*) as n from game_player_activities where created_at >= ?', [t - 86_400_000]),
      activePlayers24h: await n('select count(distinct player_id) as n from game_player_activities where created_at >= ?', [t - 86_400_000]),
      missionsActive: await n("select count(*) as n from game_missions where status = 'active'"),
      treasures: Object.fromEntries(Object.entries(await group('select status as k, count(*) as v from game_treasures group by status')).map(([k, v]) => [k, num(v)])),
      hiddenValueUsd: await n("select sum(c.usd_value) as n from game_treasures t join game_treasure_classes c on c.id = t.class_id where t.status = 'hidden'"),
      pendingVerificationUsd: await n("select sum(c.usd_value) as n from game_player_treasures pt join game_treasures t on t.id = pt.treasure_id join game_treasure_classes c on c.id = t.class_id where pt.verification_status = 'pending'"),
      claims,
      reserveUsd: await n('select sum(amount_usd) as n from game_reserve_entries'),
    };
  }

  // ------------------------------------------------------------------ requests
  return {
    async call(path: string, init: RequestInit = {}): Promise<unknown> {
      const [target, query = ''] = path.split('?');
      const params = new URLSearchParams(query);
      const method = (init.method ?? 'GET').toUpperCase();
      const body: unknown = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : undefined;
      const prefer = String((init.headers as Record<string, string> | undefined)?.prefer ?? '');

      if (target!.startsWith('rpc/')) {
        const b = (body ?? {}) as Row;
        switch (target!.slice(4)) {
          case 'game_award_xp': return awardXp(b);
          case 'game_leaderboard': return leaderboard(b);
          case 'game_player_rank': return playerRank(b);
          case 'game_team_board': return teamBoard(b);
          case 'game_admin_overview': return adminOverview(b);
          default: throw fail(404);
        }
      }

      const table = target!;
      if (!TABLES.has(table)) throw fail(404);

      if (method === 'GET') {
        const w = where(table, params);
        const order = params.get('order');
        const orderSql = order ? ` order by ${order.split(',').map((o) => { const [c, d = 'asc'] = o.split('.'); return `${ident(c!)} ${d === 'desc' ? 'desc' : 'asc'}`; }).join(', ')}` : '';
        const limit = Number(params.get('limit') ?? 0);
        const limitSql = Number.isInteger(limit) && limit > 0 ? ` limit ${Math.min(limit, 10_000)}` : '';
        return (await all(`select ${cols(params)} from ${table}${w.sql}${orderSql}${limitSql}`, w.values)).map((r) => fromDb(table, r));
      }

      if (method === 'POST') {
        const rows = (Array.isArray(body) ? body : [body]) as Row[];
        if (rows.length === 0 || rows.some((r) => !r || typeof r !== 'object')) throw fail(400);
        const returning = prefer.includes('representation');
        const out: Row[] = [];
        for (const row of rows) {
          const keys = Object.keys(row).filter((k) => row[k] !== undefined).map(ident);
          const placeholders = keys.map(() => '?').join(', ');
          const values = keys.map((k) => toDb(table, k, row[k]));
          let verb = 'insert';
          let tail = '';
          const conflict = params.get('on_conflict')?.split(',').map((c) => ident(c.trim()));
          if (prefer.includes('ignore-duplicates')) verb = 'insert or ignore';
          else if (prefer.includes('merge-duplicates') && conflict) {
            const set = keys.filter((k) => !conflict.includes(k)).map((k) => `${k} = excluded.${k}`);
            tail = set.length ? ` on conflict (${conflict.join(', ')}) do update set ${set.join(', ')}` : ` on conflict (${conflict.join(', ')}) do nothing`;
          }
          const sql = keys.length === 0 ? `${verb} into ${table} default values${tail}` : `${verb} into ${table} (${keys.join(', ')}) values (${placeholders})${tail}${returning ? ' returning *' : ''}`;
          const got = await all(returning && keys.length === 0 ? `${sql} returning *` : sql, values);
          if (returning) out.push(...got.map((r) => fromDb(table, r)));
        }
        return returning ? out : null;
      }

      if (method === 'PATCH' || method === 'DELETE') {
        const w = where(table, params);
        if (!w.sql) throw fail(400); // never update or delete a whole table
        const returning = prefer.includes('representation');
        if (method === 'DELETE') {
          await all(`delete from ${table}${w.sql}`, w.values);
          return null;
        }
        const b = (body ?? {}) as Row;
        const keys = Object.keys(b).filter((k) => b[k] !== undefined).map(ident);
        if (keys.length === 0) return returning ? [] : null;
        const sql = `update ${table} set ${keys.map((k) => `${k} = ?`).join(', ')}${w.sql}${returning ? ' returning *' : ''}`;
        const got = await all(sql, [...keys.map((k) => toDb(table, k, b[k])), ...w.values]);
        return returning ? got.map((r) => fromDb(table, r)) : null;
      }

      throw fail(400);
    },
  };
}
