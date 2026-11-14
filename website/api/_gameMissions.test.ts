import { describe, expect, it } from 'vitest';
import { answerHash, missionOp, type MissionCtx } from './_gameMissions.js';
import { canPlace, DIAMOND_HEADLINE_TOTAL_USD, missionXp, normalizeAnswer, pickClass, TREASURE_CLASSES, treasureXp } from '../src/game/rarity.js';
import { CITIES } from '../src/game/cities.js';

type Row = Record<string, unknown>;
const NOW = 1_800_000_000_000;
const SECRET = 'test-answer-secret';
const P1 = '00000000-0000-4000-8000-000000000001';
const P2 = '00000000-0000-4000-8000-000000000002';
const T1 = '11111111-1111-4111-8111-111111111111';
const C1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const C2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const UNIQUE: Record<string, string[]> = { game_player_missions: ['player_id', 'mission_id'], game_player_treasures: ['player_id', 'treasure_id'] };

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
      const keys = UNIQUE[table!];
      if (keys && rows.some((r) => keys.every((k) => r[k] === body[k]))) return new Response('', { status: prefer.includes('ignore-duplicates') ? 201 : 409 });
      rows.push({ stage: 1, hints_used: 0, hints_total: 0, status: 'active', discovery_status: 'unlocked', verification_status: 'none', claim_status: 'none', ...body });
      return new Response('', { status: 201 });
    }
    const hit = rows.filter((r) => match(r, params));
    if (method === 'PATCH') {
      for (const r of hit) Object.assign(r, body);
      return new Response(prefer.includes('representation') ? JSON.stringify(hit) : '');
    }
    return new Response(JSON.stringify(hit));
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
    expect(w.t.xp!.at(-1)).toEqual({ p_player: P1, p_city: 'paris', p_xp: 25, p_discoveries: 1, p_missions: 0 });
    expect((await missionOp('collect', w.ctx(P1, { treasure: T1 })))!.status).toBe(409);
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
