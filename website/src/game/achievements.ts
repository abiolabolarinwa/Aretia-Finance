/**
 * Achievements. Each is earned from counts the server keeps, never from anything the page reports. The server checks the whole list
 * after the actions that can change a count, and unlocks (and pays the XP for) each one once.
 */
export interface Snapshot {
  citiesVisited: number;
  missionsCompleted: number;
  discoveries: number;
  flightsLanded: number;
  hintFreeCompletions: number;
  explorerLevel: number;
  teamHunts: number;
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  xp: number;
  earned(s: Snapshot): boolean;
}

export const ACHIEVEMENTS: readonly Achievement[] = [
  { id: 'first-steps', title: 'First steps', description: 'Enter your first city.', xp: 25, earned: (s) => s.citiesVisited >= 1 },
  { id: 'globetrotter', title: 'Globetrotter', description: 'Visit three different cities.', xp: 50, earned: (s) => s.citiesVisited >= 3 },
  { id: 'world-explorer', title: 'World explorer', description: 'Visit all nine cities.', xp: 250, earned: (s) => s.citiesVisited >= 9 },
  { id: 'frequent-flyer', title: 'Frequent flyer', description: 'Land from your first flight.', xp: 25, earned: (s) => s.flightsLanded >= 1 },
  { id: 'jet-setter', title: 'Jet-setter', description: 'Complete five flights.', xp: 100, earned: (s) => s.flightsLanded >= 5 },
  { id: 'first-mission', title: 'Case opened', description: 'Complete your first mission.', xp: 50, earned: (s) => s.missionsCompleted >= 1 },
  { id: 'seasoned-sleuth', title: 'Seasoned sleuth', description: 'Complete ten missions.', xp: 200, earned: (s) => s.missionsCompleted >= 10 },
  { id: 'master-detective', title: 'Master detective', description: 'Complete fifty missions.', xp: 1000, earned: (s) => s.missionsCompleted >= 50 },
  { id: 'sharp-mind', title: 'Sharp mind', description: 'Complete a mission without using a hint.', xp: 50, earned: (s) => s.hintFreeCompletions >= 1 },
  { id: 'team-player', title: 'Team player', description: 'Finish a team hunt with your team.', xp: 100, earned: (s) => s.teamHunts >= 1 },
  { id: 'first-find', title: 'First find', description: 'Collect your first treasure.', xp: 100, earned: (s) => s.discoveries >= 1 },
  { id: 'treasure-hunter', title: 'Treasure hunter', description: 'Collect ten treasures.', xp: 500, earned: (s) => s.discoveries >= 10 },
  { id: 'level-5', title: 'Rising explorer', description: 'Reach explorer level 5.', xp: 100, earned: (s) => s.explorerLevel >= 5 },
  { id: 'level-10', title: 'Veteran explorer', description: 'Reach explorer level 10.', xp: 300, earned: (s) => s.explorerLevel >= 10 },
];

/** The ones this snapshot has earned and the player does not have yet. */
export function newlyEarned(s: Snapshot, have: ReadonlySet<string>): Achievement[] {
  return ACHIEVEMENTS.filter((a) => !have.has(a.id) && a.earned(s));
}

/** Explorer level for an amount of XP; the same rule as the database function that awards XP. */
export function levelFor(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1;
}

/** XP needed to reach the next level from this amount. */
export function xpToNext(xp: number): number {
  const next = levelFor(xp);
  return next * next * 100 - Math.max(0, xp);
}
