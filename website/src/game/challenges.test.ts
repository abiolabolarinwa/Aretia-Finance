import { describe, expect, it } from 'vitest';
import { CITIES } from './cities.js';
import { flightSeconds, generateChallenge, seeded, windowKey } from './challenges.js';
import { distanceKm } from './travel.js';
import { normalizeAnswer } from './rarity.js';

const city = (id: string) => CITIES.find((c) => c.id === id)!;

describe('automatic challenges', () => {
  it('give the same trail for the same city and window, and a different one for another day', () => {
    const a = generateChallenge(city('paris'), CITIES, 'd-2026-11-18', 3);
    const b = generateChallenge(city('paris'), CITIES, 'd-2026-11-18', 3);
    const c = generateChallenge(city('paris'), CITIES, 'd-2026-11-19', 3);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('can be built for every launch city: three steps a day, five a week, no step repeated', () => {
    for (const c of CITIES) {
      for (const [steps, key] of [[3, 'd-2026-11-18'], [5, 'w-2026-11-16']] as const) {
        const out = generateChallenge(c, CITIES, key, steps);
        expect(out, `${c.id} ${key}`).toHaveLength(steps);
        expect(new Set(out.map((x) => x.content)).size).toBe(steps);
        for (const s of out) {
          expect(s.answer.length).toBeGreaterThan(0);
          expect(s.hints.length).toBeGreaterThan(0);
          // A hint never simply gives the answer away.
          for (const h of s.hints) expect(normalizeAnswer(h)).not.toBe(normalizeAnswer(s.answer));
        }
      }
    }
  });

  it('has answers that are true: distances, flight times, compass order and codes are worked out from the game itself', () => {
    const seen = new Set<string>();
    for (let day = 1; day <= 40; day++) {
      for (const c of CITIES) {
        for (const s of generateChallenge(c, CITIES, `d-2026-12-${String(day).padStart(2, '0')}`, 5)) {
          const others = CITIES.filter((x) => x.id !== c.id);
          const byDistance = [...others].sort((x, y) => distanceKm(c.center, x.center) - distanceKm(c.center, y.center));
          if (s.content.includes('furthest from')) {
            seen.add('furthest');
            expect(s.answer).toBe(byDistance[byDistance.length - 1]!.name);
          } else if (s.content.includes('nearest to')) {
            seen.add('nearest');
            expect(s.answer).toBe(byDistance[0]!.name);
          } else if (s.content.startsWith('How many seconds')) {
            seen.add('seconds');
            const to = others.find((o) => s.content.includes(`to ${o.name} take`))!;
            expect(s.answer).toBe(String(flightSeconds(c, to)));
          } else if (s.content.startsWith('To the nearest thousand')) {
            seen.add('thousands');
            const to = others.find((o) => s.content.includes(`to ${o.name}?`))!;
            expect(Number(s.answer)).toBe(Math.round(distanceKm(c.center, to.center) / 1000));
          } else if (s.content.includes('lies furthest north')) {
            seen.add('north');
            const names = c.landmarks.filter((m) => s.content.includes(m.name));
            expect(names.length).toBe(3);
            expect(s.answer).toBe([...names].sort((a, b) => b.lat - a.lat)[0]!.name);
          } else if (s.content.includes('in code')) {
            seen.add('code');
            const shift = Number(/moved (\d+) place/.exec(s.content)![1]);
            const coded = /"([A-Z ]+)"/.exec(s.content)![1]!;
            const decoded = coded.replace(/[A-Z]/g, (ch) => String.fromCharCode(((ch.charCodeAt(0) - 65 - shift + 26) % 26) + 65));
            expect(decoded).toBe(c.name.toUpperCase());
          } else if (s.content.includes('make the name of a city')) {
            seen.add('letters');
            const letters = /: ([A-Z]+)\./.exec(s.content)![1]!;
            expect(letters.split('').sort().join('')).toBe(c.name.replace(/[^A-Za-z]/g, '').toUpperCase().split('').sort().join(''));
            expect(s.answer).toBe(c.name);
          } else throw new Error('unrecognised challenge: ' + s.content);
        }
      }
    }
    expect([...seen].sort()).toEqual(['code', 'furthest', 'letters', 'nearest', 'north', 'seconds', 'thousands']);
  });

  it('makes fewer steps, or none, when the catalogue cannot support a fair trail', () => {
    expect(generateChallenge(city('paris'), [city('paris')], 'd-2026-11-18', 3).length).toBeLessThan(3);
    const bare = { ...city('paris'), landmarks: [] };
    expect(generateChallenge(bare, [bare, city('london')], 'd-2026-11-18', 5).every((s) => !s.content.includes('furthest north'))).toBe(true);
  });

  it('makes a repeatable random stream and a window key per day or week', () => {
    const r1 = seeded('x');
    const r2 = seeded('x');
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
    expect(seeded('x')()).not.toBe(seeded('y')());
    expect(windowKey('daily', Date.UTC(2026, 10, 18))).toBe('d-2026-11-18');
    expect(windowKey('weekly', Date.UTC(2026, 10, 16))).toBe('w-2026-11-16');
  });
});
