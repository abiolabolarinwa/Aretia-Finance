/**
 * Operator tool for Ultimate City Search answers. Answers are stored only as keyed hashes, so a clue's answer is never in the
 * database in the clear, and this is how a hash is made.
 *
 *   GAME_ANSWER_SECRET=... node scripts/game-answers.ts hash <clue-uuid> "the answer"
 *   GAME_ANSWER_SECRET=... node scripts/game-answers.ts tutorial-sql > tutorial.sql
 *   wrangler d1 execute aretia-game --remote --file=tutorial.sql
 *
 * The secret must be the same value the Cloudflare function has as GAME_ANSWER_SECRET. It is read from the environment only and never
 * printed. `tutorial-sql` writes the SQL for one beginner mission in Paris that pays XP and no prize, so the clue engine can be tried
 * end to end. Real missions and prizes are made in the admin console, never in the repository.
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

const q = (v: string): string => `'${v.replace(/'/g, "''")}'`;

/** SQL for the Paris warm-up mission, to run against the game's D1 database. Its answers are hashed with the server's secret. */
export function tutorialSql(secret: string, ids: [string, string] = [randomUUID(), randomUUID()]): string {
  const id = 'paris-first-steps';
  const steps = [
    { seq: 1, type: 'numerical', content: 'Paris is wound like a snail shell, from the centre outwards. How many numbered districts, its arrondissements, does the city have?', answer: '20', hints: ['Think of a spiral, starting at the Louvre.', 'It is more than fifteen and fewer than twenty-five.'] },
    { seq: 2, type: 'geographical', content: 'I split the city into a Right Bank and a Left Bank, and I carry the Bateaux-Mouches past Notre-Dame. What river am I?', answer: 'Seine', hints: ['It also runs through Rouen on its way to the sea.'] },
  ];
  const out = [
    `insert or replace into game_missions (id, city_id, title, description, difficulty, kind, status, xp_reward) values (${q(id)}, 'paris', 'First steps in Paris', 'A warm-up: two questions about the city. It pays XP, and no prize.', 'beginner', 'long', 'active', 100);`,
    `delete from game_clues where mission_id = ${q(id)};`,
  ];
  for (const [i, st] of steps.entries()) {
    out.push(`insert into game_clues (id, mission_id, seq, clue_type, content, answer_hash, hints) values (${q(ids[i]!)}, ${q(id)}, ${st.seq}, ${q(st.type)}, ${q(st.content)}, ${q(hashAnswer(secret, ids[i]!, st.answer))}, ${q(JSON.stringify(st.hints))});`);
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  const secret = process.env.GAME_ANSWER_SECRET?.trim();
  if (!secret) throw new Error('GAME_ANSWER_SECRET is not set.');
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'hash' && a && b) console.log(hashAnswer(secret, a, b));
  else if (cmd === 'tutorial-sql') console.log(tutorialSql(secret));
  else throw new Error('Usage: hash <clue-uuid> "answer" | tutorial-sql');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
