/**
 * Operator tool for Ultimate City Search answers. Answers are stored only as keyed hashes, so a clue's answer is never in the
 * database in the clear, and this is how a hash is made.
 *
 *   GAME_ANSWER_SECRET=... node scripts/game-answers.ts hash <clue-uuid> "the answer"
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GAME_ANSWER_SECRET=... node scripts/game-answers.ts seed-tutorial
 *
 * The secret must be the same value the server has (GAME_ANSWER_SECRET; if the server has none it uses its session key). It is read
 * from the environment only and never printed. `seed-tutorial` adds one beginner mission in Paris that pays XP and no prize, so the
 * clue engine can be tried end to end. Real missions and prizes are made in the admin console, never in the repository.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** Same rule as src/game/rarity.ts normalizeAnswer (a test keeps the two equal). */
export function normalize(answer: string): string {
  return answer
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function hashAnswer(secret: string, clueId: string, answer: string): string {
  return createHmac('sha256', secret).update(`${clueId}:${normalize(answer)}`).digest('hex');
}

async function seedTutorial(secret: string): Promise<void> {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed.');
  const call = async (path: string, init: RequestInit): Promise<void> => {
    const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' } });
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  };
  const id = 'paris-first-steps';
  await call('game_missions?on_conflict=id', { method: 'POST', body: JSON.stringify({ id, city_id: 'paris', title: 'First steps in Paris', description: 'A warm-up: two questions about the city. It pays XP, and no prize.', difficulty: 'beginner', kind: 'long', status: 'active', xp_reward: 100 }) });
  await call(`game_clues?mission_id=eq.${id}`, { method: 'DELETE' });
  const steps = [
    { seq: 1, clue_type: 'numerical', content: 'Paris is wound like a snail shell, from the centre outwards. How many numbered districts, its arrondissements, does the city have?', answer: '20', hints: ['Think of a spiral, starting at the Louvre.', 'It is more than fifteen and fewer than twenty-five.'] },
    { seq: 2, clue_type: 'geographical', content: 'I split the city into a Right Bank and a Left Bank, and I carry the Bateaux-Mouches past Notre-Dame. What river am I?', answer: 'Seine', hints: ['It also runs through Rouen on its way to the sea.'] },
  ];
  await call('game_clues', { method: 'POST', body: JSON.stringify(steps.map((s) => { const cid = randomUUID(); return { id: cid, mission_id: id, seq: s.seq, clue_type: s.clue_type, content: s.content, answer_hash: hashAnswer(secret, cid, s.answer), hints: s.hints }; })) });
  console.log('Seeded the tutorial mission.');
}

async function main(): Promise<void> {
  const secret = process.env.GAME_ANSWER_SECRET?.trim() || process.env.SWINGS_SESSION_SECRET?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!secret) throw new Error('GAME_ANSWER_SECRET is not set.');
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'hash' && a && b) console.log(hashAnswer(secret, a, b));
  else if (cmd === 'seed-tutorial') await seedTutorial(secret);
  else throw new Error('Usage: hash <clue-uuid> "answer" | seed-tutorial');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
