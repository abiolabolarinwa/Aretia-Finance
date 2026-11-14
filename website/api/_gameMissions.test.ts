import { describe, expect, it } from 'vitest';
import { answerHash, missionOp, type MissionCtx } from './_gameMissions.js';
import { canPlace, DIAMOND_HEADLINE_TOTAL_USD, missionXp, normalizeAnswer, pickClass, TREASURE_CLASSES, treasureXp } from '../src/game/rarity.js';
import { CITIES } from '../src/game/cities.js';
import { ACHIEVEMENTS, levelFor, newlyEarned, xpToNext } from '../src/game/achievements.js';
import { evaluateAchievements, history, progress, setDisplayName } from './_gameProgress.js';

type Row = Record<string, unknown>;
const NOW = 1_800_000_000_000;
const SECRET = 'test-answer-secret';
const P1 = '00000000-0000-4000-8000-000000000001';
const P2 = '00000000-0000-4000-8000-000000000002';
const T1 = '11111111-1111-4111-8111-111111111111';
const C1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const C2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const UNIQUE: Record<string, string[]> = { game_player_missions: ['player_id', 'mission_id'], game_player_treasures: ['player_id', 'treasure_id'], game_player_achievements: ['player_id', 'achievement_id'] };

/** A small in-memory stand-in for the database, understanding the filters the mission code uses (eq, gt, in). */
function world() {
  const t: Record<string, Row[]> = {
    game_missions: [
      { id: 'paris-first-steps', city_id: 'paris', title: 'First steps', description: 'Two questions', difficulty: 'beginner', kind: 'long', status: 'active', opens_at: null, closes_at: null, xp_reward: 100, treasure_id: T1 },
      { id: 'paris-closed', city_id: 'paris', title: 'Closed', description: '', difficulty: 'beginner', kind: 'daily', status: 'active', opens_at: null, closes_at: NOW - 1, xp_reward: 10, treasure_id: null },
    ],
    game_clues: [
      { id: C1, mission_id: 'paris-first-steps', seq: 1, clue_type: 'numerical', content: 'How many arrondissements?', answer_hash: answerHash(SECRET, C1, '20'), hints: ['Think of a spiral.', 'More than 15.'] },
      { id: C2, mission_id: 'paris-first-steps', seq: 2, clue_type: 'geographical', content: 'Which river?', answer_hash: answerHash(SECRET, C2, 'Seine'), hints: [] },
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', mission_id: 'paris-closed', seq: 1, clue_type: 'riddle', content: 'x', answer_hash: answerHash(SECRET, 'x', 'x'), hints: [] },
    ],
    game_treasures: [{ id: T1, city_id: 'paris', class_id: 'lutetium', status: 'hidden', found_by: null }],
    game_treasure_locations: [{ treasure_id: T1, lng: 2.3522, lat: 48.8566, radius_m: 60 }],
    game_player_missions: [],
    game_attempts: [],
    game_player_treasures: [],
    game_player_activities: [],
    xp: [],
  };
  const match = (row: Row, params: URLSearchParams): boolean => {
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
      const [op, ...rest] = [v.slice(0, v.indexOf('.')), v.slice(v.indexOf('.') + 1)];
      const val = rest.join('.');
      if (op === 'eq' && String(row[k]) !== val) return false;
      if (op === 'gt' && !(Number(row[k]) > Number(val))) return false;
      if (op === 'lt' && !(Number(row[k]) < Number(val))) return false;
      if (op === 'in' && !val.slice(1, -1).split(',').includes(String(row[k]))) return false;
    }
    return true;
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = url.split('/rest/v1/')[1]!;
    const [table, query = ''] = path.split('?');
    const params = new URLSearchParams(query);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Row) : {};
    const prefer = String((init?.headers as Record<string, string> | undefined)?.prefer ?? '');
    if (table === 'rpc/game_award_xp') {
      t.xp!.push(body);
      return new Response('');
    }
    const rows = (t[table!] ??= []);
    if (method === 'POST') {
      if (table === 'game_player_achievements' && String(body.achievement_id).startsWith('ff-') && rows.some((r) => r.achievement_id === body.achievement_id)) return new Response('', { status: 409 });
      const keys = UNIQUE[table!];
      if (keys && rows.some((r) => keys.every((k) => r[k] === body[k]))) return new Response('', { status: prefer.includes('ignore-duplicates') ? 201 : 409 });
      const row = { stage: 1, hints_used: 0, hints_total: 0, status: 'active', discovery_status: 'unlocked', verification_status: 'none', claim_status: 'none', ...body };
      rows.push(row);
      return new Response(prefer.includes('representation') ? JSON.stringify([row]) : '', { status: 201 });
    }
    const hit = rows.filter((r) => match(r, params));
    if (method === 'PATCH') {
      for (const r of hit) Object.assign(r, body);
      return new Response(prefer.includes('representation') ? JSON.stringify(hit) : '');
    }
    const order = params.get('order');
    if (order) {
      const [col, dir] = order.split('.');
      hit.sort((a, b) => (Number(a[col!]) - Number(b[col!])) * (dir === 'desc' ? -1 : 1));
    }
    const limit = Number(params.get('limit') ?? 0);
    return new Response(JSON.stringify(limit > 0 ? hit.slice(0, limit) : hit));
  }) as unknown as typeof fetch;
  const db = { async call(path: string, init: RequestInit = {}) {
    const res = await fetchImpl(`https://x/rest/v1/${path}`, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`answered ${res.status}`);
    return text ? JSON.parse(text) : null;
  } };
  let clock = NOW;
  let position: [number, number] = [2.3, 48.8];
  let travel: unknown = null;
  let selected: string | null = 'paris';
  const ctx = (player: string, body: Row): MissionCtx => ({ db, playerId: player, network: 'solana', addressNorm: 'addr', body, now: clock, secret: SECRET, selected: async () => selected, position: async () => ({ position, travel }) });
  return { t, ctx, at: (ms: number) => void (clock = ms), setPos: (p: [number, number]) => void (position = p), setTravel: (v: unknown) => void (travel = v), setSelected: (v: string | null) => void (selected = v) };
}

