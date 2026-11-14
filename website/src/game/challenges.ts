/**
 * Automatic daily and weekly challenges. Nobody has to write them: each window the server builds a short trail for a city from facts
 * the game itself knows (distances between cities, the time a simulated flight takes, which landmark lies furthest north, a coded city
 * name). The same city and window always give the same trail, so every player sees the same challenge. They pay XP only, never a prize.
 *
 * Every answer is something the game can work out for itself and a player can find out in the game or by thinking, so none of them
 * rests on a fact that might be wrong.
 */
import type { City } from './cities.js';
import { distanceKm, flightDurationMs } from './travel.js';

export type ClueType = 'riddle' | 'historical' | 'geographical' | 'architectural' | 'numerical' | 'cryptographic' | 'visual' | 'pattern' | 'observation' | 'trail' | 'mystery';

export interface GeneratedClue {
  type: ClueType;
  content: string;
  answer: string;
  hints: string[];
}

/** A small seeded random number generator, so a city and a window always give the same challenge. */
export function seeded(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(rand: () => number, list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
const shuffle = <T,>(rand: () => number, list: readonly T[]): T[] => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

/** Seconds a flight shows as on the map (the Flights list rounds up). */
export const flightSeconds = (a: City, b: City): number => Math.ceil(flightDurationMs(distanceKm(a.center, b.center)) / 1000);

type Maker = (city: City, others: readonly City[], rand: () => number) => GeneratedClue | null;

const furthest: Maker = (city, others) => {
  if (others.length < 3) return null;
  const ranked = [...others].sort((x, y) => distanceKm(city.center, y.center) - distanceKm(city.center, x.center));
  if (distanceKm(city.center, ranked[0]!.center) - distanceKm(city.center, ranked[1]!.center) < 50) return null; // too close to call
  const a = ranked[0]!;
  const km = distanceKm(city.center, a.center);
  return { type: 'geographical', content: `Of the other cities in the game, which one is furthest from ${city.name} as the crow flies?`, answer: a.name, hints: [`It is more than ${Math.floor(km / 1000) * 1000} km away.`, `Its name starts with ${a.name.charAt(0)}.`, `It is in ${a.country}.`] };
};

const nearest: Maker = (city, others) => {
  if (others.length < 3) return null;
  const ranked = [...others].sort((x, y) => distanceKm(city.center, x.center) - distanceKm(city.center, y.center));
  if (distanceKm(city.center, ranked[1]!.center) - distanceKm(city.center, ranked[0]!.center) < 50) return null;
  const a = ranked[0]!;
  const km = distanceKm(city.center, a.center);
  return { type: 'geographical', content: `Of the other cities in the game, which one is nearest to ${city.name} as the crow flies?`, answer: a.name, hints: [`It is less than ${Math.ceil(km / 500) * 500} km away.`, `Its name starts with ${a.name.charAt(0)}.`, `It is in ${a.country}.`] };
};

const flightTime: Maker = (city, others, rand) => {
  if (others.length === 0) return null;
  const to = pick(rand, others);
  const s = flightSeconds(city, to);
  return { type: 'numerical', content: `How many seconds does the simulated flight from ${city.name} to ${to.name} take? The Flights list under the map shows it.`, answer: String(s), hints: ['Open the map, and look at the Flights list.', `It is between ${Math.floor(s / 10) * 10} and ${Math.floor(s / 10) * 10 + 10}.`] };
};

const northmost: Maker = (city, _others, rand) => {
  if (city.landmarks.length < 3) return null;
  const three = shuffle(rand, city.landmarks).slice(0, 3);
  const sorted = [...three].sort((a, b) => b.lat - a.lat);
  if (sorted[0]!.lat - sorted[1]!.lat < 0.003) return null;
  const a = sorted[0]!;
  return { type: 'observation', content: `Three places in ${city.name} appear on its map: ${three.map((m) => m.name).join(', ')}. Which of them lies furthest north?`, answer: a.name, hints: ['Find the three markers on the map. North is up.', `Its name starts with ${a.name.charAt(0)}.`] };
};

function caesar(text: string, shift: number): string {
  return text.replace(/[A-Za-z]/g, (ch) => {
    const base = ch <= 'Z' ? 65 : 97;
    return String.fromCharCode(((ch.charCodeAt(0) - base + shift) % 26) + base);
  });
}

const coded: Maker = (city, _others, rand) => {
  const shift = 1 + Math.floor(rand() * 12);
  const name = city.name.replace(/[^A-Za-z ]/g, '');
  if (name.length < 4) return null;
  return { type: 'cryptographic', content: `A message arrived in code: "${caesar(name.toUpperCase(), shift)}". Each letter was moved ${shift} place${shift === 1 ? '' : 's'} along the alphabet. Which city is it?`, answer: city.name, hints: ['Move each letter back the same number of places.', `The country is ${city.country}.`] };
};

const scrambled: Maker = (city, _others, rand) => {
  const letters = city.name.replace(/[^A-Za-z]/g, '').toUpperCase().split('');
  if (letters.length < 5) return null;
  let mixed = shuffle(rand, letters).join('');
  for (let i = 0; i < 5 && mixed === letters.join(''); i++) mixed = shuffle(rand, letters).join('');
  if (mixed === letters.join('')) return null;
  return { type: 'pattern', content: `These letters make the name of a city in the game: ${mixed}. Which one?`, answer: city.name, hints: [`It starts with ${city.name.charAt(0)}.`, `It is in ${city.country}.`] };
};

const flightDistance: Maker = (city, others, rand) => {
  if (others.length === 0) return null;
  for (let tries = 0; tries < 6; tries++) {
    const to = pick(rand, others);
    const thousands = distanceKm(city.center, to.center) / 1000;
    if (Math.abs(thousands - Math.floor(thousands) - 0.5) < 0.12) continue; // too close to a rounding boundary to be fair
    return { type: 'numerical', content: `To the nearest thousand kilometres, how far is it in a straight line from ${city.name} to ${to.name}?`, answer: String(Math.round(thousands)), hints: ['The Flights list under the map shows the distance.', `It is between ${Math.max(0, Math.round(thousands) - 1)} and ${Math.round(thousands) + 1} thousand km.`] };
  }
  return null;
};

const MAKERS: readonly Maker[] = [furthest, nearest, flightTime, northmost, coded, scrambled, flightDistance];

/** The steps of a challenge for a city in a window (e.g. "daily:2026-11-18"), or fewer if the catalogue cannot support that many. */
export function generateChallenge(city: City, all: readonly City[], windowKey: string, steps: number): GeneratedClue[] {
  const others = all.filter((c) => c.id !== city.id && c.status === 'active');
  const rand = seeded(`${city.id}|${windowKey}`);
  const out: GeneratedClue[] = [];
  for (const maker of shuffle(rand, MAKERS)) {
    if (out.length >= steps) break;
    const clue = maker(city, others, rand);
    if (clue) out.push(clue);
  }
  return out;
}

/** The day or week a challenge belongs to, used to make its id and keep one per window. */
export function windowKey(kind: 'daily' | 'weekly', start: number): string {
  const d = new Date(start);
  const day = d.toISOString().slice(0, 10);
  return kind === 'daily' ? `d-${day}` : `w-${day}`;
}
