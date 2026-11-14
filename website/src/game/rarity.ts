/**
 * The eight treasure classes and the rules for placing them. The USD figures are game prize denominations: they are not market
 * prices and not a promise that a collectible can be redeemed for cash. Weights are the defaults; the database copy
 * (game_treasure_classes) is what the server uses, so an operator can tune them without a release.
 */
export interface TreasureClass {
  id: string;
  coin: string;
  usd: number;
  /** 1 is the rarest. */
  rank: number;
  weight: number;
}

export const TREASURE_CLASSES: readonly TreasureClass[] = [
  { id: 'diamond', coin: 'Diamond Coin', usd: 1000, rank: 1, weight: 1 },
  { id: 'golden', coin: 'Golden Coin', usd: 587, rank: 2, weight: 2 },
  { id: 'lithium', coin: 'Lithium Coin', usd: 212, rank: 3, weight: 5 },
  { id: 'silver', coin: 'Silver Coin', usd: 65, rank: 4, weight: 10 },
  { id: 'cerium', coin: 'Cerium Coin', usd: 37, rank: 5, weight: 20 },
  { id: 'samarium', coin: 'Samarium Coin', usd: 1, rank: 6, weight: 50 },
  { id: 'thulium', coin: 'Thulium Coin', usd: 0.1, rank: 7, weight: 200 },
  { id: 'lutetium', coin: 'Lutetium Coin', usd: 0.0027, rank: 8, weight: 700 },
];

export const DIFFICULTIES = ['beginner', 'intermediate', 'advanced', 'expert', 'legendary'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** The headline value of the nine Diamond Treasures, one per city. */
export const DIAMOND_HEADLINE_TOTAL_USD = 9_000;

/** The class a draw lands on, for a number `r` in [0, 1) and the classes' weights. Rarer classes have smaller weights. */
export function pickClass(classes: readonly { id: string; weight: number }[], r: number): string {
  const total = classes.reduce((n, c) => n + Math.max(0, c.weight), 0);
  if (total <= 0) throw new Error('No treasure class has any weight.');
  let at = Math.min(Math.max(r, 0), 0.999999999) * total;
  for (const c of classes) {
    at -= Math.max(0, c.weight);
    if (at < 0) return c.id;
  }
  return classes[classes.length - 1]!.id;
}

export interface PlacedTreasure {
  cityId: string;
  classId: string;
  status: string;
}

/**
 * Whether one more treasure of a class may be placed in a city: at most one live Diamond Treasure per city (the database enforces
 * the same with a unique index), and an optional cap on how many of a class may exist in all (a season's supply).
 */
export function canPlace(existing: readonly PlacedTreasure[], cityId: string, classId: string, caps: Record<string, number> = {}): { ok: true } | { ok: false; reason: string } {
  if (!TREASURE_CLASSES.some((c) => c.id === classId)) return { ok: false, reason: 'Unknown treasure class.' };
  const live = existing.filter((t) => t.status !== 'withdrawn');
  if (classId === 'diamond' && live.some((t) => t.cityId === cityId && t.classId === 'diamond')) return { ok: false, reason: 'This city already has its Diamond Treasure.' };
  const cap = caps[classId];
  if (cap !== undefined && live.filter((t) => t.classId === classId).length >= cap) return { ok: false, reason: 'The supply of this class is used up.' };
  return { ok: true };
}

/** XP for finishing a mission: the reward, less 10% for each hint used (never below half). */
export function missionXp(reward: number, hintsTotal: number): number {
  return Math.round(reward * Math.max(0.5, 1 - 0.1 * Math.max(0, hintsTotal)));
}

/** XP for collecting a treasure: 25 for the commonest class, doubling with each step of rarity (3,200 for a Diamond Coin). */
export function treasureXp(rank: number): number {
  return 25 * 2 ** (8 - Math.min(8, Math.max(1, rank)));
}

/** Makes an answer comparable: case, accents, spacing and punctuation do not matter. */
export function normalizeAnswer(answer: string): string {
  return answer
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