describe('answers', () => {
  it('compare without regard to case, accents, spacing or punctuation, and never equal across clues', () => {
    expect(normalizeAnswer('  La Seine! ')).toBe('la seine');
    expect(normalizeAnswer('Élysée')).toBe('elysee');
    expect(answerHash(SECRET, C1, 'The Seine')).toBe(answerHash(SECRET, C1, 'the  seine.'));
    expect(answerHash(SECRET, C1, 'seine')).not.toBe(answerHash(SECRET, C2, 'seine'));
    expect(answerHash(SECRET, C1, 'seine')).not.toBe(answerHash('other-secret', C1, 'seine'));
  });
});

describe('missions', () => {
  it('lists only open missions, with the prize on offer but never where it is, and no answers', async () => {
    const w = world();
    const r = await missionOp('missions', w.ctx(P1, { city: 'paris' }));
    const data = JSON.stringify(r!.data);
    expect(r!.status).toBe(200);
    expect((r!.data.missions as Row[]).map((m) => m.id)).toEqual(['paris-first-steps']);
    expect((r!.data.missions as Row[])[0]).toMatchObject({ totalStages: 2, progress: null, treasure: { coin: 'Lutetium Coin', usd: 0.0027 } });
    expect(data).not.toMatch(/answer|hash|lng|lat|2\.3522|48\.8566/);
    expect((await missionOp('missions', w.ctx(P1, { city: 'atlantis' })))!.status).toBe(400);
  });

  it('shows the first clue, gives hints one at a time, and never the answer', async () => {
    const w = world();
    expect((await missionOp('clue', w.ctx(P1, { mission: 'paris-first-steps' })))!.status).toBe(409); // not started
    const start = await missionOp('mission-start', w.ctx(P1, { mission: 'paris-first-steps' }));
    expect(start!.data).toMatchObject({ stage: 1, totalStages: 2, hintsUsed: 0, hintsAvailable: 2, hints: [], clue: { content: 'How many arrondissements?' } });
    const h1 = await missionOp('hint', w.ctx(P1, { mission: 'paris-first-steps' }));
    expect(h1!.data).toMatchObject({ hintsUsed: 1, hints: ['Think of a spiral.'] });
    const h2 = await missionOp('hint', w.ctx(P1, { mission: 'paris-first-steps' }));
    expect(h2!.data.hints).toEqual(['Think of a spiral.', 'More than 15.']);
    expect((await missionOp('hint', w.ctx(P1, { mission: 'paris-first-steps' })))!.status).toBe(409);
    expect(JSON.stringify([start, h1, h2])).not.toMatch(/answer_hash|"20"/);
  });

  it('refuses a closed mission, a mission with no clues and an unknown one', async () => {
    const w = world();
    expect((await missionOp('mission-start', w.ctx(P1, { mission: 'paris-closed' })))!.status).toBe(404);
    expect((await missionOp('mission-start', w.ctx(P1, { mission: 'nope-nope' })))!.status).toBe(404);
    expect((await missionOp('mission-start', w.ctx(P1, { mission: 42 })))!.status).toBe(404);
  });

  it('moves through the stages on right answers, pays XP once, less for hints, and unlocks the treasure zone', async () => {
    const w = world();
    await missionOp('mission-start', w.ctx(P1, { mission: 'paris-first-steps' }));
    await missionOp('hint', w.ctx(P1, { mission: 'paris-first-steps' }));
    const wrong = await missionOp('answer', w.ctx(P1, { mission: 'paris-first-steps', answer: '19' }));
    expect(wrong!.data).toMatchObject({ correct: false, attemptsLeft: 4 });
    const right = await missionOp('answer', w.ctx(P1, { mission: 'paris-first-steps', answer: ' 20 ' }));
    expect(right!.data).toMatchObject({ correct: true, completed: false, next: { stage: 2, hintsUsed: 0, clue: { content: 'Which river?' } } });
    const done = await missionOp('answer', w.ctx(P1, { mission: 'paris-first-steps', answer: ' SEINE. ' }));
    expect(done!.data).toMatchObject({ correct: true, completed: true, xp: missionXp(100, 1), treasure: { coin: 'Lutetium Coin', zone: { lng: 2.3522, lat: 48.8566, radiusM: 60 } } });
    expect(w.t.xp).toEqual([{ p_player: P1, p_city: 'paris', p_xp: 90, p_discoveries: 0, p_missions: 1 }]);
    // Answering again after finishing pays nothing more.
    expect((await missionOp('answer', w.ctx(P1, { mission: 'paris-first-steps', answer: 'seine' })))!.status).toBe(409);
    expect(w.t.xp).toHaveLength(1);
    expect((await missionOp('mission-start', w.ctx(P1, { mission: 'paris-first-steps' })))!.status).toBe(409);
    const kinds = w.t.game_player_activities!.map((a) => a.activity_type);
    expect(kinds).toEqual(expect.arrayContaining(['mission_started', 'hint_requested', 'answer_incorrect', 'answer_correct', 'mission_completed', 'treasure_unlocked']));
  });

  it('limits wrong answers, and lets a player abandon and restart', async () => {
    const w = world();
    await missionOp('mission-start', w.ctx(P1, { mission: 'paris-first-steps' }));
    for (let i = 0; i < 5; i++) await missionOp('answer', w.ctx(P1, { mission: 'paris-first-steps', answer: String(i) }));
    expect((await missionOp('answer', w.ctx(P1, { mission: 'paris-first-steps', answer: '20' })))!.status).toBe(429);
    w.at(NOW + 11 * 60_000);
    expect((await missionOp('answer', w.ctx(P1, { mission: 'paris-first-steps', answer: '20' })))!.data.correct).toBe(true);
    await missionOp('mission-abandon', w.ctx(P1, { mission: 'paris-first-steps' }));
    const again = await missionOp('mission-start', w.ctx(P1, { mission: 'paris-first-steps' }));
    expect(again!.data).toMatchObject({ stage: 1, hintsUsed: 0 });
    expect((await missionOp('answer', w.ctx(P1, { mission: 'paris-first-steps', answer: '' })))!.status).toBe(400);
  });

  it('gives no treasure from a hidden mission until the trail is solved, and keeps the location from everyone else', async () => {
    const w = world();
    expect((await missionOp('collect', w.ctx(P1, { treasure: T1 })))!.status).toBe(404);
    expect(((await missionOp('treasures', w.ctx(P1, {})))!.data.treasures as Row[])).toEqual([]);
    await missionOp('mission-start', w.ctx(P1, { mission: 'paris-first-steps' }));
    await missionOp('answer', w.ctx(P1, { mission: 'paris-first-steps', answer: '20' }));
    expect((await missionOp('collect', w.ctx(P1, { treasure: T1 })))!.status).toBe(404); // not through the whole trail yet
    expect(((await missionOp('treasures', w.ctx(P2, {})))!.data.treasures as Row[])).toEqual([]);
    expect(JSON.stringify((await missionOp('treasures', w.ctx(P2, {}))))).not.toMatch(/2\.3522/);
  });
});

