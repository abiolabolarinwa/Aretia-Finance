/**
 * How movement works in Ultimate City Search. Journeys are simulated: nobody has to be anywhere. The server works out how long a
 * journey takes from these rules and refuses a new one until the last has finished, so the clock cannot be skipped from the page.
 * Every player gets the same speeds: transport gives choice, not an advantage that can be bought.
 */
import { cityById, type City, type Transport } from './cities.js';

/** Real-world speed of each way of travelling, in km per hour. */
export const SPEED_KMH: Record<Transport, number> = { walk: 5, run: 10, taxi: 40, car: 50, bus: 25, train: 60, metro: 45, ferry: 30, flight: 850 };

/** Game time runs faster than real time so a journey is seconds, not hours. */
export const LOCAL_SPEEDUP = 120;
export const FLIGHT_SPEEDUP = 1200;
const MIN_MS = 2_000;
const MAX_LOCAL_MS = 120_000;
const MAX_FLIGHT_MS = 90_000;
/** Boarding and landing, added to every flight. */
const FLIGHT_FIXED_MS = 8_000;

export type LngLat = [number, number];

export function distanceKm(a: LngLat, b: LngLat): number {
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function inBounds(city: City, p: LngLat): boolean {
  const [w, s, e, n] = city.bounds;
  return Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] >= w && p[0] <= e && p[1] >= s && p[1] <= n;
}

/** Milliseconds a trip across the city takes. */
export function localDurationMs(km: number, mode: Transport): number {
  return Math.round(Math.min(MAX_LOCAL_MS, Math.max(MIN_MS, ((km / SPEED_KMH[mode]) * 3_600_000) / LOCAL_SPEEDUP)));
}

/** Milliseconds a flight between two cities takes, and the real-world hours it stands for. */
export function flightDurationMs(km: number): number {
  return Math.round(Math.min(MAX_FLIGHT_MS, FLIGHT_FIXED_MS + ((km / SPEED_KMH.flight) * 3_600_000) / FLIGHT_SPEEDUP));
}

export function flightKm(fromCity: string, toCity: string): number | null {
  const a = cityById(fromCity);
  const b = cityById(toCity);
  return a && b ? distanceKm(a.center, b.center) : null;
}

export const LOCAL_MODES: readonly Transport[] = ['walk', 'run', 'taxi', 'car', 'bus', 'train', 'metro', 'ferry'];

export function isLocalMode(v: unknown): v is Transport {
  return typeof v === 'string' && (LOCAL_MODES as readonly string[]).includes(v);
}

/** Where a straight journey has got to after `elapsed` ms of `total` (for drawing; the server only records the end). */
export function along(from: LngLat, to: LngLat, elapsed: number, total: number): LngLat {
  const t = total <= 0 ? 1 : Math.min(1, Math.max(0, elapsed / total));
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
}
