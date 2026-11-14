import { createHmac } from 'node:crypto';
import { normalizeAnswer } from '../src/game/rarity.js';

/** The stored form of an answer: a keyed hash of the clue and the normalised answer. Operators make these with scripts/game-answers.ts. */
export function answerHash(secret: string, clueId: string, answer: string): string {
  return createHmac('sha256', secret).update(`${clueId}:${normalizeAnswer(answer)}`).digest('hex');
}