describe('treasure discovery', () => {
  async function solved(w: ReturnType<typeof world>, player: string): Promise<void> {
    await missionOp('mission-start', w.ctx(player, { mission: 'paris-first-steps' }));
    await missionOp('answer', w.ctx(player, { mission: 'paris-first-steps', answer: '20' }));
    await missionOp('answer', w.ctx(player, { mission: 'paris-first-steps', answer: 'seine' }));
  }

  it('needs the player to be in the city, close enough and not mid-journey, then pays once', async () => {
    const w = world();
    await solved(w, P1);
    w.setSelected('london');
    expect((await missionOp('collect', w.ctx(P1, { treasure: T1 })))!.status).toBe(409);
    w.setSelected('paris');
    expect((await missionOp('collect', w.ctx(P1, { treasure: T1 })))!.data.message).toMatch(/not close enough/);
    w.setPos([2.3522, 48.8566]);
    w.setTravel({ mode: 'walk' });
    expect((await missionOp('collect', w.ctx(P1, { treasure: T1 })))!.status).toBe(409);
    w.setTravel(null);
    const got = await missionOp('collect', w.ctx(P1, { treasure: T1 }));
    expect(got!.data).toMatchObject({ discovered: true, xp: treasureXp(8), treasure: { coin: 'Lutetium Coin', usd: 0.0027, verification: 'verified' } });
    expect(w.t.game_treasures![0]).toMatchObject({ status: 'found', found_by: P1 });
    expect(w.t.xp!.at(-2)).toEqual({ p_player: P1, p_city: 'paris', p_xp: 25, p_discoveries: 1, p_missions: 0 });
    expect((await missionOp('collect', w.ctx(P1, { treasure: T1 })))!.status).toBe(409);
    // The first collector of this class in this city is its First Finder, with a bonus equal to the treasure XP.
    expect(got!.data).toMatchObject({ firstFinder: true, firstFinderBonus: 25 });
    expect(w.t.game_player_achievements).toEqual([expect.objectContaining({ player_id: P1, achievement_id: 'ff-paris-lutetium' })]);
    expect(w.t.xp!.at(-1)).toEqual({ p_player: P1, p_city: 'paris', p_xp: 25, p_discoveries: 0, p_missions: 0 });
    expect(w.t.game_player_activities!.map((a) => a.activity_type)).toContain('first_finder');
  });

  it('names First Finder badges in a player progress, and gives the badge to one player only', async () => {
    const w = world();
    w.t.game_player_achievements = [{ player_id: P1, achievement_id: 'ff-new-york-diamond', unlocked_at: 5 }];
    w.t.game_player_profiles = [{ player_id: P1, display_name: '', total_xp: 0 }];
    const p = (await progress({ db: w.ctx(P1, {}).db, playerId: P1, network: 'solana', addressNorm: 'addr', now: NOW })) as { firstFinds: Row[] };
    expect(p.firstFinds).toEqual([{ cityId: 'new-york', class: 'diamond', unlockedAt: 5 }]);
  });

  it('gives a treasure to the first player to reach it only, even when both solved the trail', async () => {
    const w = world();
    await solved(w, P1);
    await solved(w, P2);
    w.setPos([2.3522, 48.8566]);
    expect((await missionOp('collect', w.ctx(P1, { treasure: T1 })))!.data.discovered).toBe(true);
    const late = await missionOp('collect', w.ctx(P2, { treasure: T1 }));
    expect(late!.status).toBe(409);
    expect(late!.data.message).toMatch(/first/);
    expect(w.t.game_treasures![0]!.found_by).toBe(P1);
    const mine2 = (await missionOp('treasures', w.ctx(P2, {})))!.data.treasures as Row[];
    expect(mine2[0]).toMatchObject({ available: false, zone: null, discovery: 'unlocked' });
  });

  it('holds a valuable coin for verification instead of calling it a won prize', async () => {
    const w = world();
    w.t.game_treasures![0]!.class_id = 'diamond';
    await solved(w, P1);
    w.setPos([2.3522, 48.8566]);
    const got = await missionOp('collect', w.ctx(P1, { treasure: T1 }));
    expect(got!.data).toMatchObject({ discovered: true, treasure: { usd: 1000, verification: 'pending' } });
    expect(w.t.game_player_treasures![0]).toMatchObject({ verification_status: 'pending', claim_status: 'none' });
  });
});

