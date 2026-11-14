/**
 * Loads the city catalogue from the database into the shared list the game rules look cities up in. Each isolate keeps what it loaded
 * for half a minute, so a request normally costs no extra query; an administrator's change drops the copy at once.
 */
import { parseCity, setCatalogue, type City } from '../src/game/cities.js';
import type { Rest } from './_swingsAccount.js';

const TTL_MS = 30_000;
const loadedAt = new WeakMap<object, number>();

export async function loadCatalogue(db: Rest, now: number): Promise<void> {
  const at = loadedAt.get(db);
  if (at !== undefined && now - at < TTL_MS && now >= at) return;
  const rows = ((await db.call('game_cities?select=*&order=sort_order.asc')) as Record<string, unknown>[] | null) ?? [];
  const cities = rows.map((r) => parseCity(r)).filter((c): c is City => c !== null);
  setCatalogue(cities);
  loadedAt.set(db, now);
}

/** Makes the next request read the catalogue again. */
export function dropCatalogue(db: Rest): void {
  loadedAt.delete(db);
}

/** What a visitor is told about a city: its public description, never anything about treasures. */
export function publicCity(c: City): Record<string, unknown> {
  return { id: c.id, name: c.name, country: c.country, center: c.center, bounds: c.bounds, blurb: c.blurb, transport: c.transport, tint: c.tint, status: c.status, imageUrl: c.imageUrl, imageCredit: c.imageCredit, landmarks: c.landmarks, scene: c.scene };
}
