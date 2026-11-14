/**
 * Builds the automatic daily and weekly challenges when a city's missions are first asked for in a new day or week. One mission per
 * city and window is guaranteed by a unique key in the database, so two requests at once make only one. They pay XP and no prize.
 */
import { allCities, type City } from '../src/game/cities.js';
import { generateChallenge, windowKey } from '../src/game/challenges.js';
import { periodEnd, periodStart } from '../src/game/periods.js';
import { answerHash } from './_gameAnswers.js';
import type { Rest } from './_swingsAccount.js';

const KINDS = {
  daily: { period: 'day', steps: 3, xp: 40, difficulty: 'beginner', title: 'Daily challenge', blurb: 'A fresh set every day, made from facts of the game itself. It pays XP, and no prize.' },
  weekly: { period: 'week', steps: 5, xp: 150, difficulty: 'intermediate', title: 'Weekly hunt', blurb: 'A longer trail that changes every Monday. It pays XP, and no prize.' },
} as const;

export const challengeId = (kind: 'daily' | 'weekly', cityId: string, key: string): string => `auto-${kind}-${cityId}-${key.slice(2)}`;

export async function ensureChallenges(db: Rest, city: City, now: number, secret: string): Promise<void> {
  if (city.status !== 'active') return;
  for (const kind of ['daily', 'weekly'] as const) {
    const k = KINDS[kind];
    const start = periodStart(k.period, now);
    const end = periodEnd(k.period, now)!;
    const key = windowKey(kind, start);
    const id = challengeId(kind, city.id, key);
    const have = (await db.call(`game_missions?id=eq.${id}&select=id&limit=1`)) as unknown[] | null;
    const steps = generateChallenge(city, allCities(), key, k.steps);
    if (steps.length < 2) continue; // the catalogue is too small to make a fair trail
    if (!have?.length) {
      await db.call('game_missions', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ id, city_id: city.id, title: `${k.title}: ${city.name}`, description: k.blurb, difficulty: k.difficulty, kind, status: 'active', opens_at: start, closes_at: end, xp_reward: k.xp, template_id: `auto-${kind}`, window_key: key }) });
    }
    const clues = (await db.call(`game_clues?mission_id=eq.${id}&select=seq&limit=1`)) as unknown[] | null;
    if (clues?.length) continue;
    const rows = steps.map((s, i) => {
      const clueId = crypto.randomUUID();
      return { id: clueId, mission_id: id, seq: i + 1, clue_type: s.type, content: s.content, answer_hash: answerHash(secret, clueId, s.answer), hints: s.hints };
    });
    // The (mission, step) key makes a second writer's rows a no-op, and both would have written identical content.
    await db.call('game_clues', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(rows) });
  }
}