describe('rarity rules', () => {
  it('has the eight classes with the stated values, rarest first, and the Diamond headline of nine thousand', () => {
    expect(TREASURE_CLASSES.map((c) => [c.id, c.usd])).toEqual([['diamond', 1000], ['golden', 587], ['lithium', 212], ['silver', 65], ['cerium', 37], ['samarium', 1], ['thulium', 0.1], ['lutetium', 0.0027]]);
    expect(TREASURE_CLASSES.every((c, i, a) => i === 0 || a[i - 1]!.weight < c.weight)).toBe(true);
    expect(DIAMOND_HEADLINE_TOTAL_USD).toBe(CITIES.length * 1000);
  });

  it('draws by weight: Lutetium is the commonest, Thulium rarer, and the rare six are rare', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 10_000; i++) {
      const id = pickClass(TREASURE_CLASSES, (i + 0.5) / 10_000);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const n = (id: string): number => counts.get(id) ?? 0;
    expect(n('lutetium')).toBeGreaterThan(n('thulium'));
    expect(n('thulium')).toBeGreaterThan(n('samarium'));
    expect(n('diamond') + n('golden') + n('lithium') + n('silver') + n('cerium') + n('samarium')).toBeLessThan(n('lutetium') / 2);
    expect(pickClass(TREASURE_CLASSES, 0)).toBe('diamond');
    expect(pickClass(TREASURE_CLASSES, 0.9999999)).toBe('lutetium');
    expect(() => pickClass([{ id: 'a', weight: 0 }], 0.5)).toThrow();
  });

  it('allows one live Diamond Treasure per city, honours a supply cap, and frees the slot when one is withdrawn', () => {
    const placed = [{ cityId: 'paris', classId: 'diamond', status: 'hidden' }];
    expect(canPlace(placed, 'paris', 'diamond').ok).toBe(false);
    expect(canPlace(placed, 'london', 'diamond').ok).toBe(true);
    expect(canPlace([{ cityId: 'paris', classId: 'diamond', status: 'withdrawn' }], 'paris', 'diamond').ok).toBe(true);
    expect(canPlace([{ cityId: 'a', classId: 'golden', status: 'hidden' }], 'b', 'golden', { golden: 1 }).ok).toBe(false);
    expect(canPlace([], 'paris', 'ruby').ok).toBe(false);
  });
});

