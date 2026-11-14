import { describe, expect, it } from 'vitest';
import { sqliteRest } from './_gameSqlite.js';

type Row = Record<string, unknown>;
const P = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = 1_800_000_000_000;

function db(now = T) {
  const { rest, raw } = sqliteRest(() => now);
  const post = (table: string, body: unknown, prefer = 'return=minimal'): Promise<unknown> => rest.call(table, { method: 'POST', headers: { prefer }, body: JSON.stringify(body) });
  const get = (path: string): Promise<Row[]> => rest.call(path) as Promise<Row[]>;
  const patch = (path: string, body: unknown, prefer = 'return=representation'): Promise<Row[] | null> => rest.call(path, { method: 'PATCH', headers: { prefer }, body: JSON.stringify(body) }) as Promise<Row[] | null>;
  return { rest, raw, post, get, patch };
}

async function players(d: ReturnType<typeof db>, n = 4): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await d.raw.exec(`insert into game_players (id, created_at) values ('${P(i)}', 1); insert into game_player_profiles (player_id, display_name) values ('${P(i)}', '${i === 3 ? '' : 'Player' + i}')`);
  }
}

describe('the D1 schema', () => {
  it('loads on a real SQLite engine and seeds the nine cities and the eight coin classes', async () => {
    const d = db();
    const cities = await d.get('game_cities?select=id,status,bounds,transport&order=sort_order.asc');
    expect(cities.map((c) => c.id)).toEqual(['lagos', 'new-york', 'nairobi', 'hong-kong', 'london', 'dubai', 'paris', 'miami', 'nicosia']);
    expect(cities[0]).toMatchObject({ status: 'active', bounds: [3.0, 6.3, 3.75, 6.75] });
    expect((cities[0]!.transport as string[]).includes('ferry')).toBe(true);
    const classes = await d.get('game_treasure_classes?select=id,usd_value&order=rarity_rank.asc');
    expect(classes.map((c) => [c.id, c.usd_value])).toEqual([['diamond', 1000], ['golden', 587], ['lithium', 212], ['silver', 65], ['cerium', 37], ['samarium', 1], ['thulium', 0.1], ['lutetium', 0.0027]]);
  });

  it('allows one live Diamond Treasure per city, and a new one once the old is withdrawn', async () => {
    const d = db();
    await d.post('game_treasures', { city_id: 'paris', class_id: 'diamond' });
    await expect(d.post('game_treasures', { city_id: 'paris', class_id: 'diamond' })).rejects.toThrow(/409/);
    await d.post('game_treasures', [{ city_id: 'london', class_id: 'diamond' }, { city_id: 'paris', class_id: 'golden' }, { city_id: 'paris', class_id: 'golden' }]);
    await d.patch("game_treasures?city_id=eq.paris&class_id=eq.diamond", { status: 'withdrawn' });
    await d.post('game_treasures', { city_id: 'paris', class_id: 'diamond' });
  });

  it('allows one First Finder per class and city, ever', async () => {
    const d = db();
    await players(d, 2);
    await d.post('game_player_achievements', { player_id: P(1), achievement_id: 'ff-paris-diamond', unlocked_at: 1 });
    await expect(d.post('game_player_achievements', { player_id: P(2), achievement_id: 'ff-paris-diamond', unlocked_at: 2 })).rejects.toThrow(/409/);
    await d.post('game_player_achievements', [{ player_id: P(2), achievement_id: 'first-steps', unlocked_at: 2 }, { player_id: P(1), achievement_id: 'first-steps', unlocked_at: 2 }]);
  });

  it('gives each treasure a v4 UUID and allows one prize claim per treasure', async () => {
    const d = db();
    await players(d, 2);
    const made = (await d.post('game_treasures', { city_id: 'paris', class_id: 'golden' }, 'return=representation')) as Row[];
    expect(String(made[0]!.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(made[0]).toMatchObject({ status: 'hidden', season: 'launch' });
    await d.post('game_prize_claims', { player_id: P(1), treasure_id: made[0]!.id, amount_usd: 587, created_at: 1 });
    await expect(d.post('game_prize_claims', { player_id: P(2), treasure_id: made[0]!.id, amount_usd: 587, created_at: 2 })).rejects.toThrow(/409/);
  });
});

describe('the city photographs', () => {
  it('give every launch city a real, credited, reusable photograph', async () => {
    const d = db();
    const cities = await d.get('game_cities?select=id,image_url,image_credit&order=sort_order.asc');
    expect(cities).toHaveLength(9);
    for (const c of cities) {
      expect(String(c.image_url), String(c.id)).toMatch(/^https:\/\/thumb\.wikimedia\.org\/wikipedia\/commons\/thumb\/.+\.(jpg|jpeg|png)$/i);
      // The credit names the author and a licence that allows reuse with credit, and says where it came from.
      expect(String(c.image_credit), String(c.id)).toMatch(/^Photo: .{2,}, (CC BY(-SA)? \d\.\d|CC0|Public domain), via Wikimedia Commons$/);
      expect(String(c.image_credit)).not.toMatch(/\bN[CD]\b/);
    }
    expect(new Set(cities.map((c) => c.image_url)).size).toBe(9);
  });

  it('are shown by the public catalogue with their credit, and the same file can be run twice', async () => {
    const d = db();
    const { readFileSync } = await import('node:fs');
    d.raw.exec(readFileSync('d1/0002_city_photos.sql', 'utf8'));
    const { parseCity } = await import('../src/game/cities.js');
    const rows = await d.get('game_cities?select=*');
    for (const r of rows) {
      const c = parseCity(r);
      expect(c?.imageUrl, String(r.id)).toBeTruthy();
      expect(c?.imageCredit, String(r.id)).toMatch(/via Wikimedia Commons$/);
    }
  });
});

describe('the data interface', () => {
  it('filters, orders, limits and selects', async () => {
    const d = db();
    await players(d, 3);
    await d.post('game_player_activities', [1, 2, 3, 4, 5].map((i) => ({ player_id: P(1), wallet_address: 'a', network: 'solana', activity_type: i % 2 ? 'login' : 'logout', metadata: { n: i }, created_at: i * 10 })));
    expect((await d.get(`game_player_activities?player_id=eq.${P(1)}&activity_type=eq.login&select=created_at&order=created_at.desc`)).map((r) => r.created_at)).toEqual([50, 30, 10]);
    expect((await d.get('game_player_activities?created_at=gt.20&created_at=lt.50&order=created_at.asc')).map((r) => r.created_at)).toEqual([30, 40]);
    expect((await d.get('game_player_activities?created_at=in.(10,50)&order=created_at.asc')).length).toBe(2);
    expect((await d.get('game_player_activities?order=created_at.desc&limit=2')).length).toBe(2);
    expect((await d.get('game_player_activities?created_at=gte.40&created_at=lte.40'))[0]).toMatchObject({ created_at: 40, metadata: { n: 4 } }); // JSON comes back as an object
    expect(await d.get('game_player_activities?id=in.()')).toEqual([]);
    expect((await d.get('game_player_profiles?select=player_id,display_name&order=player_id.asc'))[0]).toEqual({ player_id: P(1), display_name: 'Player1' });
  });

  it('turns true and false into 0 and 1 and back, and matches is.null', async () => {
    const d = db();
    await players(d, 1);
    await d.post('game_missions', { id: 'm-test', city_id: 'paris', title: 't', difficulty: 'beginner' });
    await d.post('game_attempts', [{ player_id: P(1), mission_id: 'm-test', seq: 1, correct: false, at: 5 }, { player_id: P(1), mission_id: 'm-test', seq: 1, correct: true, at: 6 }]);
    expect((await d.get('game_attempts?correct=eq.false&select=at')).map((r) => r.at)).toEqual([5]);
    expect((await d.get('game_attempts?correct=eq.true'))[0]).toMatchObject({ correct: true });
    await d.post('auth_nonces', { nonce: 'ab'.repeat(16), created_at: 1, expires_at: 100 });
    expect((await d.get('auth_nonces?used_at=is.null')).length).toBe(1);
    const used = await d.patch('auth_nonces?nonce=eq.' + 'ab'.repeat(16) + '&used_at=is.null&expires_at=gt.50', { used_at: 60, owner: 'solana:x' });
    expect(used).toHaveLength(1);
    expect(await d.patch('auth_nonces?nonce=eq.' + 'ab'.repeat(16) + '&used_at=is.null&expires_at=gt.50', { used_at: 70, owner: 'solana:y' })).toEqual([]); // single use
  });

  it('inserts, ignores or merges duplicates, and says 409 for a plain duplicate', async () => {
    const d = db();
    await players(d, 1);
    await d.post('account_sessions?on_conflict=owner', { owner: 'game:solana:x', version: 1, updated_at: 1 }, 'resolution=merge-duplicates,return=minimal');
    await d.post('account_sessions?on_conflict=owner', { owner: 'game:solana:x', version: 2, updated_at: 2 }, 'resolution=merge-duplicates,return=minimal');
    expect(await d.get('account_sessions?owner=eq.game:solana:x')).toEqual([{ owner: 'game:solana:x', version: 2, updated_at: 2 }]);
    const first = await d.post('game_player_cities?on_conflict=player_id,city_id', { player_id: P(1), city_id: 'paris', first_visit_at: 1, last_visit_at: 1 }, 'resolution=ignore-duplicates,return=representation');
    const again = await d.post('game_player_cities?on_conflict=player_id,city_id', { player_id: P(1), city_id: 'paris', first_visit_at: 9, last_visit_at: 9 }, 'resolution=ignore-duplicates,return=representation');
    expect(first as Row[]).toHaveLength(1);
    expect(again as Row[]).toHaveLength(0);
    expect((await d.get('game_player_cities'))[0]).toMatchObject({ first_visit_at: 1 });
    await expect(d.post('game_player_wallets', [{ player_id: P(1), network: 'evm', address_norm: '0xabc', verified_at: 1 }, { player_id: P(1), network: 'evm', address_norm: '0xabc', verified_at: 2 }])).rejects.toThrow(/409/);
  });

  it('refuses a bad table, bad column, malformed filter, and an update or delete with no filter', async () => {
    const d = db();
    await expect(d.get('sqlite_master')).rejects.toThrow(/404/);
    await expect(d.get('game_cities?id;drop=eq.x')).rejects.toThrow(/400/);
    await expect(d.get("game_cities?select=id,(select 1)")).rejects.toThrow(/400/);
    await expect(d.get('game_cities?id=zz.x')).rejects.toThrow(/400/);
    await expect(d.get('game_cities?id=nodot')).rejects.toThrow(/400/);
    await expect(d.patch('game_cities', { status: 'inactive' })).rejects.toThrow(/400/);
    await expect(d.rest.call('game_cities', { method: 'DELETE' })).rejects.toThrow(/400/);
    await expect(d.rest.call('rpc/nope', { method: 'POST', body: '{}' })).rejects.toThrow(/404/);
    expect((await d.get('game_cities')).length).toBe(9);
  });

  it('treats a value that looks like SQL as plain text', async () => {
    const d = db();
    expect(await d.get("game_cities?id=eq.paris' or '1'='1")).toEqual([]);
    expect(await d.get("game_cities?id=in.(paris,x'); drop table game_cities;--)")).toHaveLength(1);
    expect((await d.get('game_cities')).length).toBe(9);
  });

  it('keeps references honest: a player row needs its parent, a bad value is refused', async () => {
    const d = db();
    await expect(d.post('game_player_profiles', { player_id: P(99) })).rejects.toThrow(/400/);
    await expect(d.post('game_missions', { id: 'm-bad', city_id: 'paris', title: 't', difficulty: 'easy' })).rejects.toThrow(/400/);
  });
});

describe('XP, boards and teams', () => {
  async function seeded() {
    const d = db();
    await players(d, 4);
    for (const [p, city] of [[1, 'paris'], [1, 'london'], [2, 'paris'], [3, 'paris']] as const) await d.raw.exec(`insert into game_player_cities (player_id, city_id, first_visit_at, last_visit_at) values ('${P(p)}', '${city}', 1, 1)`);
    const award = (p: number, city: string | null, xp: number, disc = 0, missions = 0) => d.rest.call('rpc/game_award_xp', { method: 'POST', body: JSON.stringify({ p_player: P(p), p_city: city, p_xp: xp, p_discoveries: disc, p_missions: missions }) });
    await award(1, 'paris', 150, 0, 1);
    await award(1, 'london', 50, 1, 0);
    await award(2, 'paris', 300);
    await award(3, 'paris', 300);
    await award(4, null, 20);
    const rpc = <R,>(name: string, body: Row): Promise<R> => d.rest.call(`rpc/${name}`, { method: 'POST', body: JSON.stringify(body) }) as Promise<R>;
    return { d, award, rpc };
  }

  it('adds to the profile, the city and the ledger together, and sets the level', async () => {
    const { d } = await seeded();
    expect((await d.get(`game_player_profiles?player_id=eq.${P(1)}`))[0]).toMatchObject({ total_xp: 200, total_discoveries: 1, missions_completed: 1, explorer_level: 2 });
    expect((await d.get(`game_player_cities?player_id=eq.${P(1)}&order=city_id.asc`)).map((r) => [r.city_id, r.city_xp])).toEqual([['london', 50], ['paris', 150]]);
    const ledger = await d.get(`game_xp_events?player_id=eq.${P(1)}`);
    expect(ledger.reduce((n, r) => n + Number(r.xp), 0)).toBe(200);
    expect((await d.get('game_xp_events')).length).toBe(5);
    expect((await d.get('game_xp_events'))[0]).toMatchObject({ at: T });
  });

  it('ranks globally with ties sharing a rank, and shows names, never a wallet', async () => {
    const { rpc } = await seeded();
    const rows = await rpc<Row[]>('game_leaderboard', { p_city: null, p_since: 0, p_limit: 50 });
    expect(rows.map((r) => [r.display_name, r.xp, r.rank])).toEqual([['Player2', 300, 1], ['Explorer 0000', 300, 1], ['Player1', 200, 3], ['Player4', 20, 4]]);
    expect(Object.keys(rows[0]!).sort()).toEqual(['display_name', 'player_id', 'rank', 'xp']);
  });

  it('ranks per city, counts only a window, and caps the length', async () => {
    const { d, rpc } = await seeded();
    expect((await rpc<Row[]>('game_leaderboard', { p_city: 'london', p_since: 0, p_limit: 50 })).map((r) => [r.display_name, r.xp])).toEqual([['Player1', 50]]);
    await d.raw.exec(`insert into game_xp_events (player_id, city_id, xp, at) values ('${P(4)}', 'paris', 1000, 10)`);
    const xpOf = async (since: number): Promise<number> => Number((await rpc<Row[]>('game_leaderboard', { p_city: null, p_since: since, p_limit: 50 })).find((r) => r.display_name === 'Player4')!.xp);
    expect(await xpOf(0)).toBe(1020);
    expect(await xpOf(11)).toBe(20);
    expect((await rpc<Row[]>('game_leaderboard', { p_city: null, p_since: 0, p_limit: 1 })).length).toBe(1);
    expect((await rpc<Row[]>('game_leaderboard', { p_city: null, p_since: 0, p_limit: 100000 })).length).toBeLessThanOrEqual(100);
  });

  it('gives a player their rank, and null when they have no XP in the window', async () => {
    const { rpc } = await seeded();
    expect(await rpc('game_player_rank', { p_player: P(1), p_city: null, p_since: 0 })).toBe(3);
    expect(await rpc('game_player_rank', { p_player: P(2), p_city: null, p_since: 0 })).toBe(1);
    expect(await rpc('game_player_rank', { p_player: P(2), p_city: 'london', p_since: 0 })).toBeNull();
    expect(await rpc('game_player_rank', { p_player: P(1), p_city: null, p_since: 9_000_000_000_000_000 })).toBeNull();
  });

  it('scores a team by its members XP and allows one team per player and unique names', async () => {
    const { d, rpc } = await seeded();
    await d.post('game_teams', [{ id: P(101), name: 'Night Owls', join_code: 'AAAAAAAA', created_by: P(1), created_at: 1 }, { id: P(102), name: 'Early Birds', join_code: 'BBBBBBBB', created_by: P(2), created_at: 1 }]);
    await d.post('game_team_members', [{ team_id: P(101), player_id: P(1), role: 'owner', joined_at: 1 }, { team_id: P(101), player_id: P(3), joined_at: 2 }, { team_id: P(102), player_id: P(2), role: 'owner', joined_at: 1 }]);
    const rows = await rpc<Row[]>('game_team_board', { p_since: 0, p_limit: 10 });
    expect(rows.map((r) => [r.name, r.xp, r.members, r.rank])).toEqual([['Night Owls', 500, 2, 1], ['Early Birds', 300, 1, 2]]);
    await expect(d.post('game_team_members', { team_id: P(102), player_id: P(1), joined_at: 3 })).rejects.toThrow(/409/);
    await expect(d.post('game_teams', { name: 'night owls', join_code: 'CCCCCCCC', created_by: P(4), created_at: 1 })).rejects.toThrow(/409/);
  });

  it('adds up players, hidden and waiting value, claims and the reserve for the administrator', async () => {
    const { d, rpc } = await seeded();
    await d.post('game_reserve_entries', [{ amount_usd: 9000, admin: 'evm:0xadmin', at: 1 }, { amount_usd: -1000, admin: 'evm:0xadmin', at: 2 }]);
    await d.post('game_treasures', [{ id: P(301), city_id: 'dubai', class_id: 'golden', status: 'found' }, { id: P(302), city_id: 'miami', class_id: 'silver' }]);
    await d.post('game_player_treasures', { player_id: P(1), treasure_id: P(301), discovery_status: 'discovered', verification_status: 'pending', unlocked_at: 1 });
    await d.post('game_prize_claims', { player_id: P(1), treasure_id: P(301), amount_usd: 587, created_at: 5 });
    const o = await rpc<Row>('game_admin_overview', { p_now: 1000 });
    expect(o).toMatchObject({ players: 4, reserveUsd: 8000, pendingVerificationUsd: 587, hiddenValueUsd: 65, claims: { pending: { n: 1, usd: 587 } }, treasures: { found: 1, hidden: 1 } });
  });
});

describe('the tutorial mission', () => {
  it('loads into the schema and its answers check out', async () => {
    const tool = await import('../scripts/game-answers.ts');
    const d = db();
    const ids: [string, string] = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'];
    d.raw.exec(tool.tutorialSql('s3cret', ids));
    d.raw.exec(tool.tutorialSql('s3cret', ids)); // safe to run twice
    const clues = await d.get('game_clues?mission_id=eq.paris-first-steps&order=seq.asc');
    expect(clues).toHaveLength(2);
    expect(clues[0]!.hints).toEqual(['Think of a spiral, starting at the Louvre.', 'It is more than fifteen and fewer than twenty-five.']);
    expect(clues[1]!.answer_hash).toBe(tool.hashAnswer('s3cret', ids[1], 'seine'));
    expect((await d.get('game_missions?id=eq.paris-first-steps'))[0]).toMatchObject({ status: 'active', city_id: 'paris' });
  });
});