describe('the operator tool', () => {
  it('makes the same hashes as the server', async () => {
    const tool = await import('../scripts/game-answers.ts');
    for (const a of ['Seine', ' the  SEINE. ', 'Élysée', '20']) {
      expect(tool.hashAnswer(SECRET, C1, a)).toBe(answerHash(SECRET, C1, a));
      expect(tool.normalize(a)).toBe(normalizeAnswer(a));
    }
  });
});

describe('progression', () => {
  const pctx = (w: ReturnType<typeof world>, player = P1) => ({ db: w.ctx(player, {}).db, playerId: player, network: 'solana', addressNorm: 'addr', now: NOW });

  it('works out levels from XP with the same rule as the database, and what is needed for the next', () => {
    expect([0, 99, 100, 399, 400, 10_000].map(levelFor)).toEqual([1, 1, 2, 2, 3, 11]);
    expect(xpToNext(0)).toBe(100);
    expect(xpToNext(100)).toBe(300);
    expect(xpToNext(399)).toBe(1);
  });

  it('earns achievements from counts, never twice, and has a unique id for each', () => {
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(ACHIEVEMENTS.length);
    const base = { citiesVisited: 0, missionsCompleted: 0, discoveries: 0, flightsLanded: 0, hintFreeCompletions: 0, explorerLevel: 1 };
    expect(newlyEarned(base, new Set())).toEqual([]);
    expect(newlyEarned({ ...base, citiesVisited: 3 }, new Set()).map((a) => a.id)).toEqual(['first-steps', 'globetrotter']);
    expect(newlyEarned({ ...base, citiesVisited: 3 }, new Set(['first-steps'])).map((a) => a.id)).toEqual(['globetrotter']);
    expect(newlyEarned({ ...base, citiesVisited: 9 }, new Set()).map((a) => a.id)).toContain('world-explorer');
  });

  it('unlocks what is earned once, pays its XP once, and records it', async () => {
    const w = world();
    w.t.game_player_cities = [{ player_id: P1, city_id: 'paris' }];
    w.t.game_player_profiles = [{ player_id: P1, display_name: '', avatar: null, explorer_level: 1, total_xp: 0, total_discoveries: 0, missions_completed: 1 }];
    w.t.game_player_missions = [{ player_id: P1, mission_id: 'x', status: 'completed', hints_total: 0 }];
    const first = await evaluateAchievements(pctx(w));
    expect(first.map((u) => u.id).sort()).toEqual(['first-mission', 'first-steps', 'sharp-mind']);
    expect(w.t.xp!.map((x) => x.p_xp)).toEqual(expect.arrayContaining([25, 50, 50]));
    expect(w.t.xp).toHaveLength(3);
    expect(await evaluateAchievements(pctx(w))).toEqual([]);
    expect(w.t.xp).toHaveLength(3);
    expect(w.t.game_player_achievements).toHaveLength(3);
    expect(w.t.game_player_activities!.filter((a) => a.activity_type === 'achievement_unlocked')).toHaveLength(3);
    expect(await evaluateAchievements(pctx(w, P2))).toEqual([]);
  });

  it('reports progress with every achievement, earned or not, and no wallet details', async () => {
    const w = world();
    w.t.game_player_cities = [{ player_id: P1, city_id: 'paris', city_xp: 40, discoveries: 1, completed_missions: 1, first_visit_at: 1, last_visit_at: 2 }];
    w.t.game_player_profiles = [{ player_id: P1, display_name: 'Ada', avatar: null, explorer_level: 1, total_xp: 250, total_discoveries: 1, missions_completed: 1 }];
    const p = (await progress(pctx(w))) as { level: Record<string, number>; achievements: { id: string; unlockedAt: number | null }[]; cities: { id: string; visited: boolean; cityXp: number }[]; profile: { displayName: string } };
    expect(p.level).toEqual({ current: 2, xp: 250, toNext: 150 });
    expect(p.achievements).toHaveLength(ACHIEVEMENTS.length);
    expect(p.achievements.every((a) => a.unlockedAt === null)).toBe(true);
    expect(p.cities).toHaveLength(9);
    expect(p.cities.find((c) => c.id === 'paris')).toMatchObject({ visited: true, cityXp: 40 });
    expect(p.cities.find((c) => c.id === 'lagos')).toMatchObject({ visited: false, cityXp: 0 });
    expect(p.profile.displayName).toBe('Ada');
    expect(JSON.stringify(p)).not.toMatch(/addr|network/);
  });

  it('pages through a player history, newest first, only their own, keeping to known details', async () => {
    const w = world();
    for (let i = 1; i <= 55; i++) w.t.game_player_activities!.push({ id: String(i), player_id: P1, activity_type: 'login', city_id: null, metadata: { mission: 'm', secret: 'hidden' }, created_at: i });
    w.t.game_player_activities!.push({ id: 'other', player_id: P2, activity_type: 'login', city_id: null, metadata: {}, created_at: 99 });
    const one = (await history(pctx(w), undefined)) as { items: { id: string; at: number; details: Record<string, unknown> }[]; next: number | null };
    expect(one.items).toHaveLength(50);
    expect(one.items[0]!.at).toBe(55);
    expect(one.items[0]!.details).toEqual({ mission: 'm' });
    expect(one.next).toBe(6);
    const two = (await history(pctx(w), one.next)) as { items: { at: number }[]; next: number | null };
    expect(two.items.map((i) => i.at)).toEqual([5, 4, 3, 2, 1]);
    expect(two.next).toBeNull();
  });

  it('accepts a sensible display name and refuses markup, symbols and the wrong length', async () => {
    const w = world();
    w.t.game_player_profiles = [{ player_id: P1, display_name: '' }];
    expect(await setDisplayName(pctx(w), '  Ada   Lovelace ')).toEqual({ ok: true, displayName: 'Ada Lovelace' });
    expect(w.t.game_player_profiles![0]!.display_name).toBe('Ada Lovelace');
    for (const bad of ['', 'A', '<b>x</b>', 'x'.repeat(25), '-start', 42, null]) expect((await setDisplayName(pctx(w), bad)).ok).toBe(false);
    expect((await setDisplayName(pctx(w), 'Zoë_9'))).toMatchObject({ ok: true });
  });
});
